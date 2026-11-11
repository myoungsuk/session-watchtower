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
const other = path.join(home, 'work', 'other-app');
const fEdit = path.join(project, 'app.js');
const fNew = path.join(project, 'new.js');
const fBash = path.join(project, 'README.md');
const fGuess = path.join(project, 'notes.txt');
const fGone = path.join(project, 'gone.js');
fs.mkdirSync(other, { recursive: true });
for (const f of [fEdit, fNew, fBash, fGuess]) fs.writeFileSync(f, 'x\n');

const twoHunks = {
  files: [{ filePath: fBash, hunks: [
    { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' keep', '-old one', '+new one'] },
    { oldStart: 40, oldLines: 1, newStart: 40, newLines: 2, lines: [' tail', '+added'] },
  ] }],
  moreFiles: 0, changedFiles: [fBash],
};
fx.claudeSession(home, project, SID_A, [
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
fx.registerSession(home, process.pid, SID_A, { status: 'busy', cwd: project, name: 'demo-a1', nameSource: 'derived' });
fx.registerSession(home, process.ppid, SID_OTHER, { status: 'idle', cwd: other, name: 'other-b2', nameSource: 'derived', statusUpdatedAt: now - 30 * MIN });

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
  assert.match(web.view.description, /Working 1 · Waiting 0 · Idle 0/, '머리말은 이 폴더 세션만 센다');
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
