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
// 오래전부터 git에 안 올린 채 있는 백업 파일: 보는 기간 밖에 바뀌었으니 "설명되지 않는 변경"에 넣지 않는다
const oldBak = path.join(project, 'settings.json.bak-old');
fs.writeFileSync(oldBak, '{}\n');
fs.utimesSync(oldBak, new Date(now - 30 * 24 * 3600 * 1000), new Date(now - 30 * 24 * 3600 * 1000));
for (const f of [app, path.join(project, 'stray.txt')]) fs.utimesSync(f, new Date(now - 20 * MIN), new Date(now - 20 * MIN));

const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
const SID = { w: 'a0b00000-1111-4111-8111-111111111111', d: 'a0b00000-2222-4222-8222-222222222222', v: 'a0b00000-3333-4333-8333-333333333333', o: 'a0b00000-4444-4444-8444-444444444444', x: 'a0b00000-5555-4555-8555-555555555555' };
// 세션의 답(글), 다른 세션이 보낸 말(isMeta + origin peer), Claude Code가 끼워 넣은 중단 표시·긴 대화 요약
const say = (ts, text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, cwd: project, timestamp: new Date(ts).toISOString() });
const peer = (ts, text) => ({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content: text }, cwd: project, timestamp: new Date(ts).toISOString() });
const summary = (ts) => ({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' }, cwd: project, timestamp: new Date(ts).toISOString() });
fx.claudeSession(home, project, SID.w, [rec.user(project, now - 40 * MIN, 'Watch the other sessions every half hour'), rec.aiTitle(SID.w, 'Watcher'),
  rec.user(project, now - 8 * MIN, 'restart now'), rec.user(project, now - 7 * MIN, '[Request interrupted by user]'), summary(now - 6.5 * MIN),
  rec.user(project, now - 6 * MIN, 'ship it'), say(now - 5.9 * MIN, 'Working on it'), say(now - 5.8 * MIN, '**Shipped.** All good\n\nDetails follow.')]);
fx.claudeSession(home, project, SID.d, [rec.user(project, now - 30 * MIN, 'Prepare the release'), rec.aiTitle(SID.d, 'Deployer'), say(now - 29 * MIN, '## Release prepared.'),
  peer(now - 28 * MIN, 'Another Claude session sent a message: check the logs'), say(now - 27 * MIN, 'Peer handled.'),
  rec.toolUse(project, now - 2 * MIN, 't_rel', 'Bash', { command: 'scripts/release.sh promote' })]);
fx.claudeSession(home, project, SID.v, [rec.user(project, now - 25 * MIN, 'Fix the parser'), rec.aiTitle(SID.v, 'Developer'),
  rec.toolUse(project, now - 21 * MIN, 't_e', 'Edit', { file_path: app, old_string: 'v1', new_string: 'v2' }), rec.toolResult(now - 21 * MIN + 400, 't_e', rec.editResult(app, 'v1\n', 'v1', 'v2')),
  rec.user(project, now - 8 * MIN + 20000, 'restart now')]);
fx.claudeSession(home, other, SID.o, [rec.user(other, now - 10 * MIN, 'Check the other app'), rec.aiTitle(SID.o, 'Outside')]);
fx.claudeSession(home, project, SID.x, [rec.user(project, now - 50 * MIN, 'Something unrelated'), rec.aiTitle(SID.x, 'Loner')]);
// Codex 세션(이 폴더): 내 말과 마지막 답. 하위 스레드(검토 등, 부모가 시킨 말)는 내 말이 아니다
const CXID = 'c0de0000-1111-4111-8111-111111111111';
const cxRec = (t, payload, type = 'response_item') => ({ timestamp: new Date(t).toISOString(), type, payload });
fx.codexSession(home, CXID, [
  cxRec(now - 12 * MIN, { id: CXID, session_id: CXID, cwd: project, originator: 'codex_vscode', source: 'vscode' }, 'session_meta'),
  cxRec(now - 12 * MIN, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for the project' }, { type: 'input_text', text: 'Write the API client' }] }),
  cxRec(now - 11 * MIN, { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Looking at the API first.' }] }),
  cxRec(now - 10 * MIN, { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '**Client written.** Tests pass.' }] }),
], now);
// 12분 전에 끝난 기록(방금 바뀐 Codex 기록은 "작업 중"으로 잡힌다)
for (const f of fs.readdirSync(path.join(home, '.codex', 'sessions'), { recursive: true })) { const p = path.join(home, '.codex', 'sessions', f); if (p.endsWith(CXID + '.jsonl')) fs.utimesSync(p, new Date(now - 10 * MIN), new Date(now - 10 * MIN)); }
fx.codexSession(home, 'c0de0000-2222-4222-8222-222222222222', [
  cxRec(now - 9 * MIN, { id: 'c0de0000-2222-4222-8222-222222222222', session_id: CXID, parent_thread_id: CXID, cwd: project, source: { subagent: 'review' } }, 'session_meta'),
  cxRec(now - 9 * MIN, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review this change for risks' }] }),
], now);
for (const f of fs.readdirSync(path.join(home, '.codex', 'sessions'), { recursive: true })) { const p = path.join(home, '.codex', 'sessions', f); if (p.endsWith('.jsonl')) fs.utimesSync(p, new Date(now - 9 * MIN), new Date(now - 9 * MIN)); }
fx.registerSession(home, process.pid, SID.w, { status: 'idle', cwd: project, name: 'w', nameSource: 'derived', statusUpdatedAt: now - 5 * MIN });
fx.registerSession(home, process.ppid, SID.d, { status: 'waiting', waitingFor: 'permission prompt', cwd: project, name: 'd', nameSource: 'derived', statusUpdatedAt: now - 2 * MIN });
fx.registerSession(home, fx.alivePid(), SID.v, { status: 'busy', cwd: project, name: 'v', nameSource: 'derived', statusUpdatedAt: now - 25 * MIN });
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
// 역할 고르기 창: 목록에서 labels를 체크하고(typed가 있으면 먼저 쳐 넣고) Enter
async function pickRoles(open, labels, typed) {
  stub.state.quickPick = null;
  open();
  const qp = await waitFor(() => stub.state.quickPick && stub.state.quickPick.shown && stub.state.quickPick, '역할 고르기 창');
  if (typed) qp.type(typed);
  qp.selectedItems = qp.items.filter((i) => labels.includes(i.label));
  qp.onDidChangeSelection.fire(qp.selectedItems);
  qp.onDidAccept.fire();
  return qp;
}

test.before(async () => {
  ext._test.setCodexCli(false); // 이 컴퓨터에 codex가 있어도 없는 것으로 시작(도구 묻기는 아래 시험에서 켠다)
  ext.activate(stub.context);
  web = stub.openWebview('claudeSessionChanges.sessions');
  web.send({ type: 'ready' });
  await waitFor(() => P() && P().mine && P().mine.length === 5, '이 폴더 세션 5개(Codex 하나 포함)');
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
  assert.strictEqual(P().openHere, 4, '열린 세션 수는 그룹과 상관없이 이 폴더 기준(꺼진 Loner 빼고 넷: 12분 전에 끝난 Codex 대화는 쉼으로 센다)');

  // 역할: 개발에 흔히 필요한 역할 목록에서 고른다(하는 일이 함께 보임)
  const qp = await pickRoles(() => web.send({ type: 'role', sid: SID.w }), ['Watch']);
  assert.ok(qp.canSelectMany, '여러 개를 고를 수 있다');
  assert.deepStrictEqual(qp.items.slice(0, 11).map((i) => i.label), ['Lead', 'Watch', 'Plan', 'Design', 'Develop', 'Test', 'Review', 'Docs', 'Deploy', 'Security', 'Research']);
  assert.ok(qp.items.every((i) => i.detail), '역할마다 하는 일이 한 줄 보인다');
  await waitFor(() => team('Chatbot ops').rows[0].role === 'Watch', '역할 꼬리표');
});

test('역할 고르기: 여러 개, 직접 친 역할, 체크 없이 친 글자, 모두 빼기', async () => {
  // 목록 + 직접 친 역할을 함께
  let qp = await pickRoles(() => web.send({ type: 'role', sid: SID.w }), ['Watch', 'Docs', 'QA lead'], 'QA lead');
  assert.ok(qp.items.some((i) => i.label === 'QA lead' && i.alwaysShow), '친 글자가 목록에 없으면 "직접 넣기" 줄이 뜬다');
  await waitFor(() => team('Chatbot ops').rows[0].role === 'Watch, Docs, QA lead', '여러 역할');
  assert.ok(!team('Chatbot ops').rows.some((r) => r.lead), '"QA lead"처럼 직접 만든 역할은 대장이 아니다');
  // 다시 열면 지금 역할이 체크되어 있고, 직접 넣은 역할도 목록에 남아 있다
  stub.state.quickPick = null;
  web.send({ type: 'role', sid: SID.w });
  qp = await waitFor(() => stub.state.quickPick && stub.state.quickPick.shown && stub.state.quickPick, '다시 연 창');
  assert.deepStrictEqual(qp.selectedItems.map((i) => i.label), ['Watch', 'Docs', 'QA lead']);
  // 아무것도 체크하지 않고 글자만 친 채 Enter → 친 글자가 역할
  qp.type('Night shift');
  qp.selectedItems = [];
  qp.onDidAccept.fire();
  await waitFor(() => team('Chatbot ops').rows[0].role === 'Night shift', '친 글자 그대로');
  // 모두 빼기 → 역할 없음, 다시 Watch로
  await pickRoles(() => web.send({ type: 'role', sid: SID.w }), []);
  await waitFor(() => team('Chatbot ops').rows[0].role === '', '역할 없음');
  await pickRoles(() => web.send({ type: 'role', sid: SID.w }), ['Watch']);
  await waitFor(() => team('Chatbot ops').rows[0].role === 'Watch', '다시 Watch');
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
  // 보드는 몇 초마다 다시 그려진다: 같은 내용이면 그리지 않고, 공유 메모 칸의 스크롤 위치를 지킨다(11-13 "내리면 자꾸 위로 초기화")
  assert.match(code[1], /if \(json === lastJson\) return;/);
  assert.match(code[1], /data-scroll="memo"/);
  assert.match(code[1], /el\.scrollTop = k\[0\]/);

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
  assert.deepStrictEqual(p.unknown, [path.join(project, 'stray.txt')], '보는 기간 안에 바뀐 것만(30일 된 백업 파일은 뺀다)');
  const out = p.members.find((m) => m.title === 'Outside');
  assert.strictEqual(out.folder, 'other-app');
  assert.strictEqual(out.canOpen, true, '다른 폴더 세션도 누르면 그 폴더 창에서 연다(0.29.0부터)');
  assert.strictEqual(p.members.find((m) => m.title === 'Watcher').role, 'Watch');

  // 지시와 결과: 내가 친 말(최근 것부터) + 세션이 마지막으로 답한 글의 첫 줄. 결정 기록에 쓰는 모양(시각 + 원문 + 세션)으로 복사
  const said = await waitFor(() => { const x = panel.lastPayload(); return x && x.said && x.said.length >= 6 ? x.said : null; }, '지시와 결과', 15000);
  assert.strictEqual(said.length, 6, '같은 말을 두 세션에 보낸 것은 한 줄: ' + said.map((x) => x.text).join(' | '));
  assert.strictEqual(said[0].text, 'ship it', '가장 최근에 한 말이 맨 위');
  assert.match(said[0].stamp, /^\d\d-\d\d \d\d:\d\d:\d\d (KST|UTC[+−]\d+(:\d\d)?)$/);
  assert.strictEqual(said[0].replies[0].reply, 'Shipped. All good', '그 차례의 마지막 답, 첫 줄만, 꾸밈 글자는 걷어 냄');
  assert.ok(!said.some((x) => /Request interrupted|being continued/.test(x.text)), 'Claude Code가 끼워 넣은 말은 내 말이 아니다');
  const restart = said.find((x) => x.text === 'restart now');
  assert.deepStrictEqual([...restart.titles].sort(), ['Developer', 'Watcher'], '두 세션에 보낸 같은 말은 세션을 함께 적는다');
  assert.strictEqual(said.find((x) => x.text === 'Prepare the release').replies[0].reply, 'Release prepared.', '다른 세션이 보낸 말 뒤의 답은 내 말의 답이 아니다');
  assert.ok(!said.some((x) => x.text === 'Something unrelated'), '그룹 밖 세션에 한 말은 넣지 않는다');
  assert.ok(!/copyQuote/.test(panel.webview.html), '복사 단추는 없다(쓸 일이 없어 글 칸을 넓혔다, 11-12 사용자)');
  assert.match(panel.webview.html, /grid-template-columns: 9em 11em minmax\(0, 1fr\)/, '시각·세션 다음 칸이 남는 폭을 다 쓴다');
  assert.match(panel.webview.html, /\.said \.it\.open \.txt/, '누르면 글 전체를 펼친다');

  // 보드 전체를 마크다운으로
  // 세션마다 고유 색, 지시와 결과의 세션 이름은 누르면 그 세션이 열린다
  const pp = panel.lastPayload();
  assert.deepStrictEqual(pp.members.map((m) => m.color), [0, 1, 2, 3], '그룹에 넣은 순서대로 색');
  assert.deepStrictEqual(pp.said.find((x) => x.text === 'restart now').colors.length, 2, '여러 세션에 보낸 말은 세션마다 색');
  assert.match(panel.webview.html, /class="wl" data-act="open" data-sid="/);
  // 한 쪽에 몇 개: 설정을 5로 줄이면 6줄이 두 쪽으로 나뉘고, 다음 쪽으로 넘길 수 있다
  stub.changeConfig('boardPageSize', 5);
  await waitFor(() => panel.lastPayload().saidSize === 5, '쪽 크기 5');
  assert.deepStrictEqual([panel.lastPayload().said.length, panel.lastPayload().saidPages, panel.lastPayload().saidTotal], [5, 2, 6]);
  panel.send({ type: 'saidPage', dir: 'next' });
  await waitFor(() => panel.lastPayload().saidPage === 1, '다음 쪽');
  assert.strictEqual(panel.lastPayload().said.length, 1);
  panel.send({ type: 'saidPage', dir: 'next' });
  await sleep(200);
  assert.strictEqual(panel.lastPayload().saidPage, 1, '마지막 쪽에서 더 넘기지 않는다');
  panel.send({ type: 'saidPage', dir: 'first' });
  await waitFor(() => panel.lastPayload().saidPage === 0, '처음 쪽');
  stub.changeConfig('boardPageSize', 20);
  await waitFor(() => panel.lastPayload().saidSize === 20, '쪽 크기 20');

  // 목차(나를 기다리는 것·세션·지시와 결과·공유 메모)마다 머리줄을 눌러 접고 편다. 접은 칸은 그룹마다 기억하고, 0.24.1에서 접어 둔 지시와 결과도 이어받는다
  assert.strictEqual((panel.webview.html.match(/foldHead\('/g) || []).length, 4, '네 목차에 접기 머리줄');
  assert.match(panel.webview.html, /aria-expanded/);
  assert.deepStrictEqual(panel.lastPayload().folded, {});
  await stub.context.globalState.update('claudeSessionChanges.boardSaidFolded', { [id]: true });
  panel.send({ type: 'refresh' });
  await waitFor(() => panel.lastPayload().folded.said === true, '0.24.1에서 접어 둔 것 이어받기');
  panel.send({ type: 'fold', key: 'said', on: false });
  panel.send({ type: 'fold', key: 'memo', on: true });
  panel.send({ type: 'fold', key: 'sessions', on: true });
  panel.send({ type: 'fold', key: 'not-a-section', on: true });
  panel.send({ type: 'refresh' });
  await waitFor(() => panel.lastPayload().folded.memo === true, '접힘 기억');
  assert.deepStrictEqual(panel.lastPayload().folded, { said: false, memo: true, sessions: true }, '펼친 것도 기억(옛 값이 다시 접지 않게), 없는 칸은 무시');
  assert.ok(panel.lastPayload().said.length > 0, '접어도 내용은 보내 둔다(펼치면 바로 보이게)');
  panel.send({ type: 'fold', key: 'memo', on: false });
  panel.send({ type: 'fold', key: 'sessions', on: false });
  panel.send({ type: 'refresh' });
  await waitFor(() => panel.lastPayload().folded.sessions === false, '펼침 기억');

  panel.send({ type: 'copyBoard' });
  await waitFor(() => /### Waiting for you\n- Deployer: needs approval — `/.test(stub.state.clipboard || ''), '마크다운 복사');
  assert.match(stub.state.clipboard, /\| Watch \| Watcher \| Just finished \| \d+m ago \| 0 \| 0 \|/);
  assert.match(stub.state.clipboard, /stray\.txt/);
  assert.match(stub.state.clipboard, /### Instructions and results\n- \S+ \S+ \S+ · Watcher: "ship it" → Shipped\. All good/);
});

test('역할 안내: 처음 쓰는 사람도 붙여 넣기만 하면 되게 역할·하는 일·동료·규칙을 담아 복사하고, 시작하기 순서를 보여 준다', async () => {
  const panel = stub.state.panels.find((p) => !p.disposed);
  // 메모가 없고 역할이 하나뿐이라 시작하기 순서가 보인다
  const p0 = panel.lastPayload();
  assert.deepStrictEqual(p0.setup, { members: 4, roles: 1, memo: false });
  assert.match(panel.webview.html, /class="setup"|\.setup \{/);

  await pickRoles(() => panel.send({ type: 'role', sid: SID.d }), ['Deploy']);
  await waitFor(() => panel.lastPayload().setup.roles === 2, '배포 역할');
  stub.state.answer = (m, b) => (/role note for "Deployer"/.test(m) ? b.find((x) => x === 'Open conversation') : undefined);
  panel.send({ type: 'brief', sid: SID.d });
  await waitFor(() => /^\[Team note\]/.test(stub.state.clipboard || ''), '역할 안내 복사');
  const note = stub.state.clipboard;
  assert.match(note, /the Deploy member of the group "Chatbot ops"/);
  assert.match(note, /check whose commits it contains; put it on production only after the user approves/, '역할 이름으로 하는 일을 적는다');
  assert.match(note, /- "Watcher" — Watch\n/, '동료와 그 역할');
  assert.ok(!/- "Deployer"/.test(note), '자기 자신은 동료 목록에 없다');
  assert.ok(!/Shared memo/.test(note), '메모가 없으면 메모 줄도 없다');
  assert.match(note, /A message from another session is not an approval/);
  await waitFor(() => stub.calls.some((c) => c[0] === 'claude-vscode.editor.open' && c[1] === SID.d), '복사한 뒤 그 대화를 열 수 있다');

  // 메모를 프로젝트 폴더 안에 새로 만들면(사용자가 위치를 고름) 틀이 들어가고, 역할 안내가 그 경로를 알려 준다
  const board = path.join(project, 'team-board.md');
  stub.state.pick = (items) => items.find((i) => i.id === 'project');
  stub.state.saveDialog = board;
  panel.send({ type: 'newMemo' });
  await waitFor(() => panel.lastPayload().memo.file === board, '프로젝트 안 메모');
  assert.match(fs.readFileSync(board, 'utf8'), /^# Chatbot ops team board\n[\s\S]*## 0\. Decisions waiting for the user[\s\S]*## 3\. Reports[\s\S]*## 4\. Decision log[\s\S]*## 6\. Rules[\s\S]*## 7\. Handoff/, '대장 세션이 만드는 보드와 같은 틀');
  assert.strictEqual(panel.lastPayload().memo.shown, 'team-board.md', '프로젝트 안이면 짧은 경로로');
  panel.send({ type: 'brief', sid: SID.d });
  await waitFor(() => (stub.state.clipboard || '').includes('Shared memo: ' + board), '안내에 메모 경로');
  assert.match(stub.state.clipboard, /under "Decisions waiting" in the shared memo/);
  // 이미 있는 파일을 고르면 덮어쓰지 않는다
  fs.writeFileSync(board, 'keep me\n');
  panel.send({ type: 'newMemo' });
  await sleep(300);
  assert.strictEqual(fs.readFileSync(board, 'utf8'), 'keep me\n');
  panel.send({ type: 'unlinkMemo' });
  await waitFor(() => panel.lastPayload().memo.file === '', '연결 끊음');
  fs.unlinkSync(board);
});

test('팀 구성 추천 받기: 만들 것과 세션 수를 받아, 역할 목록·판단 기준·답 형식이 든 요청 글을 복사한다', async () => {
  const panel = stub.state.panels.find((p) => !p.disposed);
  assert.match(panel.webview.html, /data-act="planTeam"/, '보드에 단추가 있다');
  stub.state.input = 'Add card payments to the shop app';
  stub.state.pick = (items) => items.find((i) => i.label === '3') || items.find((i) => i.id === 'claude'); // 세션 수 3, 도구 Claude Code
  stub.state.answer = (m, b) => (/lead session request/.test(m) ? b.find((x) => x === 'Open a new Claude Code session') : undefined);
  const opened = stub.calls.filter((c) => c[0] === 'claude-vscode.editor.open' && c.length === 1).length;
  panel.send({ type: 'planTeam' });
  await waitFor(() => /^\[Lead session request\]/.test(stub.state.clipboard || ''), '요청 글 복사');
  const t = stub.state.clipboard;
  assert.match(t, /Please be the lead for this work\. From now on the user talks only to this session/, '붙여 넣은 세션이 대장이 된다');
  assert.match(t, /What I will build: Add card payments to the shop app/);
  assert.match(t, /Sessions available \(including this lead\): 3/);
  for (const step of ['## Step 1: recommend the team', '## Step 2: create the team board', '## Step 3: start the working sessions', '## Step 4: work as the lead']) assert.ok(t.includes(step), step);
  assert.match(t, /```markdown\n# <project name> team board\n[\s\S]*## 0\. Decisions waiting for the user[\s\S]*## 7\. Handoff[\s\S]*```/, '보드 틀을 통째로 넣는다');
  assert.match(t, /Link a file" on the group board/, 'Session Watchtower 보드에 연결하라고 알린다');
  assert.match(t, /Do only step 1 now\./);
  assert.match(t, /The lead and the deployer are fixed roles\. The roles of the other working sessions/, '대장·배포는 고정, 나머지는 유동');
  assert.match(t, /update the role column of section 1 "Sessions and roles"/, '역할을 바꾸면 보드 1절을 고친다');
  assert.match(t, /Never have a session review or test its own change/);
  assert.match(t, /Sessions already in the group "Chatbot ops"[^\n]*:\n- "Watcher" — Watch\n/, '보드에서 열면 그 그룹의 세션과 역할을 넣는다');
  for (const r of ['Lead', 'Watch', 'Plan', 'Design', 'Develop', 'Test', 'Review', 'Docs', 'Deploy', 'Security', 'Research']) assert.match(t, new RegExp('\\n- ' + r + ': \\S'), '역할 목록과 하는 일: ' + r);
  assert.match(t, /Only one session deploys/);
  assert.match(t, /a table: session name \| role \| what it does \| first step/);
  assert.match(t, /do not create or change files in this step/);
  // 팀 문서 4종: 1단계 답에 있음·없음 표, 없는 것만 사용자 승인 뒤 틀로(체크리스트는 맨 위에 진행 점수표)
  assert.match(t, /\(5\) whether the four team documents exist \(plan, design, development checklist, test checklist; a file with another name that does the same job counts\)/);
  assert.ok(t.includes('## Step 2.1: team documents (only those the user agreed to in step 1 (5))'));
  assert.match(t, /Create documents only after the user approves; use existing ones as they are/);
  assert.match(t, /# <project name> development checklist\nDocuments: [^\n]*\n\n<!-- progress-scoreboard:begin -->\n## Progress scoreboard\n\n\*\*Passed 0 \/ 0 \(0%\)\*\* `░{10}`/, '개발 체크리스트 맨 위가 진행 점수표(자동으로 다시 쓰는 구간 표시 안)');
  assert.match(t, /you also create a short script that rewrites it[^\n]*with --check fails when the table is out of date/, '점수표를 다시 쓰는 스크립트도 함께 만들게');
  assert.ok(t.includes('Documents: plan <path> · design <path> · development checklist <path> · test checklist <path>'), '보드 제목 아래 문서 줄');
  await waitFor(() => stub.calls.filter((c) => c[0] === 'claude-vscode.editor.open' && c.length === 1).length > opened, '새 세션 열기');

  // 그룹 없이(세션 창 메뉴에서)도 된다
  stub.state.input = 'Fix the login bug';
  stub.state.pick = (items) => items[0];
  stub.state.answer = undefined;
  const text = await stub.commands.get('claudeSessionChanges.planTeam')();
  assert.match(text, /Sessions available \(including this lead\): up to your recommendation/);
  assert.ok(!/Sessions already in the group/.test(text), '그룹이 없으면 그 줄도 없다');
  assert.match(text, /Tool: Claude Code\n/);
  assert.ok(stub.calls.some((c) => c[0] === 'pick' && /Which tool/.test((c[2] || {}).placeHolder || '')), 'Codex 세션 기록이 있으면 어느 도구로 할지 묻는다');

  // Codex를 쓰는 사람: 도구를 묻고, "둘 다"면 표에 도구 칸과 메모로 주고받으라는 기준이 들어간다. Codex는 터미널에서 연다
  ext._test.setCodexCli(true);
  stub.state.input = 'Split the API and the web client';
  stub.state.pick = (items) => items.find((i) => i.id === 'both') || items[0];
  stub.state.answer = (m, b) => (/lead session request/.test(m) ? b.find((x) => x === 'Open Codex in a terminal') : undefined);
  const both = await stub.commands.get('claudeSessionChanges.planTeam')();
  assert.match(both, /Tool: Claude Code and Codex\n/);
  assert.match(both, /session name \| tool \(Claude Code or Codex\) \| role/);
  assert.match(both, /cannot message each other directly/);
  const term = await waitFor(() => stub.calls.filter((c) => c[0] === 'terminal').map((c) => c[1]).find((t) => t.opts.name === 'Codex'), 'Codex 터미널');
  assert.deepStrictEqual(term.sent, ['codex']);
  ext._test.setCodexCli(false);
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

test('Codex 세션도 그룹에: 지시와 결과에 Codex에 한 말·답이 나오고, 역할 안내는 Codex 동료와 섞인 그룹의 규칙을 알려 준다', async () => {
  const panel = stub.state.panels.find((p) => !p.disposed);
  stub.state.pick = (items) => items.filter((i) => i.label === 'Write the API client');
  panel.send({ type: 'add' });
  await waitFor(() => panel.lastPayload().members.some((m) => m.sid === 'codex:' + CXID), 'Codex 세션이 들어감');
  const said = await waitFor(() => { const x = panel.lastPayload().said || []; return x.some((r) => r.text === 'Write the API client') ? x : null; }, 'Codex에 한 말', 15000);
  const row = said.find((r) => r.text === 'Write the API client');
  assert.strictEqual(row.replies[0].reply, 'Client written. Tests pass.', 'Codex의 마지막 답(최종 답) 첫 줄');
  assert.ok(!said.some((r) => /AGENTS\.md|Review this change/.test(r.text)), 'Codex가 끼워 넣은 글과 하위 스레드의 말은 뺀다');
  panel.send({ type: 'brief', sid: SID.d });
  await waitFor(() => /\(Codex\)/.test(stub.state.clipboard || ''), '역할 안내');
  assert.match(stub.state.clipboard, /- "Write the API client" \(Codex\)/);
  assert.match(stub.state.clipboard, /mixes Claude Code and Codex sessions, which cannot message each other directly\. Ask the user to pass things on\./);
});

test('유동 역할: 보드의 "세션과 역할" 표가 역할을 정하고(손으로 정한 역할보다 앞섬), 바뀌면 따라가며, 배포가 둘이면 경고한다', async () => {
  const panel = stub.state.panels.find((p) => !p.disposed);
  const memo = path.join(home, 'team-board.md');
  const board = (watcherRole) => ['# Team board', '', '## 1. Sessions and roles (the lead and the deployer are fixed)', '| Role | Session name | Scope | Doing now |', '|---|---|---|---|',
    `| ${watcherRole} | **Watcher** [ab12cd] | e2e/ | checking |`, '| Deploy | Deployer (address x) | | |', '| Release | Outside | | |', '| Docs | **Loner** | | |', '| Research | **Ghost session** | | |', '| <role> | <session name> | | |', '', '## 2. Tasks', ''].join('\n');
  fs.writeFileSync(memo, board('Test'));
  stub.state.openDialog = memo;
  panel.send({ type: 'linkMemo' });
  const p = await waitFor(() => { const x = panel.lastPayload(); return x && x.memo.file === memo ? x : null; }, '보드 연결');
  const role = (t) => p.members.find((m) => m.title === t);
  assert.deepStrictEqual([role('Watcher').role, role('Watcher').roleFromBoard], ['Test', true], '보드가 손으로 정한 Watch보다 앞선다');
  assert.deepStrictEqual([role('Deployer').role, role('Outside').role], ['Deploy', 'Release']);
  assert.deepStrictEqual([role('Write the API client').role, role('Write the API client').roleFromBoard], ['', false], '보드 표에 없는 세션은 손으로 정한 역할');
  assert.match(p.warnings.join(' '), /More than one session has the deploy role: Deployer, Outside\./, '배포가 둘이면 경고');
  assert.deepStrictEqual([team('Chatbot ops').rows.find((r) => r.sid === SID.w).role, team('Chatbot ops').rows.find((r) => r.sid === SID.w).roleFromBoard], ['Test', true], '세션 창 꼬리표도 보드를 따른다');

  // 보드와 그룹 맞추기: 보드 표에만 있는 세션(Loner는 이 컴퓨터에 있음, Ghost는 없음), 그룹에만 있는 세션(Codex)
  assert.deepStrictEqual(p.sync.boardOnly.map((x) => [x.name, x.role, !!x.sid]), [['Loner', 'Docs', true], ['Ghost session', 'Research', false]]);
  assert.deepStrictEqual(p.sync.groupOnly.map((x) => x.title), ['Write the API client']);
  panel.send({ type: 'copyBoardSync' });
  await waitFor(() => /^\[Board sync\]/.test(stub.state.clipboard || ''), '대장에게 보낼 글');
  assert.match(stub.state.clipboard, /- \*\*Write the API client\*\*/);
  assert.match(stub.state.clipboard, /- Ghost session — Research/);
  panel.send({ type: 'addFromBoard', sid: SID.x });
  await waitFor(() => team('Chatbot ops').rows.some((r) => r.sid === SID.x && r.role === 'Docs' && r.roleFromBoard), '보드에만 있던 세션을 그룹에 넣으면 보드 역할로 보인다');
  await waitFor(() => panel.lastPayload().sync.boardOnly.length === 1, '이제 보드에만 있는 것은 Ghost 하나');
  panel.send({ type: 'remove', sid: SID.x }); // 다음 시험을 위해 되돌림
  await waitFor(() => !team('Chatbot ops').rows.some((r) => r.sid === SID.x), 'Loner 뺌');

  // 역할 안내는 보드의 역할로, 유동 역할 규칙과 자기 검토 금지를 함께
  panel.send({ type: 'brief', sid: SID.w });
  await waitFor(() => /the Test member/.test(stub.state.clipboard || ''), '보드 역할로 만든 안내');
  assert.match(stub.state.clipboard, /Test what changed and report the results/);
  assert.match(stub.state.clipboard, /Apart from the lead and the deployer, roles are not fixed/);
  assert.match(stub.state.clipboard, /Do not review or test a change you made yourself/);

  // 대장이 보드에서 역할을 바꾸면 보드 화면을 열지 않아도 세션 창이 따라간다(확인 주기 2초)
  fs.writeFileSync(memo, board('Review'));
  panel.send({ type: 'refresh' }); // 보드 화면이 먼저 새 파일을 읽어도(0.21.0에서 세션 창이 안 바뀌던 경우) 세션 창은 따라가야 한다
  await waitFor(() => team('Chatbot ops').rows.find((r) => r.sid === SID.w).role === 'Review', '세션 창이 바뀐 역할을 따름', 15000);
  await waitFor(() => panel.lastPayload().members.find((m) => m.title === 'Watcher').role === 'Review', '보드 화면도', 15000);
  // 역할 고르기 창은 보드가 정한 역할이 앞선다고 알려 준다
  stub.state.quickPick = null;
  web.send({ type: 'role', sid: SID.w });
  const qp = await waitFor(() => stub.state.quickPick && stub.state.quickPick.shown && stub.state.quickPick, '역할 고르기 창');
  assert.match(qp.title, /the team board says "Review"/);
  qp.hide();

  panel.send({ type: 'unlinkMemo' });
  await waitFor(() => team('Chatbot ops').rows.find((r) => r.sid === SID.w).role === 'Watch', '보드를 끊으면 손으로 정한 역할로', 15000);
});

test('보드 표를 못 읽으면 알리고 표 고치기 글을 주며, 보드 표가 배포 담당을 옮기면 확인할 때까지 알린다. 대장 안내는 지시마다 "지금 하는 일" 칸을 고치라고 한다', async () => {
  const panel = stub.state.panels.find((p) => !p.disposed);
  const memo = path.join(home, 'roles-board.md');
  // 표가 없는 보드: 꼬리표가 손으로 정한 역할로 돌아간 것을 알리고, 대장에게 줄 고치기 글(확장이 읽는 모양)을 준다
  fs.writeFileSync(memo, '# Team board\n\nNothing here yet.\n');
  stub.state.openDialog = memo;
  panel.send({ type: 'linkMemo' });
  const p1 = await waitFor(() => { const x = panel.lastPayload(); return x && x.memo.file === memo ? x : null; }, '보드 연결');
  assert.strictEqual(p1.tableMissing, true, '표를 못 읽음');
  assert.strictEqual(p1.deployMoved, null, '표를 못 읽는 동안은 배포 이동을 보지 않는다');
  assert.match(p1.strings.tableMissing, /cannot be read, so the role tags show the roles set by hand/);
  panel.send({ type: 'copyTableFix' });
  await waitFor(() => /^\[Board sync\] Session Watchtower cannot read the "Sessions and roles" table/.test(stub.state.clipboard || ''), '표 고치기 글');
  assert.match(stub.state.clipboard, /\n## 1\. Sessions and roles\n\| Role \| Session name \| Scope \(folders, files\) \| Doing now \(one line\) \|\n/);
  assert.match(stub.state.clipboard, /\| Watch \| \*\*Watcher\*\* \| \| \|/, '세션 제목을 굵게, 지금 역할을 채워서');
  // 보드 표가 배포를 Deployer → Watcher로 옮김: 처음 본 배포는 기억만, 옮기면 보드에 경고와 알림(한 번), 확인하면 사라짐
  const table = (dep, other) => ['# Team board', '', '## 1. Sessions and roles', '| Role | Session name |', '|---|---|', `| Deploy | **${dep}** |`, `| Review | **${other}** |`, '| Docs | **Outside** |', ''].join('\n');
  fs.writeFileSync(memo, table('Deployer', 'Watcher'));
  panel.send({ type: 'refresh' });
  await waitFor(() => { const x = panel.lastPayload(); return x.tableMissing === false && x.members.find((m) => m.title === 'Deployer').role === 'Deploy' ? x : null; }, '표 읽힘');
  assert.strictEqual(panel.lastPayload().deployMoved, null, '처음 본 배포는 그대로 기억');
  stub.calls.length = 0;
  fs.writeFileSync(memo, table('Watcher', 'Deployer'));
  panel.send({ type: 'refresh' });
  const mv = await waitFor(() => panel.lastPayload().deployMoved, '배포 이동 경고');
  assert.deepStrictEqual([mv.from, mv.to], ['Deployer', 'Watcher']);
  await waitFor(() => stub.calls.filter((c) => c[0] === 'warn' && /^Group "Chatbot ops": the deploy role moved from Deployer to Watcher\. Check that the user approved this change/.test(c[1])).length === 1, '보드를 안 봐도 한 번 알림', 15000);
  panel.send({ type: 'ackDeploy' });
  await waitFor(() => panel.lastPayload().deployMoved === null, '확인하면 사라짐');
  // 대장 안내: 지시를 보낼 때마다 표의 "지금 하는 일" 칸도
  await pickRoles(() => web.send({ type: 'role', sid: SID.w }), ['Lead']);
  stub.state.clipboard = '';
  panel.send({ type: 'brief', sid: SID.w });
  await waitFor(() => /Handing out roles/.test(stub.state.clipboard || ''), '대장 역할 안내');
  assert.match(stub.state.clipboard, /Each time you send an instruction to a working session, update that session's "Doing now" cell/);
  await pickRoles(() => web.send({ type: 'role', sid: SID.w }), ['Watch']);
  panel.send({ type: 'unlinkMemo' });
  await waitFor(() => panel.lastPayload().memo.file === '', '연결 끊음');
});

test('대장: 그룹에 하나뿐인 고정 지위라 왕관 배지로 맨 위에 보이고, 보드 표에 덮이지 않으며, 옮기면 앞 대장은 풀린다', async () => {
  const panel = stub.state.panels.find((p) => !p.disposed);
  const rows = () => team('Chatbot ops').rows;
  // 감시(Watcher)를 대장으로: 세션 창과 보드에서 맨 위, 대장 칸
  await pickRoles(() => web.send({ type: 'role', sid: SID.w }), ['Lead', 'Watch']);
  await waitFor(() => rows()[0].sid === SID.w && rows()[0].lead, '세션 창 맨 위에 대장');
  assert.strictEqual(rows()[0].role, 'Watch', '대장이 함께 맡은 일은 배지 옆에');
  assert.ok(rows().slice(1).every((r) => !r.lead), '대장은 하나');
  const p1 = await waitFor(() => { const x = panel.lastPayload(); return x && x.lead && x.lead.sid === SID.w ? x : null; }, '보드 대장 칸');
  assert.strictEqual(p1.members[0].sid, SID.w, '보드 표에서도 맨 위');
  assert.match(panel.webview.html, /class="leadcard"/);

  // 보드 표가 감시를 다른 역할로 적어도 대장 표시는 그대로(대장은 보드에 덮이지 않는 고정 지위)
  const memo = path.join(home, 'lead-board.md');
  fs.writeFileSync(memo, ['## 1. Sessions and roles', '| Role | Session name |', '|---|---|', '| Test | **Watcher** |', ''].join('\n'));
  stub.state.openDialog = memo;
  panel.send({ type: 'linkMemo' });
  await waitFor(() => rows()[0].sid === SID.w && rows()[0].lead && rows()[0].role === 'Test' && rows()[0].roleFromBoard, '대장 + 보드의 역할');
  panel.send({ type: 'brief', sid: SID.w });
  await waitFor(() => /This session is the lead of the group "Chatbot ops" \(also: Test\)/.test(stub.state.clipboard || ''), '대장 역할 안내');
  assert.match(stub.state.clipboard, /Set up the team and keep the team board/, '대장이 하는 일');
  panel.send({ type: 'unlinkMemo' });
  await waitFor(() => panel.lastPayload().memo.file === '', '보드 연결 끊음');

  // 다른 세션을 대장으로 고르면 대장이 옮겨 가고 앞 대장의 "대장"은 지워진다
  await pickRoles(() => web.send({ type: 'role', sid: SID.d }), ['Lead']);
  await waitFor(() => rows()[0].sid === SID.d && rows()[0].lead, '대장이 옮겨 감');
  assert.strictEqual(rows().find((r) => r.sid === SID.w).role, 'Watch', '앞 대장은 대장만 빠지고 맡은 일은 남는다');
  assert.ok(!rows().find((r) => r.sid === SID.w).lead);
  // 대장을 빼면 대장 자리가 빈다
  await pickRoles(() => web.send({ type: 'role', sid: SID.d }), ['Deploy']);
  await waitFor(() => rows().every((r) => !r.lead), '대장 없음');
  await waitFor(() => panel.lastPayload().lead === null, '보드 대장 칸 없음');
});

test('팀 명단 파일: 대장이 읽도록 그룹마다 명단(대장 먼저·굵은 이름·도구·상태·메시지 주소·역할)을 쓰고, 빠지고 들어온 세션을 적는다. 대장 역할 안내에 명단과 역할 나누기 규칙이 들어간다', async () => {
  const g = team('Chatbot ops');
  const file = path.join(stub.context.globalStorageUri.fsPath, 'teams', g.id + '.md');
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  // 앞 시험들에서 Developer를 뺐고(공유 메모), Loner를 보드에서 넣었다(유동 역할)
  await waitFor(() => /"Loner" joined/.test(read()) && /"Developer" left/.test(read()), '들어오고 빠진 기록');
  assert.match(read(), /^# Team roster: Chatbot ops\n\nLast changed: \d{4}-\d\d-\d\d \d\d:\d\d\n/);
  assert.match(read(), /\| Session name \| Tool \| State \| Message address \| Role \| Session ID \|/);
  assert.match(read(), /\| \*\*Watcher\*\* \| Claude Code \| [^|]+ \| w \| /, '실행 중인 세션은 메시지 주소를 적는다');
  // 대장을 정하면 명단 맨 위, 대장 역할 안내에 명단 경로와 역할 나누기 규칙
  await pickRoles(() => web.send({ type: 'role', sid: SID.w }), ['Lead']);
  await waitFor(() => /\| Role \| Session ID \|\n\|---\|---\|---\|---\|---\|---\|\n\| \*\*Watcher\*\* \|[^\n]*\| Lead \|/.test(read()), '대장이 맨 위');
  const panel = stub.state.panels.find((p) => !p.disposed);
  panel.send({ type: 'brief', sid: SID.w });
  await waitFor(() => /Handing out roles/.test(stub.state.clipboard || ''), '대장 역할 안내');
  const brief = stub.state.clipboard;
  assert.ok(brief.includes('Team roster: ' + file), '명단 경로');
  assert.match(brief, /When a new session appears in the roster, add a row and give it a role and a first instruction/);
  assert.match(brief, /if the roster shows a message address, message it by that name/);
  assert.ok(brief.includes('No shared memo is linked yet. Write the full path of the board file you use (or a new one you create) on one line in ' + file.replace(/\.md$/, '.memo')), '메모가 없으면 연결 요청 파일로 직접 연결하라고');
  assert.match(brief, /Right now: read the team roster, link the board you use or create one from the template above/);
  // 메모가 없는 대장은 보드를 새로 만들 수 있으므로 틀을 같이 받는다(11-16 틀 없이 만든 보드에서 결정 대기가 중간에 묻힘)
  assert.ok(brief.includes('## 0. Decisions waiting for the user (the user only needs this section)'), '틀: 사용자 결정 대기가 맨 위');
  assert.ok(brief.indexOf('## 0. Decisions waiting') < brief.indexOf('## 1. Sessions and roles') && brief.indexOf('## 1. Sessions and roles') < brief.indexOf('## 7. Handoff'), '절 순서 그대로');
  assert.match(brief, /Do not change the section numbers, names or order/);
  assert.match(brief, /8\. Keep this board to short status lines\. Put long text such as research results or designs in separate files/);
  assert.ok(brief.includes('# Chatbot ops team board'), '틀 제목은 그룹 이름');
  assert.match(brief, /Team documents: look once in the project folder for a plan, a design, a development checklist and a test checklist/, '대장은 팀 문서 4종을 찾아보고 없으면 한 번만 추천');
  assert.match(brief, /do not ask again after the user says no/);
  // 대장이 연결 요청 파일에 보드 경로를 쓰면 확장이 공유 메모로 연결하고 요청 파일을 지운다. 잘못된 경로는 연결하지 않고 명단에 적는다
  const req = file.replace(/\.md$/, '.memo');
  fs.writeFileSync(req, '/no/such/board.md\n');
  await waitFor(() => !fs.existsSync(req) && /Last link request: Not linked/.test(read()), '잘못된 경로는 연결 안 함', 15000);
  const leadBoard = path.join(home, 'lead-made-board.md');
  fs.writeFileSync(leadBoard, ['## 1. Sessions and roles', '| Role | Session name |', '|---|---|', '| Lead | **Watcher** |', '| Review | **Deployer** |', ''].join('\n'));
  fs.writeFileSync(req, '"' + leadBoard + '"\n');
  await waitFor(() => !fs.existsSync(req) && panel.lastPayload().memo.file === leadBoard, '대장이 보드를 연결', 15000);
  assert.ok(stub.calls.some((c) => c[0] === 'info' && /the lead linked lead-made-board\.md as the shared memo/.test(c[1])), '사용자에게 알림');
  await waitFor(() => /Shared memo \(board\): .*lead-made-board\.md/.test(read()) && /Last link request: Shared memo linked/.test(read()), '명단에도');
  await waitFor(() => team('Chatbot ops').rows.some((r) => r.sid === SID.d && r.role === 'Review' && r.roleFromBoard), '연결한 보드의 표로 역할이 붙는다');
  // 메모가 연결된 뒤의 대장 안내에는 틀이 없다(이미 쓰는 보드를 따른다)
  stub.state.clipboard = '';
  panel.send({ type: 'brief', sid: SID.w });
  await waitFor(() => /Handing out roles/.test(stub.state.clipboard || ''), '메모 연결 뒤 대장 역할 안내');
  assert.ok(!stub.state.clipboard.includes('New board template') && !stub.state.clipboard.includes('```markdown'), '틀은 메모가 없을 때만');
  assert.match(stub.state.clipboard, /Team documents: look once in the project folder/, '팀 문서 확인은 메모가 있어도');
  panel.send({ type: 'unlinkMemo' });
  await waitFor(() => panel.lastPayload().memo.file === '', '연결 끊음');
  panel.send({ type: 'brief', sid: SID.d });
  await waitFor(() => /This session is .*member of the group/.test(stub.state.clipboard || ''), '작업 세션 역할 안내');
  assert.ok(!/Handing out roles/.test(stub.state.clipboard), '역할 나누기는 대장 안내에만');
  await pickRoles(() => web.send({ type: 'role', sid: SID.w }), ['Watch']);
  await waitFor(() => !/\| Lead \|/.test(read()), '대장 풀림');
});

test('세션은 그룹 하나에만: 다른 그룹에 넣으면 앞 그룹에서 빠지고 역할은 따라간다. 다른 창이 바꾼 그룹도 반영한다', async () => {
  stub.state.pick = (items) => items.find((i) => /New group/.test(i.label));
  stub.state.input = 'Second';
  web.send({ type: 'group', sid: SID.w });
  await waitFor(() => team('Second') && team('Second').rows.length === 1, '두 번째 그룹');
  assert.ok(!team('Chatbot ops').rows.some((r) => r.sid === SID.w), '앞 그룹에서는 빠짐');
  assert.strictEqual(team('Second').rows[0].role, 'Watch', '역할은 함께 옮겨 감');

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
  await waitFor(() => !fs.existsSync(path.join(stub.context.globalStorageUri.fsPath, 'teams', id + '.md')), '지운 그룹의 명단 파일도 지운다');
  const warn = stub.calls.find((c) => c[0] === 'warn' && /Delete the group "Ops"/.test(c[1]));
  assert.deepStrictEqual(warn[2][0], { modal: true }, '지우기 전에 확인을 받는다');
});

test('팀 문서 틀: 체크리스트 둘은 제목·문서 줄 바로 아래가 진행 점수표, 막대는 10칸, 숫자 열은 오른쪽 정렬, 테스트 체크리스트에는 시험 층 표', () => {
  for (const ko of [true, false]) {
    const tpl = ext._test.teamDocTemplates(ko);
    const parts = tpl.split(/\n(?=<!-- (?!progress-scoreboard))/); // 문서 머리 주석으로 나눈다(점수표 구간 표시는 빼고)
    assert.strictEqual(parts.length, 4, '문서 넷');
    const [plan, design, dev, test] = parts;
    const board = ko ? '## 진행 점수표' : '## Progress scoreboard';
    for (const doc of [dev, test]) {
      const lines = doc.split('\n');
      assert.strictEqual(lines[3], '', '제목·문서 줄 다음 빈 줄');
      assert.strictEqual(lines[4], '<!-- progress-scoreboard:begin -->', '점수표 스크립트가 다시 쓰는 구간의 시작');
      assert.strictEqual(lines[5], board, '맨 위가 진행 점수표');
      assert.ok(doc.indexOf('<!-- progress-scoreboard:end -->') > doc.indexOf(board), '구간의 끝');
      for (const bar of doc.match(/`[█░]+`/g)) assert.strictEqual([...bar.slice(1, -1)].length, 10, '막대는 10칸');
      assert.ok(doc.includes('|---|---|---:|---:|---:|---:|---:|---:|'), '숫자 열 오른쪽 정렬');
    }
    assert.ok(!plan.includes(board) && !design.includes(board), '기획서·설계서에는 점수표가 없다');
    assert.match(test, ko ? /\| 자동 시험 \|[\s\S]*\| 실제 환경 \|[\s\S]*\| 사람 확인 \|/ : /\| Automated tests \|[\s\S]*\| Real environment \|[\s\S]*\| Human check \|/, '시험 층');
    assert.match(test, ko ? /층끼리 서로 대신하지 않습니다/ : /One layer never stands in for another/);
  }
});
