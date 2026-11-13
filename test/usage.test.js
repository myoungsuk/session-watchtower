'use strict';
// 사용량(요금제 한도) 상태 표시줄 시험: Claude Code가 ~/.claude.json에 받아 둔 값과 마지막 Codex 기록의 한도를 보여 주고,
// 파일이 바뀌지 않으면 다시 읽지 않으며(주기마다 크기·시각만 봄), 초기화 시각이 지난 값·끈 설정은 감춘다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const stub = require('./helpers/vscode-stub').install({
  extDir: path.join(__dirname, '..'), language: 'en', workspace: project,
  config: { attentionMarkerDir: markers, pollSeconds: 2, notifyStuckMinutes: 0, notifyWaiting: false },
});
const now = Date.now();
const H = 3600e3;
const CFG = path.join(home, '.claude.json');
const ACCOUNT = 'acc0unt-uuid-should-not-show';
const writeClaude = (u, fetchedAtMs = now - 10 * 60e3) => {
  fs.writeFileSync(CFG, JSON.stringify({ numStartups: 1, oauthAccount: { emailAddress: 'x@example.invalid' }, cachedUsageUtilization: { fetchedAtMs, accountUuid: ACCOUNT, utilization: u } }, null, 2));
};
const win = (pct, resetMs) => ({ utilization: pct, resets_at: new Date(resetMs).toISOString(), limit_dollars: null });
writeClaude({ five_hour: win(41, now + 2 * H), seven_day: win(83, now + 50 * H), seven_day_opus: null, seven_day_sonnet: null });

// Codex 기록: 앞의 한도(10%)보다 마지막 한도(5시간 23%·7일 61%)를 읽어야 한다
const CX = '01a0e732-7e44-7bf2-9a3a-1cb36590037a';
const iso = (t) => new Date(t).toISOString();
const rl = (p5, p7, t) => ({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5 } }, rate_limits: { primary: { used_percent: p5, window_minutes: 300, resets_at: Math.round((now + 3 * H) / 1000) }, secondary: { used_percent: p7, window_minutes: 10080, resets_at: Math.round((now + 90 * H) / 1000) }, plan_type: 'pro' } } });
fx.codexSession(home, CX, [
  { timestamp: iso(now - 20 * 60e3), type: 'session_meta', payload: { id: CX, cwd: project, originator: 'codex_cli_rs' } },
  { timestamp: iso(now - 19 * 60e3), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the build' }] } },
  rl(5, 10, now - 18 * 60e3),
  rl(23, 61, now - 5 * 60e3),
], now - 5 * 60e3);

const ext = require('../extension.js');
const usage = require('../usage.js');
ext._test.setCodexCli(false);
ext.activate(stub.context);
const item = () => stub.statusItems.find((i) => i.id === 'claudeSessionChanges.usage');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(40); }
  assert.fail('기다렸지만 안 됨: ' + what);
}

test('Claude·Codex 사용량을 가장 많이 쓴 칸 기준으로 보여 주고, 설명에 칸별 값·초기화 시각·기준 시각을 적는다', async () => {
  await waitFor(() => item() && item().visible && /Codex/.test(item().text), '상태 표시줄');
  assert.strictEqual(item().text, '$(dashboard) Claude 83% · Codex 61%');
  const tip = item().tooltip.value;
  assert.match(tip, /\*\*Claude\*\* — saved by Claude Code 10m ago/);
  assert.match(tip, /\| 5 hours \| 41% \| resets /);
  assert.match(tip, /\| 7 days \| 83% \| resets /);
  assert.match(tip, /\*\*Codex\*\* \(pro\) — from the last Codex log 5m ago/);
  assert.match(tip, /\| 5 hours \| 23% \|/);
  assert.match(tip, /\| 7 days \| 61% \|/);
  assert.match(tip, /nothing is fetched from the internet/);
  assert.ok(!tip.includes(ACCOUNT) && !tip.includes('example.invalid'), '계정 ID·메일은 보여 주지 않는다');
  assert.strictEqual(item().backgroundColor, undefined, '90% 아래는 색 없음');
  assert.ok(stub.context.globalState.store['claudeSessionChanges.usageCodexLast'], 'Codex 값은 창을 다시 불러와도 남게 기억');
});

test('파일이 바뀌지 않으면 주기마다 크기·시각만 보고 다시 읽지 않는다', async () => {
  const before = { ...usage.stats };
  await sleep(4500); // 2초 주기 두 번 이상
  assert.deepStrictEqual(usage.stats, before, '설정 파일·Codex 기록을 다시 읽지 않음');
});

test('90%를 넘으면 경고 색, 1시간 넘은 값은 설명에 알리고, 초기화 시각이 지난 칸은 뺀다', async () => {
  writeClaude({ five_hour: win(97, now - 60e3), seven_day: win(92, now + 50 * H) }, now - 2 * H);
  const t = new Date(Date.now() + 3000);
  fs.utimesSync(CFG, t, t);
  await waitFor(() => /Claude 92%/.test(item().text), '새 값 반영');
  assert.strictEqual(item().backgroundColor && item().backgroundColor.id, 'statusBarItem.warningBackground');
  const tip = item().tooltip.value;
  assert.ok(!/\| 5 hours \| 97%/.test(tip), '초기화 시각이 지난 5시간 칸은 옛 값이라 뺀다');
  assert.match(tip, /more than an hour old/);
});

test('설정을 끄면 감추고, Codex를 빼면 Claude만, 보여 줄 값이 없으면 감춘다', async () => {
  stub.changeConfig('includeCodex', false);
  await waitFor(() => item().text === '$(dashboard) Claude 92%', 'Codex 빼기');
  stub.changeConfig('usageStatusBar', false);
  await waitFor(() => item().visible === false, '끄기');
  stub.changeConfig('usageStatusBar', true);
  await waitFor(() => item().visible === true, '다시 켜기');
  writeClaude({ five_hour: null, seven_day: win(50, now - 60e3) });
  const t = new Date(Date.now() + 6000);
  fs.utimesSync(CFG, t, t);
  await waitFor(() => item().visible === false, '모든 칸이 지난 값이면 감춤');
});

test('Codex 기록 끝 읽기: 잘린 첫 줄은 건너뛰고 마지막 한도를 찾는다', () => {
  const f = path.join(home, 'cx-tail.jsonl');
  const filler = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(300 * 1024) } });
  fs.writeFileSync(f, JSON.stringify(rl(1, 2, now - H)) + '\n' + filler + '\n' + JSON.stringify(rl(7, 8, now - 60e3)) + '\n');
  const v = usage.readCodex(f);
  assert.deepStrictEqual(v.windows.map((w) => [w.minutes, w.percent]), [[300, 7], [10080, 8]]);
  assert.strictEqual(usage.readCodex(path.join(home, 'none.jsonl')), null);
});

test.after(() => { ext.deactivate(); });
