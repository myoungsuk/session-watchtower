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
  // 시험 폴더가 임시 폴더 아래일 수 있어 숨김을 끈다. 주기 확인(2초)으로 화면이 스스로 바뀌는지도 본다
  config: { hideScratchpadFiles: false, attentionMarkerDir: markers, pollSeconds: 2 },
});
const ext = require('../extension.js'); // 홈 폴더·가짜 vscode 를 준비한 뒤에 불러야 한다

const now = Date.now();
const MIN = 60000;
const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SID_OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';
const SID_REST = 'cccccccc-3333-4333-8333-333333333333';
const SID_GONE = 'abababab-7777-4777-8777-777777777777';
const HOUR = 60 * 60000;
const other = path.join(home, 'work', 'other-app');
const fEdit = path.join(project, 'app.js');
const fNew = path.join(project, 'new.js');
const fBash = path.join(project, 'README.md');
const fGuess = path.join(project, 'notes.txt');
const fGone = path.join(project, 'gone.js');
const fRest = path.join(project, 'rest.js');
fs.mkdirSync(other, { recursive: true });
// 파일은 10분 전에 마지막으로 바뀐 것으로 둔다(방금 만든 파일은 "지금 고치는 중"으로 잡힌다)
for (const f of [fEdit, fNew, fBash, fGuess, fRest]) { fs.writeFileSync(f, 'x\n'); fs.utimesSync(f, new Date(Date.now() - 600000), new Date(Date.now() - 600000)); }

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
  // 마지막 응답에 15만 토큰이 들어갔다(대화 크기 고리 시험용)
  (() => { const r = rec.toolUse(other, now - 14 * MIN, 't_o', 'Write', { file_path: path.join(other, 'o.txt'), content: 'o\n' }); r.message.usage = { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: 148000, output_tokens: 1000 }; r.message.model = 'claude-opus-4-6'; return r; })(),
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
  assert.ok(g && g.rows[0].canOpen === true && g.rows[0].state === 'idle', '다른 폴더 세션도 누를 수 있다(그 폴더 창에서 연다)');
  // 대화 크기: 15만 ÷ 기준. 시험 홈에는 설정이 없어 그 모델(Opus 4.6, 200k 창)의 기본 압축 지점과 비교한다
  assert.deepStrictEqual([g.rows[0].ctx.pct, g.rows[0].ctx.level], [75, 'mid']);
  assert.strictEqual(g.rows[0].ctx.tip, 'Conversation size 150k / 200k (75%) · default auto-compact point for claude-opus-4-6');
  assert.strictEqual(g.rows[0].ctx.text, '150k / 200k');
  assert.match(g.rows[0].tip, /Conversation size 150k/, '줄 설명에도 나온다');
  assert.strictEqual(a.ctx, null, '응답 토큰 기록이 없는 세션은 대화 크기 구역에 나오지 않는다');
  assert.match(web.view.description, /Working 1 · Waiting 0 · Idle 1/, '머리말은 이 폴더 세션만 센다');
  assert.deepStrictEqual([web.lastPayload().openHere, web.lastPayload().openElsewhere], [2, 1], '열린 세션 단추의 숫자도 이 폴더만(다른 폴더는 따로)');
  const str = web.lastPayload().strings;
  assert.ok(/\{0\}.*\{1\}/.test(str.activeTip) && /\{0\}/.test(str.worktreeTip) && !/undefined/.test(JSON.stringify(str)), '화면에서 채울 자리표시자가 그대로 넘어가야 함');
});

test('설정 contextSize를 끄면 대화 크기를 보내지 않고, 켜면 다시 보낸다', async () => {
  const ctxOf = () => (web.lastPayload().groups || []).flatMap((g) => g.rows).find((r) => r.sid === SID_OTHER).ctx;
  assert.ok(ctxOf(), '기본은 켜짐');
  stub.changeConfig('contextSize', false);
  await waitFor(() => ctxOf() === null, '끄면 대화 크기 없음');
  assert.doesNotMatch((web.lastPayload().groups || []).flatMap((g) => g.rows).find((r) => r.sid === SID_OTHER).tip, /Conversation size/, '줄 설명에서도 빠진다');
  stub.changeConfig('contextSize', true);
  await waitFor(() => ctxOf() && ctxOf().pct === 75, '켜면 다시');
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
  assert.match(web.view.webview.html, /\.deep\[hidden\]\s*\{\s*display:\s*none/, '칸을 비우면 "대화 내용·답에서 찾기" 줄이 숨는다(display: block이 hidden을 이기지 않게)');
  // 대화 크기는 세션 창이 아니라 따로 있는 "대화 크기" 창에 나온다(세션 줄에 고리 없음, 세션 창 안에 구역 없음)
  assert.doesNotMatch(m[1], /function ring\(|function ctxSection\(|class="crow/, '세션 창에는 대화 크기를 그리지 않는다');
});

test('상태 표시줄 대화 크기: 사용량 바로 오른쪽, 열린 세션 중 가장 찬 값, 마우스를 올리면 세션마다 표, 누르면 골라 열기, 설정으로 끔', async () => {
  // 프로세스가 없는(끝난) 세션: 마지막 응답 19만 토큰(95%). 열린 세션만 세므로 빠져야 한다(다른 시험의 목록 순서를 건드리지 않게 여기서만 만들고 끝에 지운다)
  const refresh = () => stub.commands.get('claudeSessionChanges.refresh')();
  const goneFile = fx.claudeSession(home, project, SID_GONE, [
    rec.user(project, now - 50 * MIN, 'A finished chat'),
    rec.aiTitle(SID_GONE, 'Finished chat'),
    (() => { const r = rec.toolUse(project, now - 49 * MIN, 't_g', 'Read', { file_path: fEdit }); r.message.usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 189990, output_tokens: 0 }; r.message.model = 'claude-opus-4-6'; return r; })(),
  ]);
  await refresh();
  await waitFor(() => web.lastPayload().mine.some((r) => r.sid === SID_GONE), '끝난 세션 읽기');
  const gone = web.lastPayload().mine.find((r) => r.sid === SID_GONE);
  assert.ok(gone && !gone.alive && gone.ctx && gone.ctx.pct === 95, '끝난 세션도 값은 있다(95%)');
  const item = stub.statusItems.find((x) => x.id === 'claudeSessionChanges.context');
  const usageItem = stub.statusItems.find((x) => x.id === 'claudeSessionChanges.usage');
  assert.ok(item && item.priority < usageItem.priority && usageItem.priority - item.priority < 0.001, '사용량 바로 오른쪽');
  await waitFor(() => item.visible && item.text, '대화 크기 항목');
  assert.strictEqual(item.text, '$(comment-discussion) 75%', '끝난 세션(95%)이 아니라 열린 세션 중 가장 찬 값');
  assert.strictEqual(item.backgroundColor, undefined, '80% 넘은 열린 세션이 없으면 색 없음');
  const md = item.tooltip.value;
  assert.match(md, /\| Session \| Full \| Used \/ point \|\n\|---\|---\|--:\|\n/, '머리줄에 칸 이름(빈칸 없음)');
  const BAR = (c, k) => `<span style="background-color:${c};">${'&nbsp;'.repeat(k)}</span>`;
  assert.ok(md.includes('| Other folder work · other\\-app | ' + BAR('var(--vscode-progressBar-background)', 15) + BAR('var(--vscode-scrollbarSlider-background)', 5) + ' 75% | 150k / 200k |'), '세션마다 이름·막대(75% → 20칸 중 15칸)와 %·크기');
  assert.doesNotMatch(md, /[█░]/, '글꼴 따라 길이가 뭉개지는 막대 글자 없음');
  // 85번 VS Code(69047191fc) 화면 코드 workbench.desktop.main.js가 span style에 허용하는 형식. 벗어나면 막대가 통째로 지워진다
  const allowed = /^(color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(display\:inline-block;)?(border-radius:[0-9]+px;)?$/;
  const styles = [...md.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(styles.length >= 2 && styles.every((v) => allowed.test(v)), 'VS Code가 남기는 style 형식만');
  assert.strictEqual(item.tooltip.supportHtml, true, '막대 span을 쓰려면 HTML 허용');
  assert.doesNotMatch(md, /Finished chat/, '끝난 세션은 표에도 없다');
  assert.strictEqual(item.tooltip.isTrusted, false);
  stub.calls.length = 0;
  stub.state.pick = (items) => items[0];
  await stub.commands.get('claudeSessionChanges.pickContext')();
  stub.state.pick = undefined;
  const pick = stub.calls.find((c) => c[0] === 'pick');
  assert.deepStrictEqual(pick[1].map((x) => x.sid), [SID_OTHER], '고르기 목록도 열린 세션만');
  assert.match(pick[1][0].description, /^75% · 150k \/ 200k · other-app$/);
  stub.changeConfig('contextSize', false);
  await waitFor(() => !item.visible, '끄면 숨김');
  stub.changeConfig('contextSize', true);
  await waitFor(() => item.visible, '켜면 다시');
  fs.unlinkSync(goneFile);
  await refresh();
  await waitFor(() => !web.lastPayload().mine.some((r) => r.sid === SID_GONE), '시험용 세션 지움');
});

test('세션을 누르면 Claude 대화 열기, 새 세션 열기', async () => {
  stub.calls.length = 0;
  web.send({ type: 'open', sid: SID_A });
  await waitFor(() => stub.calls.find((c) => c[0] === 'claude-vscode.editor.open'), '대화 열기');
  assert.strictEqual(stub.calls.find((c) => c[0] === 'claude-vscode.editor.open')[1], SID_A);
  stub.calls.length = 0;
  web.send({ type: 'new' });
  await waitFor(() => stub.calls.find((c) => c[0] === 'claude-vscode.editor.open' && c.length === 1), '새 세션');
});

test('새 세션 단추: 설정 newSessionTool이 codex면 Codex 새 대화(확장 있으면 확장, 없으면 터미널의 Codex CLI)', async () => {
  assert.match(web.lastPayload().strings.newSessionTip, /^New Claude Code session/, '기본은 Claude Code');
  stub.changeConfig('newSessionTool', 'codex');
  await waitFor(() => /^New Codex chat/.test(web.lastPayload().strings.newSessionTip || ''), '단추 설명이 Codex로');
  stub.state.installedExtensions = ['openai.chatgpt'];
  stub.calls.length = 0;
  web.send({ type: 'new' });
  await waitFor(() => stub.calls.find((c) => c[0] === 'chatgpt.newCodexPanel'), 'Codex 확장의 새 대화');
  assert.ok(!stub.calls.some((c) => c[0] === 'claude-vscode.editor.open'), 'Claude는 열지 않는다');
  stub.state.installedExtensions = [];
  ext._test.setCodexCli(true);
  stub.calls.length = 0;
  web.send({ type: 'new' });
  const term = await waitFor(() => stub.calls.find((c) => c[0] === 'terminal'), '확장이 없으면 터미널의 Codex');
  assert.deepStrictEqual([term[1].sent, term[1].opts.cwd], [['codex'], project]);
  stub.changeConfig('newSessionTool', 'claude');
  await waitFor(() => /^New Claude Code session/.test(web.lastPayload().strings.newSessionTip || ''), '되돌림');
});

test('세션 창 … 메뉴: 새 세션 도구 바꾸기(고르면 설정 newSessionTool이 바뀐다)와 Watchtower 설정 모두 보기', async () => {
  const menu = require('../package.json').contributes.menus['view/title'].filter((m) => m.when === 'view == claudeSessionChanges.sessions').map((m) => m.command);
  for (const c of ['claudeSessionChanges.pickNewSessionTool', 'claudeSessionChanges.openSettings']) assert.ok(menu.includes(c), c + '가 … 메뉴에 있다');
  stub.calls.length = 0;
  stub.state.pick = (items) => items.find((i) => i.v === 'codex');
  await stub.commands.get('claudeSessionChanges.pickNewSessionTool')();
  stub.state.pick = undefined;
  const items = stub.calls.find((c) => c[0] === 'pick')[1];
  assert.deepStrictEqual(items.map((i) => [i.label, i.description]), [['Claude Code', 'current'], ['Codex', '']], '지금 고른 것을 표시');
  assert.strictEqual(stub.state.config.newSessionTool, 'codex', '고른 도구로 설정이 바뀐다');
  stub.changeConfig('newSessionTool', 'claude');
});

test('다른 폴더 세션: 그 폴더 창을 앞으로(없으면 물어보고 새 창), 그 창이 요청을 받아 대화를 연다', async () => {
  const storage = stub.context.globalStorageUri.fsPath;
  const winDir = path.join(storage, 'windows');
  const reqDir = path.join(storage, 'open-requests');
  const reqFile = path.join(reqDir, SID_OTHER + '.json');
  const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const openFolder = () => stub.calls.find((c) => c[0] === 'vscode.openFolder');
  // 이 창은 켜질 때 자기 폴더를 적어 둔다
  const me = readJson(path.join(winDir, process.pid + '.json'));
  assert.deepStrictEqual(me.folders.map((f) => f.path), [project]);

  // ① 그 폴더가 열린 창이 없으면 먼저 묻고, 아니라고 하면 아무것도 하지 않는다
  stub.calls.length = 0;
  web.send({ type: 'open', sid: SID_OTHER });
  await waitFor(() => stub.calls.find((c) => c[0] === 'info'), '새 창 열지 묻기');
  assert.match(stub.calls.find((c) => c[0] === 'info')[1], /No VS Code window has the folder of "Other folder work" open/);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!openFolder() && !fs.existsSync(reqFile), '묻기에 답하지 않으면 창도 요청도 없다');
  assert.ok(!stub.calls.some((c) => c[0] === 'claude-vscode.editor.open'), '이 창에서 다른 폴더 대화를 열지 않는다');

  // ② "새 창으로 열기"를 고르면 같은 서버(같은 scheme·authority)의 그 폴더를 새 창으로 열고 요청을 남긴다
  stub.calls.length = 0;
  stub.state.answer = (m, b) => (/No VS Code window/.test(m) ? b[0] : undefined);
  web.send({ type: 'open', sid: SID_OTHER });
  await waitFor(() => openFolder(), '새 창 열기');
  stub.state.answer = undefined;
  assert.strictEqual(openFolder()[1].path, other);
  assert.deepStrictEqual(openFolder()[2], { forceNewWindow: true });
  let req = readJson(reqFile);
  assert.deepStrictEqual([req.sid, req.cwd, req.from, req.to], [SID_OTHER, other, process.pid, null]);
  assert.ok(!stub.calls.some((c) => c[0] === 'claude-vscode.editor.open'));
  // 이 창의 폴더 세션이 아니므로 이 창은 그 요청을 가져가지 않는다
  ext._test.takeOpenRequests();
  assert.ok(fs.existsSync(reqFile));
  fs.unlinkSync(reqFile);

  // ③ 그 폴더가 열린 창(살아 있는 다른 프로세스)이 있으면 묻지 않고 그 창의 주소를 연다(VS Code가 그 창을 앞으로 가져온다)
  fs.writeFileSync(path.join(winDir, process.ppid + '.json'), JSON.stringify({ pid: process.ppid, at: Date.now(), folders: [{ uri: 'vscode-remote://ssh-remote+box' + path.dirname(other), path: path.dirname(other) }, { uri: 'vscode-remote://ssh-remote+box' + other, path: other }], workspaceFile: null }));
  fs.writeFileSync(path.join(winDir, '999999999.json'), JSON.stringify({ pid: 999999999, at: Date.now(), folders: [{ uri: 'file://' + other, path: other }] }));
  stub.calls.length = 0;
  web.send({ type: 'open', sid: SID_OTHER });
  await waitFor(() => openFolder(), '그 창 앞으로');
  assert.ok(!stub.calls.some((c) => c[0] === 'info'), '열린 창이 있으면 묻지 않는다');
  assert.strictEqual(String(openFolder()[1].path), 'vscode-remote://ssh-remote+box' + other, '가장 안쪽 폴더의 창 주소 그대로');
  req = readJson(reqFile);
  assert.strictEqual(req.to, process.ppid, '그 창에 맡긴다');
  assert.ok(!fs.existsSync(path.join(winDir, '999999999.json')), '꺼진 창 기록은 지운다');
  fs.unlinkSync(reqFile);

  // ④ 받는 쪽: 이 창 폴더의 세션 요청이면 한 번만 가져가 대화를 연다. 남의 창 몫·오래된 요청·다른 폴더 요청은 열지 않는다
  const put = (name, r) => fs.writeFileSync(path.join(reqDir, name + '.json'), JSON.stringify({ sid: SID_A, cwd: project, at: Date.now(), from: 1, to: null, ...r }));
  put('mine', {});
  put('theirs', { to: process.ppid });
  put('stale', { at: Date.now() - 3 * MIN });
  put('elsewhere', { cwd: other });
  put('bad', { sid: 'x; rm -rf ~' });
  stub.calls.length = 0;
  stub.state.onWindowState({ focused: true });
  await waitFor(() => stub.calls.find((c) => c[0] === 'claude-vscode.editor.open'), '맡긴 대화 열기');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(stub.calls.filter((c) => c[0] === 'claude-vscode.editor.open').map((c) => c[1]), [SID_A], '한 번만');
  assert.deepStrictEqual(fs.readdirSync(reqDir).sort(), ['elsewhere.json', 'theirs.json'], '가져간 요청·오래된 요청·이상한 요청은 지우고, 남의 몫은 둔다');
  // 맡은 창이 꺼지면 그 폴더가 열린 다른 창이 받는다
  fs.rmSync(path.join(reqDir, 'elsewhere.json'));
  put('theirs', { to: 999999999 });
  stub.calls.length = 0;
  ext._test.takeOpenRequests();
  await waitFor(() => stub.calls.find((c) => c[0] === 'claude-vscode.editor.open'), '꺼진 창 몫을 대신 받기');
  assert.deepStrictEqual(fs.readdirSync(reqDir), []);
  fs.rmSync(path.join(winDir, process.ppid + '.json'));
});

test('바깥 주소(알림 배너)로 세션 열기: 해시가 이름보다 먼저, 잘린 이름도 찾고, 없으면 안내', async () => {
  const h = stub.state.uriHandler;
  assert.ok(h, '주소 처리기가 등록되어야 함');
  const opened = () => stub.calls.filter((c) => c[0] === 'claude-vscode.editor.open').map((c) => c[1]);
  const keyA = require('crypto').createHash('sha256').update(SID_A).digest('hex').slice(0, 12);
  assert.strictEqual(ext._test.sessionKeyOf(SID_A), keyA, '알림 훅과 같은 해시');
  stub.calls.length = 0;
  await h.handleUri({ path: '/open', query: 'key=' + keyA + '&title=' + encodeURIComponent('Wrong name') });
  assert.deepStrictEqual(opened(), [SID_A], '해시로 찾기');
  stub.calls.length = 0;
  await h.handleUri({ path: '/open', query: 'title=' + encodeURIComponent('Refactor auth') + '&folder=' + encodeURIComponent(path.basename(project)) });
  assert.deepStrictEqual(opened(), [SID_A], '이름으로 찾기');
  stub.calls.length = 0;
  await h.handleUri({ path: '/open', query: 'title=' + encodeURIComponent('Refactor a…') });
  assert.deepStrictEqual(opened(), [SID_A], '알림에서 잘린 이름');
  stub.calls.length = 0;
  await h.handleUri({ path: '/open', query: 'title=' + encodeURIComponent('No such session') });
  assert.deepStrictEqual(opened(), []);
  assert.ok(stub.calls.some((c) => c[0] === 'info' && /No such session/.test(c[1])), '없으면 안내');
  stub.calls.length = 0;
  await h.handleUri({ path: '/open', query: 'key=xyz' });
  await h.handleUri({ path: '/other', query: 'title=' + encodeURIComponent('Refactor auth') });
  assert.deepStrictEqual(stub.calls, [], '알 수 없는 주소와 잘못된 해시는 아무것도 하지 않음');
  assert.ok(ext._test.sameTitle('a  b\u0007', 'a b') && !ext._test.sameTitle('abc', '') && !ext._test.sameTitle('abc', 'abd'));
  assert.ok(ext._test.sameTitle('Refactor auth', 'Refactor...') && !ext._test.sameTitle('Refactor auth', '…'), '점 세 개로 잘린 이름도, 빈 앞부분은 아님');
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
  // 변경 파일 창의 세션 줄 설명: 파일 수 → 시간(상태 글자는 뺀다)
  const restEl = roots().find((e) => e.t === 'session' && e.s.sid === SID_REST);
  assert.strictEqual(item(restEl).description, '1 file · 6h');
  assert.match(item(sessionA()).description, /^(needs approval · )?\d+ files · (just now|\d+m)$/);
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
  assert.match(item(sessionA()).description, /^needs approval · \d+ files · /, '기다림만 글자를 붙인다');
  // 기다림이 이어지면(두 번 연속 확인) 한 번 알린다
  await sleep(0);
  const waitNote = () => stub.calls.filter((c) => c[0] === 'info' && /"Refactor auth" is waiting for you: needs approval/.test(c[1]));
  const had = waitNote().length;
  await waitFor(() => waitNote().length === had + 1, '기다림 알림', 9000);
  await sleep(2600);
  assert.strictEqual(waitNote().length, had + 1, '같은 대기를 거듭 알리지 않는다');
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

  // (다) 대화 기록에는 없지만 디스크에서 방금 바뀐 파일(스크립트로 고친 경우)
  assert.strictEqual(icon('README.md'), 'file');
  // 새로 고침을 누르지 않아도 주기 확인만으로 표시가 켜지고 꺼져야 한다(대화 기록은 그대로)
  fs.writeFileSync(fBash, 'changed by a script\n');
  await waitFor(() => icon('README.md') === 'loading~spin', '디스크에서 방금 바뀐 파일', 9000);
  const t29 = new Date(Date.now() - 29000);
  fs.utimesSync(fBash, t29, t29);
  await waitFor(() => icon('README.md') === 'file', '바뀐 지 30초가 지나면 꺼짐', 9000);

  // 쉬는 세션이 방금 바꾼 파일은 돌지 않는다(디스크에서 방금 바뀌었어도)
  fs.writeFileSync(fRest, 'touched\n');
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

  // 이 확장의 보관 기준 설정: Claude Code 설정(기본 14일)과 따로 정할 수 있다
  stub.changeConfig('archiveAfter', '1');
  await waitFor(() => web.lastPayload().archived.some((r) => r.sid === SID_2D), '기준 1일');
  assert.match(web.lastPayload().archivedTip, /^Sessions with no conversation for 1 day\(s\) and sessions/);
  stub.changeConfig('archiveAfter', 'never');
  await waitFor(() => web.lastPayload().mine.some((r) => r.sid === SID_20D), '기준 안 함');
  stub.changeConfig('archiveAfter', 'claude');
  await waitFor(() => web.lastPayload().archived.some((r) => r.sid === SID_20D) && web.lastPayload().mine.some((r) => r.sid === SID_2D), 'Claude 설정 따름');

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

test('Codex 세션을 누르면 그 세션 폴더에서 터미널로 이어 연다(codex resume)', async () => {
  const CX = 'c0de0000-7777-4777-8777-00000000abcd';
  fx.codexSession(home, CX, [
    { timestamp: fx.iso(Date.now() - MIN), type: 'session_meta', payload: { id: CX, session_id: CX, cwd: other, originator: 'codex_vscode', source: 'vscode' } },
    { timestamp: fx.iso(Date.now() - MIN), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A codex job elsewhere' }] } },
  ], Date.now());
  await stub.commands.get('claudeSessionChanges.refresh')();
  const rowOf = () => (web.lastPayload().groups || []).flatMap((g) => g.rows).find((r) => r.sid === 'codex:' + CX);
  const row = await waitFor(rowOf, 'Codex 줄');
  assert.deepStrictEqual([row.codex, row.canOpen], [true, true], '다른 폴더의 Codex 세션도 터미널로는 열 수 있다');
  // 상태 표시줄의 숫자는 이 폴더 세션만 센다(다른 폴더에서 작업 중인 Codex 세션은 설명에만 나온다)
  const bar = stub.statusItems[0];
  await waitFor(() => /Other folders: working 1/.test(bar.tooltip.value), '다른 폴더는 설명에');
  // 대화 내용 찾기에서도 Codex 대화는 "Codex ·"로 시작한다(누르기 전에 Codex로 열린다는 것을 알 수 있게)
  const qp = stub.commands.get('claudeSessionChanges.searchConversations')('codex job elsewhere');
  await waitFor(() => qp.items.length === 1, 'Codex 대화 찾기');
  assert.deepStrictEqual([qp.items[0].r.sid, qp.items[0].label, qp.items[0].detail], ['codex:' + CX, '$(robot) Codex · A codex job elsewhere', 'A codex job elsewhere']);
  qp.hide();
  // Claude 세션과 섞이면 "Claude Code"·"Codex" 구역 줄로 나눈다
  fx.claudeSession(home, other, 'c1a0de00-7777-4777-8777-00000000abcd', [fx.rec.user(other, Date.now() - 1000, 'a claude job elsewhere too')]);
  const mixed = stub.commands.get('claudeSessionChanges.searchConversations')('job elsewhere');
  await waitFor(() => mixed.items.length === 4, '두 구역');
  assert.deepStrictEqual(mixed.items.map((i) => (i.kind === -1 ? '— ' + i.label : i.r.sid)), ['— Claude Code', 'c1a0de00-7777-4777-8777-00000000abcd', '— Codex', 'codex:' + CX]);
  mixed.hide();
  assert.match(bar.text, /\$\(loading~spin\) 1(?!\d)/, '이 폴더에서 작업 중인 세션은 1개');
  ext._test.setCodexCli(true);
  stub.calls.length = 0;
  web.send({ type: 'open', sid: 'codex:' + CX });
  const call = await waitFor(() => stub.calls.find((c) => c[0] === 'terminal'), '터미널');
  assert.deepStrictEqual([call[1].opts.cwd, call[1].sent, call[1].shown], [other, ['codex resume ' + CX], true]);
  assert.ok(!stub.calls.some((c) => c[0] === 'claude-vscode.editor.open'), 'Claude 명령은 부르지 않는다');
  // Codex 확장(openai.chatgpt)이 깔려 있으면 터미널 대신 그 패널에서 연다(vscode://openai.chatgpt/local/<ID>)
  stub.state.installedExtensions = ['openai.chatgpt'];
  stub.calls.length = 0;
  web.send({ type: 'open', sid: 'codex:' + CX });
  const viaPanel = await waitFor(() => stub.calls.find((c) => c[0] === 'openExternal'), 'Codex 패널로 열기');
  assert.strictEqual(viaPanel[1], 'vscode://openai.chatgpt/local/' + CX);
  assert.ok(!stub.calls.some((c) => c[0] === 'terminal'), 'Codex 확장이 있으면 터미널은 열지 않는다');
  stub.state.installedExtensions = [];
  // 기록 파일 이름이 UUID 모양이 아니면(명령 줄에 넣기 위험한 글자가 들어갈 수 있다) 터미널을 열지 않는다
  fx.codexSession(home, 'x; touch pwned', [
    { timestamp: fx.iso(Date.now() - MIN), type: 'session_meta', payload: { cwd: other, originator: 'codex_vscode', source: 'vscode' } },
    { timestamp: fx.iso(Date.now() - MIN), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Odd file name' }] } },
  ], Date.now());
  await stub.commands.get('claudeSessionChanges.refresh')();
  const odd = await waitFor(() => (web.lastPayload().groups || []).flatMap((g) => g.rows).find((r) => r.title === 'Odd file name'), '이상한 이름의 Codex 줄');
  assert.strictEqual(odd.canOpen, false);
  stub.calls.length = 0;
  await stub.commands.get('claudeSessionChanges.openClaudeSession')(odd.sid);
  assert.ok(!stub.calls.some((c) => c[0] === 'terminal') && stub.calls.some((c) => c[0] === 'info'), '터미널 대신 안내만');

  // Codex CLI가 없으면 터미널을 열지 않고 알려 준다
  ext._test.setCodexCli(false);
  stub.calls.length = 0;
  web.send({ type: 'open', sid: 'codex:' + CX });
  await waitFor(() => stub.calls.find((c) => c[0] === 'info' && /Codex CLI/.test(c[1])), 'CLI 없음 알림');
  assert.ok(!stub.calls.some((c) => c[0] === 'terminal'));
});

test('Codex 세션 이름: Codex가 붙인 이름을 보여 주고, 여기서 바꾸면 Codex 공식 통로(thread/name/set)로 바꾼다', async () => {
  const CX = 'c0de0000-8888-4888-8888-00000000beef';
  fx.codexSession(home, CX, [
    { timestamp: fx.iso(Date.now() - MIN), type: 'session_meta', payload: { id: CX, session_id: CX, cwd: project, originator: 'codex_vscode', source: 'vscode' } },
    { timestamp: fx.iso(Date.now() - MIN), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first question of the codex chat' }] } },
  ], Date.now());
  const index = path.join(home, '.codex', 'session_index.jsonl');
  const titleOf = () => { const r = (web.lastPayload().mine || []).concat(...(web.lastPayload().groups || []).map((g) => g.rows)).find((x) => x.sid === 'codex:' + CX); return r && r.title; };
  await stub.commands.get('claudeSessionChanges.refresh')();
  await waitFor(() => titleOf() === 'first question of the codex chat', '이름이 없으면 첫 질문');
  // Codex(앱·VS Code 확장)에서 붙인 이름
  fs.appendFileSync(index, JSON.stringify({ id: CX, thread_name: 'Named in Codex', updated_at: new Date().toISOString() }) + '\n');
  await stub.commands.get('claudeSessionChanges.refresh')();
  await waitFor(() => titleOf() === 'Named in Codex', 'Codex가 붙인 이름');
  // 여기서 바꾸기: PATH의 가짜 codex가 받는다(진짜 Codex처럼 session_index.jsonl에 적는다)
  const bin = fs.mkdtempSync(path.join(require('os').tmpdir(), 'swt-bin-'));
  fs.symlinkSync(path.join(__dirname, 'helpers', 'fake-codex.js'), path.join(bin, 'codex'));
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  process.env.CODEX_HOME = path.join(home, '.codex');
  try {
    stub.state.input = (o) => { assert.strictEqual(o.value, 'Named in Codex', '지금 이름이 미리 들어 있다'); return '  Renamed  here '; };
    assert.strictEqual(await stub.commands.get('claudeSessionChanges.renameSession')('codex:' + CX), true);
    const last = JSON.parse(fs.readFileSync(index, 'utf8').trimEnd().split('\n').pop());
    assert.deepStrictEqual([last.id, last.thread_name], [CX, 'Renamed here']);
    await waitFor(() => titleOf() === 'Renamed here', '바뀐 이름');
    await stub.commands.get('claudeSessionChanges.refresh')();
    await waitFor(() => titleOf() === 'Renamed here', '다시 읽은 뒤에도 그 이름');
    // Codex가 거절하면 이름을 바꾸지 않고 알린다
    process.env.FAKE_CODEX_MODE = 'error';
    stub.state.input = 'Should not stick';
    stub.calls.length = 0;
    assert.strictEqual(await stub.commands.get('claudeSessionChanges.renameSession')('codex:' + CX), false);
    assert.ok(stub.calls.some((c) => c[0] === 'warn' && /thread not found/.test(c[1])));
    assert.strictEqual(titleOf(), 'Renamed here');
    // Codex 프로그램이 없으면 그렇게 알린다
    delete process.env.FAKE_CODEX_MODE;
    process.env.PATH = path.join(bin, 'empty');
    stub.calls.length = 0;
    assert.strictEqual(await stub.commands.get('claudeSessionChanges.renameSession')('codex:' + CX), false);
    assert.ok(stub.calls.some((c) => c[0] === 'warn' && /Codex program was not found/.test(c[1])));
  } finally {
    process.env.PATH = oldPath;
    delete process.env.CODEX_HOME;
    delete process.env.FAKE_CODEX_MODE;
    stub.state.input = undefined;
  }
});

test('그림 파일을 누르면 글자 비교 대신 그 파일을 그대로 연다(0.12.0까지는 "cannot open" 오류)', async () => {
  const png = path.join(project, 'shot.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
  fs.appendFileSync(fileA, [
    rec.toolUse(project, Date.now() - 4000, 't_png', 'Bash', { command: `cp /tmp/a.png ${png}`, description: 'Copy a picture' }),
    rec.toolResult(Date.now() - 3000, 't_png', rec.bashResult({})),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  await stub.commands.get('claudeSessionChanges.refresh')();
  const el = await waitFor(() => fileOf('shot.png'), '그림 파일 줄');
  for (const cmd of ['claudeSessionChanges.openFileDiff', 'claudeSessionChanges.openFile']) {
    stub.calls.length = 0;
    await stub.commands.get(cmd)(el);
    const call = stub.calls.find((c) => c[0] === 'vscode.open');
    assert.ok(call && call[1].path === png, cmd + ': 파일을 그대로 연다');
    assert.ok(!stub.calls.some((c) => c[0] === 'vscode.diff' || c[0] === 'show'), cmd + ': 글자 편집기로 열지 않는다');
  }
});

