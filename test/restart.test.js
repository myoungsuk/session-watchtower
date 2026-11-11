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

test('목록의 세션을 전부 보관해도 보관함은 보여서 다시 꺼낼 수 있다', async () => {
  web.send({ type: 'archive', sid: SID_3H });
  const p = await waitFor(() => { const x = web.lastPayload(); return x.archived && x.archived.length === 2 ? x : null; }, '둘 다 보관함에');
  assert.ok(!p.message && p.mine.length === 0);
  web.send({ type: 'unarchive', sid: SID_3H });
  await waitFor(() => web.lastPayload().mine && web.lastPayload().mine.length === 1, '다시 꺼내기');
});
