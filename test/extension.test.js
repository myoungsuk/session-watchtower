'use strict';
// 화면 쪽(extension.js) 시험. 가짜 vscode 모듈과 가짜 홈 폴더로 실제 확장 코드를 돌린다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const { rec } = fx;
const extDir = path.join(__dirname, '..');
const stub = require('./helpers/vscode-stub').install({
  extDir, language: 'en', workspace: project,
  config: { hideScratchpadFiles: false, attentionMarkerDir: markers }, // 시험 폴더가 임시 폴더 아래일 수 있어 숨김을 끈다
});
const ext = require('../extension.js'); // 홈 폴더·가짜 vscode 를 준비한 뒤에 불러야 한다

const now = Date.now();
const MIN = 60000;
const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SID_OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';
const SID_REST = 'cccccccc-3333-4333-8333-333333333333';
const HOUR = 60 * 60000;
const other = path.join(home, 'work', 'other-app');
const fEdit = path.join(project, 'app.js');
const fNew = path.join(project, 'new.js');
const fBash = path.join(project, 'README.md');
const fGuess = path.join(project, 'notes.txt');
const fGone = path.join(project, 'gone.js');
const fRest = path.join(project, 'rest.js');
fs.mkdirSync(other, { recursive: true });
for (const f of [fEdit, fNew, fBash, fGuess, fRest]) fs.writeFileSync(f, 'x\n');

const twoHunks = {
  files: [{ filePath: fBash, hunks: [
    { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' keep', '-old one', '+new one'] },
    { oldStart: 40, oldLines: 1, newStart: 40, newLines: 2, lines: [' tail', '+added'] },
  ] }],
  moreFiles: 0, changedFiles: [fBash],
};
const fileA = fx.claudeSession(home, project, SID_A, [
  rec.user(project, now - 40 * MIN, 'Refactor please'),
  rec.aiTitle(SID_A, 'Refactor auth'),
  rec.toolUse(project, now - 35 * MIN, 't_edit', 'Edit', { file_path: fEdit, old_string: 'a', new_string: 'b' }),
  rec.toolResult(now - 35 * MIN + 500, 't_edit', rec.editResult(fEdit, 'a\nrest\n', 'a', 'b')),
  rec.toolUse(project, now - 34 * MIN, 't_write', 'Write', { file_path: fNew, content: 'one\ntwo\n' }),
  rec.toolResult(now - 34 * MIN + 500, 't_write', rec.writeResult(fNew, 'one\ntwo\n')),
  rec.toolUse(project, now - 33 * MIN, 't_gone', 'Edit', { file_path: fGone, old_string: 'a', new_string: 'b' }),
  rec.toolResult(now - 33 * MIN + 500, 't_gone', rec.editResult(fGone, 'a\n', 'a', 'b')),
  rec.toolUse(project, now - 30 * MIN, 't_sed', 'Bash', { command: `sed -i 's/a/b/' ${fBash}`, description: 'Fix typos' }),
  rec.toolResult(now - 30 * MIN + 900, 't_sed', rec.bashResult({ bashEditDiff: twoHunks })),
  rec.toolUse(project, now - 20 * MIN, 't_echo', 'Bash', { command: `cd ${project} && echo hi >> notes.txt`, description: 'Append a note' }),
  rec.toolResult(now - 20 * MIN + 300, 't_echo', rec.bashResult({})),
  rec.toolUse(project, now - 1 * MIN, 't_test', 'Bash', { command: 'npm test', description: 'Run the tests' }),
]);
fx.claudeSession(home, other, SID_OTHER, [
  rec.user(other, now - 15 * MIN, 'Something in another folder'),
  rec.aiTitle(SID_OTHER, 'Other folder work'),
  rec.toolUse(other, now - 14 * MIN, 't_o', 'Write', { file_path: path.join(other, 'o.txt'), content: 'o\n' }),
  rec.toolResult(now - 14 * MIN + 300, 't_o', rec.writeResult(path.join(other, 'o.txt'), 'o\n')),
]);
fs.writeFileSync(path.join(other, 'o.txt'), 'o\n');
// 6시간 전에 대화가 끝났고, 방금 창을 다시 열어 상태 시각만 새로 찍힌 세션(꺼질 때 붙는 정리 기록에는 시각이 없다)
const restFile = fx.claudeSession(home, project, SID_REST, [
  rec.user(project, now - 6 * HOUR - 11 * MIN, 'An older task'),
  rec.aiTitle(SID_REST, 'Rested session'),
  rec.toolUse(project, now - 6 * HOUR - 10 * MIN, 't_rest', 'Write', { file_path: fRest, content: 'r\n' }),
  rec.toolResult(now - 6 * HOUR - 10 * MIN + 500, 't_rest', rec.writeResult(fRest, 'r\n')),
  { type: 'last-prompt', lastPrompt: 'An older task', sessionId: SID_REST },
  { type: 'cost-state', sessionId: SID_REST, cost: {} },
]);
fx.registerSession(home, process.pid, SID_A, { status: 'busy', cwd: project, name: 'demo-a1', nameSource: 'derived' });
fx.registerSession(home, process.ppid, SID_OTHER, { status: 'idle', cwd: other, name: 'other-b2', nameSource: 'derived', statusUpdatedAt: now - 30 * MIN });
fx.registerSession(home, 1, SID_REST, { status: 'idle', cwd: project, name: 'demo-c3', nameSource: 'derived', statusUpdatedAt: now });

const TREE = 'claudeSessionChanges.tree';
const SESSIONS = 'claudeSessionChanges.sessions';
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
const provider = () => stub.trees[TREE].provider;
const roots = () => provider().getChildren();
const item = (el) => provider().getTreeItem(el);
const sessionA = () => roots().find((e) => e.t === 'session' && e.s.sid === SID_A);
const fileOf = (name) => provider().getChildren(sessionA()).find((e) => e.t === 'file' && e.f.path.endsWith(name));
const content = (uri) => stub.state.contentProvider.provideTextDocumentContent(uri);
let web;

test.before(async () => {
  ext.activate(stub.context);
  await waitFor(() => roots().some((e) => e.t === 'session'), '첫 읽기');
  web = stub.openWebview(SESSIONS);
  web.send({ type: 'ready' });
  await waitFor(() => web.lastPayload() && web.lastPayload().mine, '세션 창 내용');
});

test.after(async () => { await ext.deactivate(); });

test('변경 파일 창: 이 폴더 세션이 위, 다른 폴더는 접힌 묶음, ID 중복 없음', () => {
  const top = roots();
  assert.strictEqual(top[0].t, 'session');
  assert.strictEqual(top[0].s.sid, SID_A);
  const group = top.find((e) => e.t === 'cgroup');
  assert.ok(group && group.key === 'other-app');
  assert.strictEqual(item(group).collapsibleState, 1, '묶음은 접힌 채로');
  const ids = new Set();
  const walk = (el) => { const id = item(el).id; assert.ok(!ids.has(id), '중복 ID ' + id); ids.add(id); provider().getChildren(el).forEach(walk); };
  top.forEach(walk);
  assert.ok(ids.size > 10);
});

test('파일 표시: A 새 파일 · M 수정 · D 지워짐 · ? 추정', () => {
  const badge = (name) => item(fileOf(name)).resourceUri.query;
  assert.strictEqual(badge('new.js'), 'A');
  assert.strictEqual(badge('app.js'), 'M');
  assert.strictEqual(badge('README.md'), 'M');
  assert.strictEqual(badge('gone.js'), 'D');
  assert.strictEqual(badge('notes.txt'), '?');
  assert.match(item(fileOf('app.js')).description, /\+2 −1/);
});

test('세션 창: 상태·지금 하는 일·변경 규모·다른 폴더 묶음', () => {
  const p = web.lastPayload();
  const a = p.mine.find((r) => r.sid === SID_A);
  assert.strictEqual(a.state, 'busy');
  assert.strictEqual(a.now, 'Running: Run the tests');
  assert.ok(a.add > 0 && a.files >= 4);
  assert.strictEqual(a.canOpen, true);
  assert.strictEqual(p.compact, false);
  assert.match(p.strings.diffTip, /^Last 24 hours: /);
  const g = p.groups.find((x) => x.key === 'other-app');
  assert.ok(g && g.rows[0].canOpen === false && g.rows[0].state === 'idle');
  assert.match(web.view.description, /Working 1 · Waiting 0 · Idle 1/, '머리말은 이 폴더 세션만 센다');
});

test('한 줄 보기 설정을 끄면 둘째 줄을 그리지 않는다', async () => {
  stub.changeConfig('sessionDetails', false);
  await waitFor(() => web.lastPayload().compact === true, '설정 반영');
  stub.changeConfig('sessionDetails', true);
  await waitFor(() => web.lastPayload().compact === false, '설정 되돌림');
});

test('세션 창 화면 코드가 문법 오류 없이 읽힌다', () => {
  const m = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(web.view.webview.html);
  assert.ok(m, '화면 코드가 있어야 함');
  assert.doesNotThrow(() => new vm.Script(m[1]));
  assert.match(web.view.webview.html, /default-src 'none'/, '외부 자원을 막는 보안 정책');
});

test('세션을 누르면 Claude 대화 열기, 다른 폴더 세션은 안내', async () => {
  stub.calls.length = 0;
  web.send({ type: 'open', sid: SID_A });
  await waitFor(() => stub.calls.find((c) => c[0] === 'claude-vscode.editor.open'), '대화 열기');
  assert.strictEqual(stub.calls.find((c) => c[0] === 'claude-vscode.editor.open')[1], SID_A);
  stub.calls.length = 0;
  web.send({ type: 'open', sid: SID_OTHER });
  await waitFor(() => stub.calls.find((c) => c[0] === 'info'), '안내 문구');
  assert.ok(!stub.calls.some((c) => c[0] === 'claude-vscode.editor.open'));
  stub.calls.length = 0;
  web.send({ type: 'new' });
  await waitFor(() => stub.calls.find((c) => c[0] === 'claude-vscode.editor.open' && c.length === 1), '새 세션');
});

test('여러 덩어리로 나뉜 셸 변경도 비교 화면이 열린다(0.6.0 ~ 0.7.1 버그)', async () => {
  const f = fileOf('README.md');
  const change = provider().getChildren(f).find((e) => e.c.kind === 'bash');
  stub.calls.length = 0;
  await stub.commands.get('claudeSessionChanges.openChangeDiff')(change);
  const call = stub.calls.find((c) => c[0] === 'vscode.diff');
  assert.ok(call, '비교 창을 열어야 함');
  const left = await content(call[1]);
  const right = await content(call[2]);
  assert.ok(!/Could not read/.test(left + right), left);
  assert.match(left, /old one/);
  assert.match(right, /new one[\s\S]*near line 40[\s\S]*added/);
  const h = ext._test.hunksToSides(twoHunks.files[0].hunks);
  assert.deepStrictEqual(h.left.split('\n').length, 5);
});

test('편집 도구 변경: 고치기 전 ↔ 고친 뒤', async () => {
  const change = provider().getChildren(fileOf('app.js')).find((e) => e.c.kind === 'edit');
  stub.calls.length = 0;
  await stub.commands.get('claudeSessionChanges.openChangeDiff')(change);
  const call = stub.calls.find((c) => c[0] === 'vscode.diff');
  assert.strictEqual(await content(call[1]), 'a\nrest\n');
  assert.strictEqual(await content(call[2]), 'b\nrest\n');
});

test('변경 전부 보기: 세션이 바꾼 파일을 한 창에', async () => {
  stub.calls.length = 0;
  await stub.commands.get('claudeSessionChanges.openSessionChanges')(SID_A);
  const call = stub.calls.find((c) => c[0] === 'vscode.changes');
  assert.ok(call, '여러 파일 비교 창을 열어야 함');
  assert.match(call[1], /Refactor auth/);
  const files = provider().getChildren(sessionA()).filter((e) => e.t === 'file');
  // 셸 글자로 추정만 한 notes.txt 는 비교할 기록이 없어 빠지고, 빠졌다고 알려야 한다
  assert.strictEqual(call[2].length, files.length - 1);
  assert.ok(!call[2].some((r) => r[0].path === fGuess));
  assert.ok(stub.calls.some((c) => c[0] === 'info' && /1 file\(s\) were left out/.test(c[1])), '빠진 파일 수를 알림');
  const edited = call[2].find((r) => r[0].path === fEdit);
  assert.notStrictEqual(edited[2].scheme, 'file', '편집 도구로만 바꾼 파일의 오른쪽은 세션 끝 내용');
  assert.strictEqual(await content(edited[2]), 'b\nrest\n');
});

test('상태 표시줄: 작업 중 → 승인 기다림이면 경고색', async () => {
  const bar = stub.statusItems[0];
  assert.match(bar.text, /\$\(loading~spin\) 1/);
  assert.ok(!bar.backgroundColor);
  const marker = fx.writeMarker(markers, SID_A, 'Bash');
  await stub.commands.get('claudeSessionChanges.refresh')();
  await waitFor(() => /\$\(bell-dot\) 1/.test(bar.text), '기다림 반영');
  assert.ok(bar.backgroundColor);
  assert.strictEqual(web.lastPayload().mine.find((r) => r.sid === SID_A).state, 'waiting');
  assert.strictEqual(web.view.badge.value, 1);
  fs.unlinkSync(marker);
});

test('시간은 마지막 대화 기준: 다시 연 세션이 "방금 끝남"으로 보이지 않는다', () => {
  const p = web.lastPayload();
  assert.deepStrictEqual(p.mine.map((r) => r.sid), [SID_A, SID_REST], 'Claude 목록처럼 마지막 대화가 최근인 순서');
  const rest = p.mine.find((r) => r.sid === SID_REST);
  assert.strictEqual(rest.state, 'idle', '상태 시각이 방금이어도 대화가 6시간 전이면 쉬는 중');
  assert.strictEqual(rest.meta, '6h', '쉰 시간은 마지막 대화부터');
});

test('보관: 목록·변경 파일 창에서 빠지고 보관함으로, 꺼내면 돌아온다', async () => {
  const inTree = () => roots().some((e) => e.t === 'session' && e.s.sid === SID_REST);
  assert.ok(inTree(), '보관 전에는 변경 파일 창에 있어야 함');
  web.send({ type: 'archive', sid: SID_REST });
  await waitFor(() => web.lastPayload().archived.some((r) => r.sid === SID_REST), '보관 반영');
  assert.ok(!web.lastPayload().mine.some((r) => r.sid === SID_REST));
  assert.ok(!inTree(), '변경 파일 창에서도 빠져야 함');
  assert.match(web.view.description, /Idle 0/);
  web.send({ type: 'unarchive', sid: SID_REST });
  await waitFor(() => web.lastPayload().mine.some((r) => r.sid === SID_REST), '꺼내기 반영');
  assert.strictEqual(web.lastPayload().archived.length, 0);
  // 다른 폴더 세션을 보관해도 보관함에 보여야 한다(안 보이면 이 창에서 다시 꺼낼 수 없다)
  web.send({ type: 'archive', sid: SID_OTHER });
  const kept = await waitFor(() => web.lastPayload().archived.find((r) => r.sid === SID_OTHER), '다른 폴더 세션 보관');
  assert.strictEqual(kept.folder, 'other-app', '어느 폴더 세션인지 보여야 함');
  assert.ok(!JSON.stringify(web.lastPayload().groups || []).includes(SID_OTHER), '다른 폴더 묶음에서는 빠져야 함');
  web.send({ type: 'unarchive', sid: SID_OTHER });
  await waitFor(() => !web.lastPayload().archived.length, '다른 폴더 세션 꺼내기');
});

test('보관: 일하는 중인 세션은 숨기지 않고, 보관 뒤 새 대화가 생기면 저절로 돌아온다', async () => {
  web.send({ type: 'archive', sid: SID_A });
  await sleep(150);
  assert.ok(web.lastPayload().mine.some((r) => r.sid === SID_A), '작업 중인 세션은 그대로 보여야 함');
  web.send({ type: 'unarchive', sid: SID_A });
  web.send({ type: 'archive', sid: SID_REST });
  await waitFor(() => web.lastPayload().archived.some((r) => r.sid === SID_REST), '보관 반영');
  fs.appendFileSync(restFile, JSON.stringify(rec.user(project, Date.now() + 10000, 'One more thing')) + '\n');
  await stub.commands.get('claudeSessionChanges.refresh')();
  await waitFor(() => web.lastPayload().mine.some((r) => r.sid === SID_REST), '새 대화 뒤 자동으로 돌아옴');
});

test('지금 고치는 파일: 작업 중인 세션이 고치는 파일에만 도는 표시가 붙고, 시간이 지나면 꺼진다', async () => {
  const icon = (name) => item(fileOf(name)).iconPath.id;
  const add = (file, recs) => fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const refresh = () => stub.commands.get('claudeSessionChanges.refresh')();
  assert.deepStrictEqual([icon('app.js'), icon('new.js')], ['file', 'file'], '오래전에 바꾼 파일은 보통 그림');

  // (가) 아직 끝나지 않은 고치기 도구가 겨냥한 파일
  add(fileA, [rec.toolUse(project, Date.now() - 5 * MIN, 't_pend', 'Edit', { file_path: fNew, old_string: 'one', new_string: 'uno' })]);
  await refresh();
  await waitFor(() => icon('new.js') === 'loading~spin', '끝나지 않은 고치기 도구');
  assert.strictEqual(icon('app.js'), 'file', '다른 파일은 그대로');
  fx.registerSession(home, process.pid, SID_A, { status: 'waiting', waitingFor: 'permission prompt', cwd: project, name: 'demo-a1', nameSource: 'derived' });
  await refresh();
  await waitFor(() => icon('new.js') === 'bell-dot', '승인을 기다리는 동안은 종 표시');
  assert.match(item(fileOf('new.js')).tooltip, /Waiting for your approval/);
  fx.registerSession(home, process.pid, SID_A, { status: 'busy', cwd: project, name: 'demo-a1', nameSource: 'derived' });

  // (나) 방금 바꾼 파일: 28.5초 전 변경 → 도는 표시, 30초가 지나면 새 기록 없이도 스스로 꺼진다
  const t = Date.now() - 28500;
  add(fileA, [
    rec.toolResult(t - 100, 't_pend', rec.editResult(fNew, 'one\ntwo\n', 'one', 'uno')),
    rec.toolUse(project, t - 50, 't_live', 'Edit', { file_path: fEdit, old_string: 'b', new_string: 'c' }),
    rec.toolResult(t, 't_live', rec.editResult(fEdit, 'b\nrest\n', 'b', 'c')),
  ]);
  await refresh();
  await waitFor(() => icon('app.js') === 'loading~spin', '방금 바꾼 파일');
  assert.match(item(fileOf('app.js')).tooltip, /Being edited now/);
  let fires = 0;
  provider().onDidChangeTreeData(() => { fires++; });
  await waitFor(() => fires > 0 && icon('app.js') === 'file', '30초가 지나 표시가 꺼지고 다시 그림', 6000);

  // 쉬는 세션이 방금 바꾼 파일은 돌지 않는다
  web.send({ type: 'unarchive', sid: SID_REST });
  add(restFile, [
    rec.toolUse(project, Date.now() - 1500, 't_r2', 'Write', { file_path: fRest, content: 'r2\n' }),
    rec.toolResult(Date.now() - 1000, 't_r2', rec.writeResult(fRest, 'r2\n')),
  ]);
  await refresh();
  const restEl = await waitFor(() => roots().find((e) => e.t === 'session' && e.s.sid === SID_REST && e.s.files[0] && e.s.files[0].changes.length === 2), '쉬는 세션의 새 변경');
  const restItem = item(provider().getChildren(restEl).find((e) => e.t === 'file'));
  assert.strictEqual(restItem.iconPath.id, 'file');
});

test('목록과 보관함: 이 폴더의 꺼진 세션도 보이고, 오래 대화가 없던 세션은 보관함으로 간다', async () => {
  const DAY = 24 * HOUR;
  const refresh = () => stub.commands.get('claudeSessionChanges.refresh')();
  const mk = (sid, title, ago) => {
    const f = fx.claudeSession(home, project, sid, [rec.user(project, Date.now() - ago - MIN, title), rec.aiTitle(sid, title), rec.user(project, Date.now() - ago, 'more')]);
    fs.utimesSync(f, new Date(Date.now() - ago), new Date(Date.now() - ago));
  };
  const SID_2D = 'dddddddd-4444-4444-8444-444444444444';
  const SID_20D = 'eeeeeeee-5555-4555-8555-555555555555';
  mk(SID_2D, 'Two days ago', 2 * DAY);   // 실행 중이 아니고 보는 기간(24시간) 밖 → 그래도 목록에 보여야 함
  mk(SID_20D, 'Twenty days ago', 20 * DAY); // Claude 기본 14일보다 오래됨 → 보관함
  // 다른 폴더: 대화는 20일 전에 끝났고 기록 파일만 방금 건드려진 세션 → 이 창 목록·보관함 어디에도 나오면 안 됨
  const SID_FAR = 'ffffffff-6666-4666-8666-666666666666';
  fx.claudeSession(home, other, SID_FAR, [rec.user(other, Date.now() - 20 * DAY, 'Old talk elsewhere'), rec.aiTitle(SID_FAR, 'Old talk elsewhere'), { type: 'cost-state', sessionId: SID_FAR }]);
  await refresh();
  await waitFor(() => web.lastPayload().mine.some((r) => r.sid === SID_2D), '이틀 전 세션이 목록에');
  const p = web.lastPayload();
  assert.ok(!JSON.stringify(p).includes(SID_FAR), '다른 폴더의 옛 세션은 끼어들지 않음');
  assert.strictEqual(p.mine.find((r) => r.sid === SID_2D).state, 'off');
  assert.ok(p.archived.some((r) => r.sid === SID_20D) && !p.mine.some((r) => r.sid === SID_20D), '20일 전 세션은 보관함에만');
  assert.match(p.archivedTip, /14 day/);
  assert.ok(!roots().some((e) => e.t === 'session' && (e.s.sid === SID_2D || e.s.sid === SID_20D)), '바꾼 파일이 없으니 변경 파일 창에는 없음');

  // 보관함에서 꺼내면 목록에 남는다(꺼낸 시각부터 다시 센다)
  web.send({ type: 'unarchive', sid: SID_20D });
  await waitFor(() => web.lastPayload().mine.some((r) => r.sid === SID_20D), '꺼낸 세션');
  web.send({ type: 'archive', sid: SID_20D });
  await waitFor(() => web.lastPayload().archived.some((r) => r.sid === SID_20D), '다시 보관');

  // Claude Code 설정을 따른다: 1일이면 이틀 전 세션도 보관함, 0(안 함)이면 직접 보관한 것만
  const setClaude = (v) => { stub.state.config.archiveInactiveSessions = v; stub.state.onConfig({ affectsConfiguration: (k) => k === 'claudeCode.archiveInactiveSessions' }); };
  setClaude(1);
  await waitFor(() => web.lastPayload().archived.some((r) => r.sid === SID_2D), '설정 1일');

  // 날 수 규칙이 닿는 범위(설정을 2.4시간으로 줄여 5 ~ 6시간 전 세션들로 확인)
  const SID_5H = '12121212-7777-4777-8777-777777777777';
  const SID_O5H = '34343434-8888-4888-8888-888888888888';
  const f5 = path.join(project, 'five.js');
  fs.writeFileSync(f5, 'x\n');
  const t5 = Date.now() - 5 * HOUR;
  fx.claudeSession(home, project, SID_5H, [rec.user(project, t5 - MIN, 'Five hours ago'), rec.aiTitle(SID_5H, 'Five hours ago'),
    rec.toolUse(project, t5, 't_5', 'Write', { file_path: f5, content: 'x\n' }), rec.toolResult(t5 + 300, 't_5', rec.writeResult(f5, 'x\n'))]);
  fx.claudeSession(home, other, SID_O5H, [rec.user(other, t5 - MIN, 'Elsewhere five hours ago'), rec.aiTitle(SID_O5H, 'Elsewhere five hours ago'), rec.user(other, t5, 'more')]);
  // 5시간 전에 대화가 끝났지만 창에 열려 있는(프로세스가 살아 있는) 세션
  const SID_OPEN = '56565656-9999-4999-8999-999999999999';
  fx.claudeSession(home, project, SID_OPEN, [rec.user(project, t5 - MIN, 'Still open'), rec.aiTitle(SID_OPEN, 'Still open'), rec.user(project, t5, 'more')]);
  fx.registerSession(home, 1, SID_OPEN, { status: 'idle', cwd: project, name: 'demo-d4', nameSource: 'derived', statusUpdatedAt: t5 });
  setClaude(0.1);
  await refresh();
  await waitFor(() => web.lastPayload().archived.some((r) => r.sid === SID_5H), '5시간 전 세션이 보관함에');
  const q = web.lastPayload();
  assert.ok(q.mine.some((r) => r.sid === SID_OPEN), '열려 있는 세션은 오래돼도 자동 보관하지 않음');
  assert.ok(roots().some((e) => e.t === 'session' && e.s.sid === SID_5H), '날 수로 보관함에 간 세션도 바꾼 파일은 변경 파일 창에 남음');
  assert.ok(JSON.stringify(q.groups).includes(SID_O5H) && !q.archived.some((r) => r.sid === SID_O5H), '다른 폴더 세션은 날 수로 보관하지 않음');
  setClaude(0);
  await waitFor(() => web.lastPayload().mine.some((r) => r.sid === SID_2D), '설정 0');
  await waitFor(() => web.lastPayload().archived.length === 1, '설정 0 반영');
  assert.deepStrictEqual(web.lastPayload().archived.map((r) => r.sid), [SID_20D], '직접 보관한 세션만 남음');
  assert.match(web.lastPayload().archivedTip, /^Sessions you archived here/);

  // 목록 일수 0: 예전처럼 실행 중이거나 보는 기간 안에 변경이 있는 세션만
  stub.changeConfig('sessionListDays', 0);
  await waitFor(() => !web.lastPayload().mine.some((r) => r.sid === SID_2D), '목록 일수 0');
});

