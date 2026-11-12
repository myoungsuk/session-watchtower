'use strict';
// 알림(멈춤·겹침)과 편의 기능(하위 에이전트 표시·대화 검색·요약 복사·파일에서 거꾸로 보기) 시험.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const { rec } = fx;
const stub = require('./helpers/vscode-stub').install({
  extDir: path.join(__dirname, '..'), language: 'en', workspace: project,
  config: { hideScratchpadFiles: false, attentionMarkerDir: markers, pollSeconds: 2, notifyStuckMinutes: 10 },
});
const ext = require('../extension.js');

const now = Date.now();
const MIN = 60000;
const SID_STUCK = 'a1e70000-1111-4111-8111-111111111111';
const SID_SUB = 'a1e70000-2222-4222-8222-222222222222';
const SID_O = 'a1e70000-3333-4333-8333-333333333333';
const shared = path.join(project, 'src', 'shared.js');
const other = path.join(project, 'src', 'other.js');
const solo = path.join(project, 'src', 'solo.js');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
for (const f of [shared, other, solo]) { fs.writeFileSync(f, 'v1\n'); fs.utimesSync(f, new Date(now - 10 * MIN), new Date(now - 10 * MIN)); }
const edit = (id, f, ts) => [rec.toolUse(project, ts - 400, id, 'Edit', { file_path: f, old_string: 'v1', new_string: 'v2' }), rec.toolResult(ts, id, rec.editResult(f, 'v1\n', 'v1', 'v2'))];

// 작업 중인데 12분째 새 기록이 없는 세션
fx.claudeSession(home, project, SID_STUCK, [
  rec.user(project, now - 20 * MIN, 'Migrate the date helpers to the new library'),
  rec.aiTitle(SID_STUCK, 'Stuck one'),
  rec.toolUse(project, now - 12 * MIN, 't_hang', 'Bash', { command: 'npm run migrate', description: 'Run the migration' }),
]);
// 하위 에이전트를 부려 작업 중인 세션(파일 셋을 고쳤다)
fx.claudeSession(home, project, SID_SUB, [
  rec.user(project, now - 9 * MIN, 'Split the shared module'),
  rec.aiTitle(SID_SUB, 'Splitter'),
  ...edit('s1', shared, now - 5 * MIN), ...edit('s2', other, now - 4 * MIN), ...edit('s3', solo, now - 3 * MIN),
  rec.toolUse(project, now - 20000, 't_agent', 'Agent', { description: 'Check the callers', subagent_type: 'general-purpose' }),
]);
fx.subagentSession(home, project, SID_SUB, 'agent-callers', [rec.toolUse(project, now - 4000, 'sa', 'Bash', { command: 'rg shared', description: 'Find callers' })]);
// 쉬고 있는 세션(나중에 같은 파일을 고친다)
const fileO = fx.claudeSession(home, project, SID_O, [rec.user(project, now - 30 * MIN, 'Tidy imports'), rec.aiTitle(SID_O, 'Tidier')]);
fx.registerSession(home, process.pid, SID_STUCK, { status: 'busy', cwd: project, name: 'd1', nameSource: 'derived', statusUpdatedAt: now - 20 * MIN });
fx.registerSession(home, process.ppid, SID_SUB, { status: 'busy', cwd: project, name: 'd2', nameSource: 'derived', statusUpdatedAt: now - 9 * MIN });
fx.registerSession(home, 1, SID_O, { status: 'idle', cwd: project, name: 'd3', nameSource: 'derived', statusUpdatedAt: now - 29 * MIN });

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
const tree = () => stub.trees['claudeSessionChanges.tree'].provider;
const sessionEl = (sid) => tree().getChildren().find((e) => e.t === 'session' && e.s.sid === sid);
const fileEl = (sid, name) => tree().getChildren(sessionEl(sid)).find((e) => e.t === 'file' && e.f.path.endsWith(name));
const desc = (sid, name) => tree().getTreeItem(fileEl(sid, name)).description;
const refresh = () => stub.commands.get('claudeSessionChanges.refresh')();
const add = (file, recs) => fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
const warns = (re) => stub.calls.filter((c) => c[0] === 'warn' && re.test(c[1]));
let web;

test.before(async () => {
  ext.activate(stub.context);
  await waitFor(() => sessionEl(SID_SUB), '첫 읽기');
  web = stub.openWebview('claudeSessionChanges.sessions');
  web.send({ type: 'ready' });
  await waitFor(() => web.lastPayload() && web.lastPayload().mine, '세션 창 내용');
});
test.after(async () => { await ext.deactivate(); });

test('멈춘 것 같은 세션: 작업 중인데 한참 새 기록이 없으면 한 번 알린다', async () => {
  const hit = () => warns(/"Stuck one" has been working for 1\d minutes without writing anything new/);
  await waitFor(() => hit().length === 1, '멈춤 알림', 9000);
  await sleep(2600);
  assert.strictEqual(hit().length, 1, '같은 멈춤을 거듭 알리지 않는다');
  assert.strictEqual(warns(/"Splitter" has been working/).length, 0, '기록이 계속 생기는 세션은 알리지 않는다');
});

test('하위 에이전트가 일하는 중이면 세션 줄에 몇 개인지 보인다', () => {
  const row = web.lastPayload().mine.find((r) => r.sid === SID_SUB);
  assert.match(row.now, /^1 subagent working · Running: Find callers$/, '하위 에이전트 수가 앞에(좁은 창에서 잘리지 않게), 그 뒤에 지금 하는 일');
  assert.ok(!/subagent/.test(web.lastPayload().mine.find((r) => r.sid === SID_STUCK).now));
});

test('겹침: 다른 세션이 고친 파일을 고치면 표시하고 한 번 알린다. 알리지 않기로 한 파일은 뺀다', async () => {
  assert.ok(!/⚠/.test(desc(SID_SUB, 'shared.js')), '처음에는 겹침이 없다');
  add(fileO, edit('o1', shared, Date.now()));
  await refresh();
  await waitFor(() => /^⚠ Tidier too/.test(desc(SID_SUB, 'shared.js')), '겹침 표시');
  assert.match(desc(SID_O, 'shared.js'), /^⚠ Splitter too/);
  assert.ok(!/⚠/.test(desc(SID_SUB, 'solo.js')), '한 세션만 고친 파일은 표시 없음');
  const note = warns(/"Tidier" just changed shared\.js\. "Splitter" also changed this file \(\d+m ago\)\./);
  assert.strictEqual(note.length, 1, '나중에 고친 쪽 기준으로 한 번만 알린다');
  assert.deepStrictEqual(note[0][2], ['Compare both changes', "Don't warn for this file"]);
  assert.deepStrictEqual(web.lastPayload().mine.filter((r) => r.overlap).map((r) => [r.sid, r.overlap]).sort(), [[SID_SUB, 1], [SID_O, 1]].sort());

  // "이 파일은 알리지 않기"를 누르면 그 파일의 표시도 사라진다
  stub.state.answer = (m, b) => (/other\.js/.test(m) ? b[1] : undefined);
  add(fileO, edit('o2', other, Date.now()));
  await refresh();
  await waitFor(() => warns(/just changed other\.js/).length === 1, '둘째 겹침 알림');
  await waitFor(() => !/⚠/.test(desc(SID_SUB, 'other.js')), '알리지 않기로 한 파일');
  assert.strictEqual(warns(/"Tidier" just changed shared\.js/).length, 1, '화면을 다시 그려도 같은 겹침을 거듭 알리지 않는다');
  assert.match(desc(SID_SUB, 'shared.js'), /^⚠/, '다른 파일의 표시는 그대로');
  stub.state.answer = null;
  await stub.commands.get('claudeSessionChanges.resetOverlapIgnore')();
  await waitFor(() => /^⚠/.test(desc(SID_SUB, 'other.js')), '다시 켜기');
  // 설정의 제외 패턴
  stub.changeConfig('overlapIgnore', ['**/src/shared.js']);
  await waitFor(() => !/⚠/.test(desc(SID_SUB, 'shared.js')), '제외 패턴');

  // "두 변경 비교": 두 세션의 변경을 비교 창 두 개로
  stub.changeConfig('overlapIgnore', []);
  await waitFor(() => /^⚠/.test(desc(SID_SUB, 'shared.js')), '패턴 해제');
  stub.calls.length = 0;
  stub.state.answer = (m, b) => (/third/.test(m) ? b[0] : undefined);
  const third = path.join(project, 'src', 'third.js');
  fs.writeFileSync(third, 'v1\n');
  add(fx.claudeSession(home, project, 'a1e70000-4444-4444-8444-444444444444', [rec.user(project, Date.now() - MIN, 'p'), rec.aiTitle('x', 'Fourth'), ...edit('q1', third, Date.now() - 30000)]), []);
  add(fileO, edit('o3', third, Date.now()));
  await refresh();
  await waitFor(() => stub.calls.filter((c) => c[0] === 'vscode.diff').length === 2, '비교 창 두 개');
  stub.state.answer = null;
});

test('대화 내용으로 세션 찾기: 내가 쓴 말에서 찾아 그 세션을 연다', async () => {
  const qp = stub.commands.get('claudeSessionChanges.searchConversations')('date helpers migrate');
  await waitFor(() => qp.items.length === 1, '찾은 결과');
  assert.deepStrictEqual([qp.items[0].r.sid, qp.items[0].label, qp.items[0].alwaysShow], [SID_STUCK, 'Migrate the date helpers to the new library', true]);
  assert.match(qp.items[0].description, /^Stuck one · /);
  stub.calls.length = 0;
  qp.accept(qp.items[0]);
  await waitFor(() => stub.calls.find((c) => c[0] === 'claude-vscode.editor.open' && c[1] === SID_STUCK), '세션 열기');
  // 입력을 바꾸면 다시 찾는다. 세션 창 검색 상자에서 Enter를 눌러도 같은 창이 뜬다
  web.send({ type: 'searchText', q: 'tidy imports' });
  await waitFor(() => stub.state.quickPick !== qp && stub.state.quickPick.items.length === 1, '검색 상자에서 넘어옴');
  assert.strictEqual(stub.state.quickPick.items[0].r.sid, SID_O);
  stub.state.quickPick.type('nothing like this anywhere');
  await waitFor(() => stub.state.quickPick.items.length === 0 && stub.state.quickPick.title === '0 matches', '없는 말');
});

test('변경 요약을 마크다운으로 복사한다', async () => {
  const one = await stub.commands.get('claudeSessionChanges.copySummary')(SID_SUB);
  assert.strictEqual(stub.state.clipboard, one);
  assert.match(one, /^## Session changes · last 24h\n\n### Splitter\n\n- 3 files · \+6 −3 · /);
  assert.match(one, /- Files:\n {2}- `src\/solo\.js` M \(\+2 −1\)\n/);
  assert.match(one, /`src\/shared\.js` M \(\+2 −1\) ⚠ also changed by Tidier/);
  const all = await stub.commands.get('claudeSessionChanges.copyFolderSummary')();
  assert.ok(/### Splitter/.test(all) && /### Tidier/.test(all) && !/### Stuck one/.test(all), '바꾼 파일이 있는 세션만');
  assert.ok(stub.calls.some((c) => c[0] === 'info' && /Copied a summary of \d session\(s\)/.test(c[1])));
});

test('파일에서 거꾸로: 이 파일을 고친 세션을 보여 주고 고르면 그 변경을 연다', async () => {
  stub.state.pick = (items) => items[0];
  stub.calls.length = 0;
  const n = await stub.commands.get('claudeSessionChanges.sessionsForFile')({ fsPath: shared });
  assert.strictEqual(n, 2);
  const pick = stub.calls.find((c) => c[0] === 'pick');
  assert.deepStrictEqual(pick[1].map((i) => i.label), ['Tidier', 'Splitter'], '최근에 고친 세션부터');
  assert.ok(stub.calls.some((c) => c[0] === 'vscode.diff'), '고른 세션의 변경을 연다');
  stub.calls.length = 0;
  await stub.commands.get('claudeSessionChanges.sessionsForFile')({ fsPath: path.join(project, 'nobody.js') });
  assert.ok(stub.calls.some((c) => c[0] === 'info' && /No session changed nobody\.js in the last 24h/.test(c[1])));
});

test('세션 이름 바꾸기: Claude Code와 같은 제목 기록을 대화 기록 끝에 덧붙인다', async () => {
  const title = () => web.lastPayload().mine.find((r) => r.sid === SID_O).title;
  const tail = () => fs.readFileSync(fileO, 'utf8').trimEnd().split('\n').pop();
  // 입력을 취소하거나 비우면 아무것도 쓰지 않는다
  const before = fs.statSync(fileO).size;
  stub.state.input = undefined;
  assert.strictEqual(await stub.commands.get('claudeSessionChanges.renameSession')(SID_O), false);
  stub.state.input = '   ';
  assert.strictEqual(await stub.commands.get('claudeSessionChanges.renameSession')(SID_O), false);
  assert.strictEqual(fs.statSync(fileO).size, before);
  // 이름을 넣으면 제목 기록 한 줄이 붙고 목록의 이름이 바뀐다
  stub.state.input = (o) => { assert.strictEqual(o.value, 'Tidier', '지금 이름이 미리 들어 있다'); return '  Import  cleanup  '; };
  assert.strictEqual(await stub.commands.get('claudeSessionChanges.renameSession')(SID_O), true);
  assert.deepStrictEqual(JSON.parse(tail()), { type: 'custom-title', sessionId: SID_O, customTitle: 'Import cleanup' });
  await waitFor(() => title() === 'Import cleanup', '바뀐 이름');
  await refresh();
  await waitFor(() => title() === 'Import cleanup', '다시 읽은 뒤에도 그 이름');
  // 기록 끝이 줄 바꿈이 아니면(쓰는 도중) 끼어들지 않는다
  fs.appendFileSync(fileO, '{"type":"user","partial":');
  stub.state.input = 'Should not be written';
  stub.calls.length = 0;
  assert.strictEqual(await stub.commands.get('claudeSessionChanges.renameSession')(SID_O), false);
  assert.ok(fs.readFileSync(fileO, 'utf8').endsWith('{"type":"user","partial":'), '기록을 건드리지 않는다');
  assert.ok(stub.calls.some((c) => c[0] === 'warn' && /Could not rename the session/.test(c[1])));
  stub.state.input = undefined;
});

