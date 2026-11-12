'use strict';
// 세션 그룹과 그룹 보드(관제 화면) 시험: 그룹 만들기·넣기·빼기·역할, 세션 창에서 맨 위에 묶어 보이기,
// 보드의 기다리는 것·세션 현황(커밋 안 한 파일)·설명되지 않는 변경·내가 한 말(원문·시각)·공유 메모, 다른 창이 바꾼 그룹 반영.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const { rec } = fx;
const stub = require('./helpers/vscode-stub').install({
  extDir: path.join(__dirname, '..'), language: 'en', workspace: project,
  config: { hideScratchpadFiles: false, attentionMarkerDir: markers, pollSeconds: 2, notifyStuckMinutes: 0, notifyWaiting: false },
});
const ext = require('../extension.js');

const now = Date.now();
const MIN = 60000;
const other = path.join(home, 'work', 'other-app');
fs.mkdirSync(other, { recursive: true });
// 이 폴더는 git 저장소: app.js는 세션이 고쳐서 커밋 안 함, stray.txt는 어느 세션도 안 만든 파일
const git = (...a) => execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });
const app = path.join(project, 'app.js');
fs.writeFileSync(app, 'v1\n');
git('init', '-q');
git('add', '-A');
git('commit', '-q', '-m', 'init');
fs.writeFileSync(app, 'v2\n');
fs.writeFileSync(path.join(project, 'stray.txt'), 'who made me\n');
for (const f of [app, path.join(project, 'stray.txt')]) fs.utimesSync(f, new Date(now - 20 * MIN), new Date(now - 20 * MIN));

const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
const SID = { w: 'a0b00000-1111-4111-8111-111111111111', d: 'a0b00000-2222-4222-8222-222222222222', v: 'a0b00000-3333-4333-8333-333333333333', o: 'a0b00000-4444-4444-8444-444444444444', x: 'a0b00000-5555-4555-8555-555555555555' };
fx.claudeSession(home, project, SID.w, [rec.user(project, now - 40 * MIN, 'Watch the other sessions every half hour'), rec.aiTitle(SID.w, 'Watcher'), rec.user(project, now - 6 * MIN, 'ship it')]);
fx.claudeSession(home, project, SID.d, [rec.user(project, now - 30 * MIN, 'Prepare the release'), rec.aiTitle(SID.d, 'Deployer'),
  rec.toolUse(project, now - 2 * MIN, 't_rel', 'Bash', { command: 'scripts/release.sh promote' })]);
fx.claudeSession(home, project, SID.v, [rec.user(project, now - 25 * MIN, 'Fix the parser'), rec.aiTitle(SID.v, 'Developer'),
  rec.toolUse(project, now - 21 * MIN, 't_e', 'Edit', { file_path: app, old_string: 'v1', new_string: 'v2' }), rec.toolResult(now - 21 * MIN + 400, 't_e', rec.editResult(app, 'v1\n', 'v1', 'v2'))]);
fx.claudeSession(home, other, SID.o, [rec.user(other, now - 10 * MIN, 'Check the other app'), rec.aiTitle(SID.o, 'Outside')]);
fx.claudeSession(home, project, SID.x, [rec.user(project, now - 50 * MIN, 'Something unrelated'), rec.aiTitle(SID.x, 'Loner')]);
fx.registerSession(home, process.pid, SID.w, { status: 'idle', cwd: project, name: 'w', nameSource: 'derived', statusUpdatedAt: now - 5 * MIN });
fx.registerSession(home, process.ppid, SID.d, { status: 'waiting', waitingFor: 'permission prompt', cwd: project, name: 'd', nameSource: 'derived', statusUpdatedAt: now - 2 * MIN });
fx.registerSession(home, 1, SID.v, { status: 'busy', cwd: project, name: 'v', nameSource: 'derived', statusUpdatedAt: now - 25 * MIN });
fx.registerSession(home, sleeper.pid, SID.o, { status: 'idle', cwd: other, name: 'o', nameSource: 'derived', statusUpdatedAt: now - 9 * MIN });

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
const P = () => web.lastPayload();
const team = (name) => (P().teams || []).find((t) => t.name === name);
const titles = (rows) => rows.map((r) => r.title).sort().join(',');
const groupsFile = () => path.join(stub.context.globalStorageUri.fsPath, 'session-groups.json');

test.before(async () => {
  ext.activate(stub.context);
  web = stub.openWebview('claudeSessionChanges.sessions');
  web.send({ type: 'ready' });
  await waitFor(() => P() && P().mine && P().mine.length === 4, '이 폴더 세션 4개');
});
test.after(async () => { sleeper.kill(); for (const p of stub.state.panels || []) p.dispose(); await ext.deactivate(); });

test('그룹을 만들고 세션을 넣으면 세션 창 맨 위에 묶여 보이고, 이 폴더 칸에서는 빠진다', async () => {
  assert.deepStrictEqual(P().teams, [], '처음에는 그룹이 없다');
  stub.state.input = 'Chatbot ops';
  await stub.commands.get('claudeSessionChanges.createGroup')();
  await waitFor(() => team('Chatbot ops'), '새 그룹');
  assert.strictEqual(team('Chatbot ops').rows.length, 0);
  assert.match(P().strings.teamEmpty, /group button on a session row/);

  // 세션 줄의 그룹 단추 → 그룹 고르기
  stub.state.pick = (items) => items.find((i) => i.label === 'Chatbot ops');
  web.send({ type: 'group', sid: SID.w });
  await waitFor(() => team('Chatbot ops') && team('Chatbot ops').rows.length === 1, '그룹에 들어감');
  assert.strictEqual(team('Chatbot ops').rows[0].team, team('Chatbot ops').id);
  assert.ok(!P().mine.some((r) => r.sid === SID.w), '그룹에 든 세션은 이 폴더 칸에 다시 나오지 않는다');
  assert.strictEqual(P().openHere, 3, '열린 세션 수는 그룹과 상관없이 이 폴더 기준(꺼진 Loner 빼고 셋)');

  // 역할
  stub.state.input = 'watch';
  web.send({ type: 'role', sid: SID.w });
  await waitFor(() => team('Chatbot ops').rows[0].role === 'watch', '역할 꼬리표');
});

test('그룹 보드: 기다리는 세션, 세션 현황(커밋 안 한 파일), 설명되지 않는 변경, 내가 한 말을 한 화면에', async () => {
  const id = team('Chatbot ops').id;
  web.send({ type: 'board', team: id });
  const panel = await waitFor(() => (stub.state.panels || []).find((p) => !p.disposed), '보드 화면');
  panel.send({ type: 'ready' });
  assert.match(panel.title, /^Board · Chatbot ops$/);
  assert.match(panel.webview.html, /Content-Security-Policy[^>]*script-src 'nonce-/, '보드 화면도 스크립트를 막아 둔다(메모 파일 내용이 그대로 들어간다)');
  const code = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panel.webview.html);
  assert.ok(code, '보드 화면 코드가 있어야 함');
  assert.doesNotThrow(() => new (require('vm').Script)(code[1]), '보드 화면 코드가 문법 오류 없이 읽힌다');

  // 보드에서 세션 여러 개 넣기(다른 폴더 세션 포함)
  stub.state.pick = (items) => items.filter((i) => ['Deployer', 'Developer', 'Outside'].includes(i.label));
  panel.send({ type: 'add' });
  const p = await waitFor(() => { const x = panel.lastPayload(); return x && x.members && x.members.length === 4 ? x : null; }, '네 세션', 10000);
  assert.strictEqual(titles(team('Chatbot ops').rows), 'Deployer,Developer,Outside,Watcher');
  assert.ok(!P().groups.length, '다른 폴더 칸도 그룹에 든 세션은 빼고, 비면 칸을 그리지 않는다');

  // 기다리는 것: 무엇을 승인해 달라는지까지
  assert.strictEqual(p.waiting.length, 1);
  assert.strictEqual(p.waiting[0].title, 'Deployer');
  assert.match(p.waiting[0].detail, /release\.sh promote/);
  // 세션 현황: 커밋 안 한 파일은 그 파일을 고친 세션에, 아무도 안 고친 파일은 따로
  const dev = p.members.find((m) => m.title === 'Developer');
  assert.deepStrictEqual(dev.uncommitted, [app]);
  assert.strictEqual(dev.state, 'busy');
  assert.deepStrictEqual(p.unknown, [path.join(project, 'stray.txt')]);
  const out = p.members.find((m) => m.title === 'Outside');
  assert.strictEqual(out.folder, 'other-app');
  assert.strictEqual(out.canOpen, false, '다른 폴더 세션은 이 창에서 열 수 없다고 알린다');
  assert.strictEqual(p.members.find((m) => m.title === 'Watcher').role, 'watch');

  // 내가 한 말: 최근 것부터, 결정 기록에 쓰는 모양(시각 + 원문 + 세션)으로 복사
  const said = await waitFor(() => { const x = panel.lastPayload(); return x && x.said && x.said.length >= 5 ? x.said : null; }, '내가 한 말', 15000);
  assert.strictEqual(said[0].text, 'ship it', '가장 최근에 한 말이 맨 위');
  assert.match(said[0].stamp, /^\d\d-\d\d \d\d:\d\d:\d\d (KST|UTC[+−]\d+(:\d\d)?)$/);
  assert.ok(!said.some((x) => x.text === 'Something unrelated'), '그룹 밖 세션에 한 말은 넣지 않는다');
  panel.send({ type: 'copyQuote', i: 0 });
  await waitFor(() => /^\d\d-\d\d \d\d:\d\d:\d\d \S+ "ship it" \(Watcher\)$/.test(stub.state.clipboard || ''), '원문·시각 복사');

  // 보드 전체를 마크다운으로
  panel.send({ type: 'copyBoard' });
  await waitFor(() => /### Waiting for you\n- Deployer: needs approval — `/.test(stub.state.clipboard || ''), '마크다운 복사');
  assert.match(stub.state.clipboard, /\| watch \| Watcher \| Just finished \| 6m ago \| 0 \| 0 \|/);
  assert.match(stub.state.clipboard, /stray\.txt/);
});

test('공유 메모: 파일을 연결하면 보드에 보이고, 파일이 바뀌면 다시 그린다. 그룹에서 빼면 보드와 목록에서 빠진다', async () => {
  const panel = stub.state.panels.find((p) => !p.disposed);
  const memo = path.join(home, 'board.md');
  fs.writeFileSync(memo, '# Ops board\n\n- decide <release> date\n');
  stub.state.openDialog = memo;
  panel.send({ type: 'linkMemo' });
  await waitFor(() => { const x = panel.lastPayload(); return x && x.memo.file === memo; }, '메모 연결');
  assert.match(panel.lastPayload().memo.html, /decide &lt;release&gt; date/, '마크다운을 그릴 수 없으면 글자를 그대로(꺾쇠는 이스케이프)');
  fs.writeFileSync(memo, '# Ops board\n\n- decided: Friday\n');
  await waitFor(() => /decided: Friday/.test(panel.lastPayload().memo.html), '메모 파일이 바뀌면 다시 그림', 9000);

  panel.send({ type: 'remove', sid: SID.v });
  await waitFor(() => panel.lastPayload().members.length === 3, '보드에서 빠짐');
  await waitFor(() => P().mine.some((r) => r.sid === SID.v), '이 폴더 칸으로 돌아옴');
  panel.send({ type: 'unlinkMemo' });
  await waitFor(() => panel.lastPayload().memo.file === '', '메모 연결 끊김');
  assert.ok(fs.existsSync(memo), '연결을 끊어도 메모 파일은 지우지 않는다');
});

test('세션은 그룹 하나에만: 다른 그룹에 넣으면 앞 그룹에서 빠지고 역할은 따라간다. 다른 창이 바꾼 그룹도 반영한다', async () => {
  stub.state.pick = (items) => items.find((i) => /New group/.test(i.label));
  stub.state.input = 'Second';
  web.send({ type: 'group', sid: SID.w });
  await waitFor(() => team('Second') && team('Second').rows.length === 1, '두 번째 그룹');
  assert.ok(!team('Chatbot ops').rows.some((r) => r.sid === SID.w), '앞 그룹에서는 빠짐');
  assert.strictEqual(team('Second').rows[0].role, 'watch', '역할은 함께 옮겨 감');

  // 다른 VS Code 창이 파일을 고친 것처럼(확인 주기 2초 안에 반영)
  const data = JSON.parse(fs.readFileSync(groupsFile(), 'utf8'));
  data.groups.find((g) => g.name === 'Second').name = 'Renamed elsewhere';
  fs.writeFileSync(groupsFile(), JSON.stringify(data));
  await waitFor(() => team('Renamed elsewhere'), '다른 창의 변경', 9000);
});

test('그룹 이름 바꾸기와 지우기: 지우면 세션은 그대로 목록으로 돌아오고 보드는 닫힌다', async () => {
  const id = team('Chatbot ops').id;
  stub.state.input = 'Ops';
  web.send({ type: 'renameGroup', team: id });
  await waitFor(() => team('Ops'), '이름 바뀜');
  const panel = stub.state.panels.find((p) => !p.disposed);
  await waitFor(() => panel.title === 'Board · Ops', '보드 제목도');

  stub.state.answer = (m, b) => (/Delete the group "Ops"/.test(m) ? b.find((x) => x === 'Delete group') : undefined);
  web.send({ type: 'deleteGroup', team: id });
  await waitFor(() => !team('Ops'), '그룹 지워짐');
  assert.ok(panel.disposed, '그 그룹의 보드는 닫힌다');
  assert.ok(P().mine.some((r) => r.sid === SID.d), '세션은 목록으로 돌아온다');
  const warn = stub.calls.find((c) => c[0] === 'warn' && /Delete the group "Ops"/.test(c[1]));
  assert.deepStrictEqual(warn[2][0], { modal: true }, '지우기 전에 확인을 받는다');
});
