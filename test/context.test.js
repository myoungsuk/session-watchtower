'use strict';
// 지금 대화 크기(마지막 응답의 토큰)와 자동 압축 기준 읽기 시험
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/fixture');

const { home, project } = fx.makeHome();
const S = require('../scanner.js'); // 홈 폴더를 정한 뒤에 불러야 한다

const dir = path.join(home, 'ctx');
fs.mkdirSync(dir, { recursive: true });
const write = (name, recs) => { const f = path.join(dir, name); fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); return f; };
const asst = (u, extra) => ({ type: 'assistant', isSidechain: false, message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: u }, timestamp: '2026-11-26T01:00:00.000Z', ...extra });

test('Claude: 마지막 응답의 네 값(새 입력·캐시 쓰기·캐시 읽기·출력)을 더한다', () => {
  const f = write('a.jsonl', [
    asst({ input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 }),
    asst({ input_tokens: 2, cache_creation_input_tokens: 300, cache_read_input_tokens: 200000, output_tokens: 50 }),
    { type: 'user', message: { role: 'user', content: 'next' } },
  ]);
  assert.strictEqual(S.lastContext(f, 'claude').used, 200352);
});

test('Claude: 하위 대화·사본 줄·0으로 적힌 응답은 건너뛴다', () => {
  const f = write('b.jsonl', [
    asst({ input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 }),
    asst({ input_tokens: 0, output_tokens: 0 }), // 오류 안내처럼 0으로 적힌 기록
    asst({ input_tokens: 999999, output_tokens: 1 }, { isSidechain: true }),
    { type: 'api-request-blob', message: { usage: { input_tokens: 777777 } } },
  ]);
  assert.strictEqual(S.lastContext(f, 'claude').used, 100);
});

test('Claude: 끝 512KB 안에 없으면 더 넓게 읽어 찾는다', () => {
  const big = { type: 'user', message: { role: 'user', content: 'x'.repeat(700 * 1024) } };
  const f = write('c.jsonl', [asst({ input_tokens: 1, cache_read_input_tokens: 41, output_tokens: 0 }), big]);
  assert.strictEqual(S.lastContext(f, 'claude').used, 42);
});

test('응답 기록이 없으면 null, 파일이 바뀌면 다시 읽는다', () => {
  const f = write('d.jsonl', [{ type: 'user', message: { role: 'user', content: 'only' } }]);
  assert.strictEqual(S.lastContext(f, 'claude'), null);
  fs.appendFileSync(f, JSON.stringify(asst({ input_tokens: 3, output_tokens: 4 })) + '\n');
  assert.strictEqual(S.lastContext(f, 'claude').used, 7);
});

test('Codex: 마지막 token_count의 last_token_usage와 모델 문맥 창', () => {
  const tc = (total, win) => ({ timestamp: '2026-11-26T01:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 999999 }, last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: total }, model_context_window: win } } });
  const f = write('e.jsonl', [tc(1000, 258400), tc(54321, 258400), { type: 'event_msg', payload: { type: 'token_count', info: null } }]);
  assert.deepStrictEqual(S.lastContext(f, 'codex'), { used: 54321, window: 258400, ts: Date.parse('2026-11-26T01:00:00.000Z') });
});

test('Claude: 응답 기록의 모델 이름도 함께 돌려준다', () => {
  const f = write('m.jsonl', [asst({ input_tokens: 1, output_tokens: 1 })]);
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  r.message.model = 'claude-opus-5-5';
  fs.writeFileSync(f, JSON.stringify(r) + '\n');
  assert.strictEqual(S.lastContext(f, 'claude').model, 'claude-opus-5-5');
});

// 공식 문서(model-config "Default auto-compact thresholds")의 기본값: 설정이 하나도 없을 때
test('설정이 없으면 모델에 맞춘 기본값: 1M 창 모델 967k, 그 밖은 200k, 모르는 모델은 200k 가정', () => {
  const w = (m, used) => S.claudeCompactWindow(project, m, used || 1000);
  assert.deepStrictEqual(w('claude-opus-5-5'), { window: 967000, source: 'default', assumed: false });
  assert.strictEqual(w('claude-fable-5-2').window, 967000);
  assert.strictEqual(w('claude-sonnet-5-5').window, 967000);
  assert.strictEqual(w('claude-haiku-5-5').window, 967000);
  assert.strictEqual(w('claude-opus-4-7').window, 967000);
  assert.strictEqual(w('claude-opus-4-6').window, 200000, 'Opus 4.6은 [1m] 없이 200k');
  assert.strictEqual(w('claude-sonnet-4-5-20250929').window, 200000);
  assert.strictEqual(w('claude-haiku-4-5').window, 200000);
  assert.strictEqual(w('claude-sonnet-4-20250514').window, 200000);
  assert.strictEqual(w('claude-opus-4-6', 350000).window, 1000000, '200k를 넘게 썼으면 [1m] 변형으로 본다(추정)');
  assert.deepStrictEqual(w('my-gateway-opus'), { window: 200000, source: 'unknown-model', assumed: true });
});

test('설정 파일 순서: 프로젝트 local → 프로젝트 → 사용자, 한 파일 안에서는 모델별 값이 먼저, 모델 창을 넘지 않는다', () => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const user = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(user, JSON.stringify({ autoCompactWindow: 300000 }));
  assert.deepStrictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1), { window: 300000, source: 'setting', file: user, assumed: false });
  assert.strictEqual(S.claudeCompactWindow(project, 'claude-opus-4-6', 1).window, 200000, '200k 창 모델은 200k에서 자른다');
  fs.writeFileSync(user, JSON.stringify({ autoCompactWindow: 300000, modelSettings: { 'claude-opus-5-5': { effortLevel: 'high', autoCompactWindow: 500000 } } }));
  assert.deepStrictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1), { window: 500000, source: 'model-setting', file: user, assumed: false });
  assert.strictEqual(S.claudeCompactWindow(project, 'claude-fable-5-2', 1).window, 300000, '다른 모델은 맨 위 값');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 250000 }));
  assert.strictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1).window, 250000, '프로젝트가 사용자보다 높다');
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: {} })); // 값 없는 파일은 건너뜀
  assert.strictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1).window, 250000);
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ autoCompactWindow: 400000 }));
  assert.strictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1).window, 400000, 'local이 프로젝트보다 높다');
  assert.strictEqual(S.claudeCompactWindow(null, 'claude-opus-5-5', 1).window, 500000, '작업 폴더를 모르면 사용자 설정만');
});

test('설정 env 블록: CLAUDE_CODE_AUTO_COMPACT_WINDOW가 모든 값보다 앞서고, CLAUDE_CODE_DISABLE_1M_CONTEXT=1이면 200k', () => {
  const local = path.join(project, '.claude', 'settings.local.json');
  fs.writeFileSync(local, JSON.stringify({ autoCompactWindow: 400000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '350k' } }));
  assert.deepStrictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1), { window: 350000, source: 'env', file: local, assumed: false });
  fs.writeFileSync(local, JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' } }));
  assert.strictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1).window, 100000, '100k 미만은 100k');
  fs.writeFileSync(local, JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'lots' } }));
  assert.strictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1).source, 'setting', '못 읽는 값은 무시');
  fs.writeFileSync(local, JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }));
  assert.strictEqual(S.claudeCompactWindow(project, 'claude-opus-5-5', 1).window, 200000, '프로젝트 250k도 200k 창에서 잘린다');
  fs.rmSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }));
  assert.deepStrictEqual(S.claudeCompactWindow(project, 'claude-fable-5-2', 1), { window: 200000, source: 'default', assumed: false });
  fs.rmSync(path.join(home, '.claude', 'settings.json'));
});

test('Codex 자동 압축 지점: config.toml 맨 위 model_auto_compact_token_limit, 없으면 문맥 창(유효 창 ÷ 0.95)의 90%', () => {
  assert.deepStrictEqual(S.codexCompactWindow(258400), { window: 244800, source: 'codex-default' });
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'config.toml');
  fs.writeFileSync(cfg, 'model = "gpt-5"\n[profiles.big]\nmodel_auto_compact_token_limit = 999999\n');
  assert.strictEqual(S.codexCompactWindow(258400).source, 'codex-default', '표 안의 값은 보지 않는다');
  fs.writeFileSync(cfg, 'model = "gpt-5"\nmodel_auto_compact_token_limit = 180_000 # 일찍 압축\n[mcp_servers.x]\ncommand = "y"\n');
  assert.deepStrictEqual(S.codexCompactWindow(258400), { window: 180000, source: 'codex-setting', file: cfg });
  fs.writeFileSync(cfg, 'model_auto_compact_token_limit = 900000\n');
  assert.strictEqual(S.codexCompactWindow(258400).window, 258400, '유효 창을 넘지 않는다');
  fs.rmSync(cfg);
});
