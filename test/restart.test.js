'use strict';
// 컴퓨터를 새로 켠 직후(실행 중인 세션이 하나도 없음)에도 이 폴더 세션이 Claude Code 목록처럼 보이는지 본다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const { rec } = fx;
const stub = require('./helpers/vscode-stub').install({
  extDir: path.join(__dirname, '..'), language: 'en', workspace: project,
  config: { hideScratchpadFiles: false, attentionMarkerDir: markers, lookbackHours: 1 },
});
const ext = require('../extension.js');

const HOUR = 3600000;
const SID_3H = 'aaaa0000-1111-4111-8111-111111111111';
const SID_20D = 'bbbb0000-2222-4222-8222-222222222222';
function old(sid, title, ago) {
  const f = fx.claudeSession(home, project, sid, [rec.user(project, Date.now() - ago - 60000, title), rec.aiTitle(sid, title), rec.user(project, Date.now() - ago, 'more')]);
  fs.utimesSync(f, new Date(Date.now() - ago), new Date(Date.now() - ago));
}
old(SID_3H, 'Three hours ago', 3 * HOUR);
old(SID_20D, 'Twenty days ago', 20 * 24 * HOUR);
// 다른 폴더의 세션: 3시간 전·이틀 전·20일 전
const other = path.join(home, 'work', 'other-app');
fs.mkdirSync(other, { recursive: true });
const O_3H = 'cccc0000-3333-4333-8333-333333333333';
const O_2D = 'dddd0000-4444-4444-8444-444444444444';
const O_20D = 'eeee0000-5555-4555-8555-555555555555';
// 제목도 첫 질문도 없는 세션(다른 세션이 보낸 메시지만 있음): 기록 파일이 방금 바뀌었어도 목록에 넣지 않는다
const O_BLANK = 'ffff0000-6666-4666-8666-666666666666';
fx.claudeSession(home, other, O_BLANK, [{ ...rec.user(other, Date.now() - 2 * HOUR, 'Another Claude session sent a message: hi'), isMeta: true }, { type: 'cost-state', sessionId: O_BLANK }]);
for (const [sid, title, ago] of [[O_3H, 'Elsewhere 3h', 3 * HOUR], [O_2D, 'Elsewhere 2d', 2 * 24 * HOUR], [O_20D, 'Elsewhere 20d', 20 * 24 * HOUR]]) {
  const f = fx.claudeSession(home, other, sid, [rec.user(other, Date.now() - ago - 60000, title), rec.aiTitle(sid, title), rec.user(other, Date.now() - ago, 'more')]);
  fs.utimesSync(f, new Date(Date.now() - ago), new Date(Date.now() - ago));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('기다리다 시간 초과: ' + what);
    await sleep(50);
  }
}
let web;
test.before(async () => {
  ext.activate(stub.context);
  web = stub.openWebview('claudeSessionChanges.sessions');
  web.send({ type: 'ready' });
  await waitFor(() => web.lastPayload() && web.lastPayload().mine && web.lastPayload().mine.length, '세션 창 내용');
});
test.after(async () => { await ext.deactivate(); });

test('실행 중인 세션이 없어도 이 폴더 세션은 목록에, 오래된 세션은 보관함에 보인다', () => {
  const p = web.lastPayload();
  assert.deepStrictEqual(p.mine.map((r) => [r.sid, r.state, r.meta]), [[SID_3H, 'off', '3h ago']]);
  assert.deepStrictEqual(p.archived.map((r) => r.sid), [SID_20D]);
  assert.strictEqual(stub.trees['claudeSessionChanges.tree'].provider.getChildren().filter((e) => e.t === 'session').length, 0, '보는 기간(1시간) 안에 바꾼 파일이 없으니 변경 파일 창은 비어 있음');
});

test('다른 폴더도 실행 중이 아닌 최근 세션을 묶음에 보여 준다(보관함으로 갈 만큼 오래된 것은 빼고)', async () => {
  const rowsOf = () => (web.lastPayload().groups || []).flatMap((g) => g.rows.map((r) => r.sid)).sort();
  assert.deepStrictEqual(rowsOf(), [O_3H, O_2D].sort(), '기본(14일): 3시간 전·이틀 전은 보이고 20일 전·제목 없는 세션은 안 보임');
  assert.ok(!JSON.stringify(web.lastPayload().archived).includes(O_20D), '다른 폴더의 오래된 세션은 이 창 보관함에도 넣지 않음');
  stub.changeConfig('archiveAfter', '1');
  await waitFor(() => rowsOf().length === 1, '기준 1일');
  assert.deepStrictEqual(rowsOf(), [O_3H]);
  stub.changeConfig('archiveAfter', 'claude');
  await waitFor(() => rowsOf().length === 2, '기준 되돌림');
});

test('목록의 세션을 전부 보관해도 보관함은 보여서 다시 꺼낼 수 있다', async () => {
  web.send({ type: 'archive', sid: SID_3H });
  const p = await waitFor(() => { const x = web.lastPayload(); return x.archived && x.archived.length === 2 ? x : null; }, '둘 다 보관함에');
  assert.ok(!p.message && p.mine.length === 0);
  web.send({ type: 'unarchive', sid: SID_3H });
  await waitFor(() => web.lastPayload().mine && web.lastPayload().mine.length === 1, '다시 꺼내기');
});
