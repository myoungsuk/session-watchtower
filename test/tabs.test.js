'use strict';
// 이 창에 탭으로 열린 Claude 대화를 세션 창에서 다른 색으로 보여 주는지 시험한다.
// Claude Code 탭에는 세션 ID가 없고 이름만 있다(25자를 넘으면 앞 24자 + "…").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const { rec } = fx;
const stub = require('./helpers/vscode-stub').install({
  extDir: path.join(__dirname, '..'), language: 'en', workspace: project,
  config: { hideScratchpadFiles: false, attentionMarkerDir: markers, pollSeconds: 2, notifyStuckMinutes: 0 },
});
const ext = require('../extension.js');

const now = Date.now();
const MIN = 60000;
const other = path.join(home, 'work', 'other-app');
fs.mkdirSync(other, { recursive: true });
const LONG = 'Migrate every date helper to the new library';
const ids = {};
let n = 0;
function session(cwd, title, ago, reg) {
  const sid = `7ab0000${n}-1111-4111-8111-11111111111${n}`;
  n++;
  fx.claudeSession(home, cwd, sid, [rec.user(cwd, now - ago, 'Please ' + title), rec.aiTitle(sid, title)]);
  if (reg) fx.registerSession(home, reg, sid, { status: 'idle', cwd, name: 'n' + n, nameSource: 'derived', statusUpdatedAt: now - ago });
  return sid;
}
ids.watch = session(project, 'Watcher', 3 * MIN, process.pid);         // 실행 중, 탭 열림
ids.long = session(project, LONG, 20 * MIN);                           // 꺼짐, 긴 이름(탭에는 줄인 이름)
ids.quiet = session(project, 'Quiet one', 30 * MIN, process.ppid);     // 실행 중, 탭 없음
ids.sameOld = session(project, 'Same name', 90 * MIN);                 // 같은 이름 둘(둘 다 꺼짐): 최근 것만
ids.sameNew = session(project, 'Same name', 40 * MIN);
ids.elsewhere = session(other, 'Watcher', 5 * MIN, 1);                 // 다른 폴더의 같은 이름: 이 창 탭이 아니다
ids.textTab = session(project, 'README', 50 * MIN);                    // 같은 이름의 글 편집기 탭은 Claude 대화가 아니다

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
const rows = () => {
  const p = web.lastPayload();
  return [...p.mine, ...p.archived, ...p.groups.flatMap((g) => g.rows)];
};
const tabbed = () => rows().filter((r) => r.tab).map((r) => r.sid).sort();
const CLAUDE = 'mainThreadWebview-claudeVSCodePanel';

test.before(async () => {
  ext.activate(stub.context);
  web = stub.openWebview('claudeSessionChanges.sessions');
  web.send({ type: 'ready' });
  await waitFor(() => web.lastPayload() && web.lastPayload().mine && rows().length === 7, '세션 7개');
});
test.after(async () => { await ext.deactivate(); });

test('탭으로 열린 대화는 세션 창에서 다르게 보이고, 탭을 닫으면 원래대로 돌아온다', async () => {
  assert.deepStrictEqual(tabbed(), [], '탭이 없으면 표시도 없다');
  const posts = web.posted.length;
  stub.setTabs([
    { label: 'Watcher', viewType: CLAUDE },
    { label: LONG.substring(0, 24) + '…', viewType: CLAUDE },
    { label: 'Same name', viewType: CLAUDE },
    { label: 'Claude Code', viewType: CLAUDE },          // 이름 없는 새 대화
    { label: 'Quiet one', viewType: 'mainThreadWebview-markdown.preview' }, // 다른 확장의 화면
    { label: 'README' },                                 // 글 편집기
  ]);
  await waitFor(() => web.posted.length > posts, '탭이 바뀌면 다시 그린다', 3000);
  assert.deepStrictEqual(tabbed(), [ids.watch, ids.long, ids.sameNew].sort(),
    '실행 중인 같은 이름 세션, 줄인 이름, 같은 이름 중 최근 것만. 다른 폴더·다른 화면·글 편집기는 아니다');
  const watch = rows().find((r) => r.sid === ids.watch);
  assert.match(watch.tip, /^Open in a tab in this window\n/);
  assert.strictEqual(web.lastPayload().strings.lgTab, 'Open in a tab in this window', '색 설명에도 나온다');

  // 탭과 상관없는 변화(같은 이름들)에는 다시 그리지 않는다
  const quiet = web.posted.length;
  stub.setTabs([
    { label: 'Watcher', viewType: CLAUDE },
    { label: LONG.substring(0, 24) + '…', viewType: CLAUDE },
    { label: 'Same name', viewType: CLAUDE },
    { label: 'Claude Code', viewType: CLAUDE },
    { label: 'notes.md' },
  ]);
  await sleep(400);
  assert.strictEqual(web.posted.length, quiet, 'Claude 탭이 그대로면 다시 그리지 않는다');

  stub.setTabs([{ label: 'README' }]);
  await waitFor(() => tabbed().length === 0, '탭을 닫으면 표시가 사라진다', 3000);
});

test('세션 창 화면 코드에 탭 표시 모양이 들어 있다', () => {
  const html = web.view.webview.html;
  assert.match(html, /\.row\.tab, \.tabkey \{ background: var\(--vscode-list-inactiveSelectionBackground\)/);
  assert.match(html, /\(r\.tab \? ' tab' : ''\)/);
});
