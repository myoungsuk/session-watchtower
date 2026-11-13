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
// 요즘 형식: 전체 주간 한도 + 모델별(Fable) 주간 한도, 모델별 몫, 이번 주 제품별 비율. 못 읽는 항목이 섞여도 순번이 어긋나지 않아야 한다
const limit = (kind, pct, resetMs, severity, model) => ({ kind, group: 'weekly', percent: pct, severity, resets_at: new Date(resetMs).toISOString(), scope: model ? { model: { id: null, display_name: model }, surface: null } : null, is_active: !model });
writeClaude({
  five_hour: null, seven_day: win(83, now + 50 * H),
  limits: [limit('weekly_all', 83, now + 50 * H, 'warning'), { kind: 'broken' }, limit('weekly_scoped', 21, now + 50 * H, 'normal', 'Fable')],
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 11, allowance_percent_of_weekly: 50 }],
  seven_day_breakdown: { rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 99 }, { key: 'chat', display_name: 'Chats', percent: 0 }, { key: 'cowork', display_name: 'Cowork', percent: 1 }] },
});

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

test('Claude 전체 한도와 모델별 한도(Fable)를 따로, Codex는 가장 많이 쓴 칸을 오른쪽 상태 표시줄에 보여 준다', async () => {
  await waitFor(() => item() && item().visible && /Codex/.test(item().text), '상태 표시줄');
  assert.strictEqual(item().text, '$(dashboard) Claude 83% · Fable 21% · Codex 61%');
  assert.strictEqual(item().alignment, 2, '오른쪽');
  const tip = item().tooltip.value;
  assert.match(tip, /\*\*Claude\*\* — saved by Claude Code 10m ago/);
  assert.match(tip, /\| 7 days \| 83% \| resets /);
  assert.match(tip, /\| 7 days · Fable \| 21% \| resets /);
  assert.match(tip, /Fable can use up to 50% of the weekly limit; it has used 11% so far\./, '몫은 limits 목록 순번으로 맞춘다');
  assert.match(tip, /This week by product: Claude Code 99% · Cowork 1%/);
  assert.match(tip, /\*\*Codex\*\* \(pro\) — from the last Codex log 5m ago/);
  assert.match(tip, /\| 5 hours \| 23% \|/);
  assert.match(tip, /\| 7 days \| 61% \|/);
  assert.match(tip, /nothing is fetched from the internet/);
  assert.ok(!tip.includes(ACCOUNT) && !tip.includes('example.invalid'), '계정 ID·메일은 보여 주지 않는다');
  assert.strictEqual(item().backgroundColor && item().backgroundColor.id, 'statusBarItem.warningBackground', 'Claude가 경고로 표시한 한도는 노랑(Claude Code와 같은 기준)');
  assert.ok(stub.context.globalState.store['claudeSessionChanges.usageCodexLast'], 'Codex 값은 창을 다시 불러와도 남게 기억');
});

test('파일이 바뀌지 않으면 주기마다 크기·시각만 보고 다시 읽지 않는다', async () => {
  const before = { ...usage.stats };
  await sleep(4500); // 2초 주기 두 번 이상
  assert.deepStrictEqual(usage.stats, before, '설정 파일·Codex 기록을 다시 읽지 않음');
});

test('옛 형식(five_hour·seven_day)도 읽고, 90%를 넘으면 경고 색, 1시간 넘은 값은 설명에 알리고, 초기화 시각이 지난 칸은 뺀다', async () => {
  writeClaude({ five_hour: win(97, now - 60e3), seven_day: win(92, now + 50 * H) }, now - 2 * H);
  const t = new Date(Date.now() + 3000);
  fs.utimesSync(CFG, t, t);
  await waitFor(() => /Claude 92%/.test(item().text), '새 값 반영');
  assert.strictEqual(item().backgroundColor && item().backgroundColor.id, 'statusBarItem.warningBackground');
  const tip = item().tooltip.value;
  assert.ok(!/\| 5 hours \| 97%/.test(tip), '초기화 시각이 지난 5시간 칸은 옛 값이라 뺀다');
  assert.match(tip, /more than an hour old/);
  // 100%면 빨강
  writeClaude({ seven_day: win(100, now + 50 * H) });
  const t2 = new Date(Date.now() + 4500);
  fs.utimesSync(CFG, t2, t2);
  await waitFor(() => /Claude 100%/.test(item().text), '100%');
  assert.strictEqual(item().backgroundColor.id, 'statusBarItem.errorBackground');
});

test('설정을 끄면 감추고, Codex를 빼면 Claude만, 보여 줄 값이 없으면 감춘다', async () => {
  stub.changeConfig('includeCodex', false);
  await waitFor(() => item().text === '$(dashboard) Claude 100%', 'Codex 빼기');
  stub.changeConfig('usageStatusBar', false);
  await waitFor(() => item().visible === false, '끄기');
  stub.changeConfig('usageStatusBar', true);
  await waitFor(() => item().visible === true, '다시 켜기');
  writeClaude({ five_hour: null, seven_day: win(50, now - 60e3) });
  const t = new Date(Date.now() + 9000);
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

test('다시 받기: 값이 오래됐고 그 뒤에 Claude 세션이 일했으면 Claude Code 명령(claude -p /usage)을 한 번 돌려 새 값을 받게 하고, 누르면 바로 받는다', async () => {
  stub.changeConfig('includeCodex', true);
  // 2시간 전에 받아 둔 값 + 그 뒤에 일한 Claude 세션
  writeClaude({ seven_day: win(70, now + 50 * H) }, Date.now() - 2 * H);
  const SIDC = 'c1a0de00-1111-4111-8111-111111111111';
  fx.claudeSession(home, project, SIDC, [{ type: 'user', message: { role: 'user', content: 'hello' }, cwd: project, sessionId: SIDC, timestamp: new Date().toISOString(), uuid: 'u1' }]);
  // 진짜 claude 대신: 받은 인자·폴더·환경을 적고, Claude Code처럼 ~/.claude.json에 새 값을 써 넣는 대역
  const bin = path.join(home, 'fake-claude');
  const log = path.join(home, 'fake-claude.log');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$PWD|$*|entry=\${CLAUDE_CODE_ENTRYPOINT:-none}|cc=\${CLAUDECODE:-none}" >> '${log}'\nnode -e 'const f=process.argv[1];const fs=require("fs");const d=JSON.parse(fs.readFileSync(f,"utf8"));d.cachedUsageUtilization={fetchedAtMs:Date.now(),utilization:{seven_day:{utilization:88,resets_at:new Date(Date.now()+180000000).toISOString()}}};fs.writeFileSync(f,JSON.stringify(d,null,2))' '${CFG}'\n`);
  fs.chmodSync(bin, 0o755);
  ext._test.setClaudeBin(bin);
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
  process.env.CLAUDECODE = '1';
  stub.changeConfig('usageRefreshMinutes', 15);
  stub.commands.get('claudeSessionChanges.refresh')();
  await waitFor(() => /Claude 88%/.test(item().text), '자동으로 다시 받음', 15000);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, '한 번만');
  assert.strictEqual(lines[0], `${project}|-p /usage --no-session-persistence --strict-mcp-config --mcp-config {"mcpServers":{}}|entry=none|cc=none`, '이 폴더에서, MCP 서버 없이, 기록 없이, 이 세션의 표시를 빼고');
  assert.match(item().tooltip.value, /re-check this every 15 minutes/);
  assert.match(item().tooltip.value, /never reads your login/);
  // 값이 새것이면 다시 돌리지 않는다
  await sleep(4500);
  assert.strictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, '새 값이면 다시 받지 않음');
  // 누르면(상태 표시줄 명령) 바로 받는다
  assert.strictEqual(item().command, 'claudeSessionChanges.refreshUsage');
  stub.commands.get('claudeSessionChanges.refreshUsage')();
  await waitFor(() => fs.readFileSync(log, 'utf8').trim().split('\n').length === 2, '눌러서 다시 받음', 10000);
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.CLAUDECODE;
  stub.changeConfig('usageRefreshMinutes', 0);
});

test('세션 숫자도 오른쪽(사용량 바로 왼쪽), SDK로 돌린 짧은 실행(claude -p)은 실행 중인 세션으로 세지 않는다', () => {
  const st = stub.statusItems.find((i) => i.id === 'claudeSessionChanges.status');
  assert.strictEqual(st.alignment, 2);
  assert.ok(st.priority > item().priority, '오른쪽 묶음에서 사용량보다 왼쪽');
  const { readRegistry } = require('../scanner.js');
  const SIDX = 'abcd0000-1111-4111-8111-111111111111';
  fx.registerSession(home, process.pid, SIDX, { status: 'busy', cwd: project, entrypoint: 'sdk-cli', name: 'x', nameSource: 'derived' });
  assert.ok(!readRegistry().has(SIDX), 'claude -p(entrypoint sdk-cli)는 뺀다');
  fx.registerSession(home, process.pid, SIDX, { status: 'busy', cwd: project, entrypoint: 'claude-vscode', name: 'x', nameSource: 'derived' });
  assert.ok(readRegistry().has(SIDX), '보통 세션은 센다');
  fs.unlinkSync(path.join(home, '.claude', 'sessions', process.pid + '.json'));
});

test.after(() => { ext.deactivate(); });
