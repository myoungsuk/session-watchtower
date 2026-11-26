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

test('자동 압축 기준: 작업 폴더 local → 작업 폴더 → 사용자 설정, 없으면 200000(추정)', () => {
  assert.deepStrictEqual(S.claudeCompactWindow(project), { window: 200000, assumed: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 300000 }));
  assert.deepStrictEqual(S.claudeCompactWindow(project), { window: 300000, assumed: false });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 250000 }));
  assert.strictEqual(S.claudeCompactWindow(project).window, 250000);
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: {} })); // 값 없는 파일은 건너뜀
  assert.strictEqual(S.claudeCompactWindow(project).window, 250000);
  assert.strictEqual(S.claudeCompactWindow(null).window, 300000);
});
