'use strict';
// 대화 기록 읽기(scanner.js) 시험. 가짜 홈 폴더의 가짜 기록으로 돈다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const S = require('../scanner.js'); // 홈 폴더를 정한 뒤에 불러야 한다
const { rec } = fx;

const now = Date.now();
const MIN = 60000;
const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
const SID_BIG = '33333333-3333-4333-8333-333333333333';
const CODEX = '44444444-4444-4444-8444-444444444444';

const fileEdit = path.join(project, 'src', 'app.js');
const fileNew = path.join(project, 'src', 'new.js');
const fileSed = path.join(project, 'README.md');
const fileGuess = path.join(project, 'notes.txt');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
for (const f of [fileEdit, fileNew, fileSed, fileGuess]) fs.writeFileSync(f, 'x\n');

const bashCopy = rec.toolUse(project, now - 30 * MIN, 'toolu_sed', 'Bash', { command: `sed -i 's/a/b/' ${fileSed}`, description: 'Fix a typo' });

fx.claudeSession(home, project, SID_A, [
  rec.user(project, now - 40 * MIN, 'Please refactor the app'),
  rec.aiTitle(SID_A, 'Refactor the app'),
  rec.toolUse(project, now - 35 * MIN, 'toolu_edit', 'Edit', { file_path: fileEdit, old_string: 'a', new_string: 'b' }),
  rec.toolResult(now - 35 * MIN + 500, 'toolu_edit', rec.editResult(fileEdit, 'a\nrest\n', 'a', 'b')),
  rec.toolUse(project, now - 34 * MIN, 'toolu_write', 'Write', { file_path: fileNew, content: 'one\ntwo\n' }),
  rec.toolResult(now - 34 * MIN + 500, 'toolu_write', rec.writeResult(fileNew, 'one\ntwo\n')),
  bashCopy,
  rec.toolResult(now - 30 * MIN + 900, 'toolu_sed', rec.bashResult({ bashEditDiff: rec.bashDiff(fileSed, ['-a', '+b']) })),
  // 사본 줄: 끝난 sed 명령이 안에 다시 들어 있다(다시 세면 안 됨)
  rec.apiCopy(bashCopy.message),
  rec.toolUse(project, now - 20 * MIN, 'toolu_echo', 'Bash', { command: `cd ${project} && echo hi >> notes.txt`, description: 'Append a note' }),
  rec.toolResult(now - 20 * MIN + 300, 'toolu_echo', rec.bashResult({})),
  rec.toolUse(project, now - 1 * MIN, 'toolu_test', 'Bash', { command: 'npm test', description: 'Run the tests' }),
]);
fx.subagentSession(home, project, SID_A, 'agent-1', [
  rec.toolUse(project, now - 10 * MIN, 'toolu_sub', 'Write', { file_path: path.join(project, 'sub.txt'), content: 'a\n' }),
  rec.toolResult(now - 10 * MIN + 200, 'toolu_sub', rec.writeResult(path.join(project, 'sub.txt'), 'a\n')),
]);
fx.claudeSession(home, project, SID_B, [
  rec.user(project, now - 50 * MIN, 'Only chatting here'),
  rec.customTitle(SID_B, 'Quiet session'),
]);
fx.registerSession(home, process.pid, SID_A, { status: 'busy', cwd: project, name: 'demo-a1', nameSource: 'derived' });
fx.registerSession(home, process.ppid, SID_B, { status: 'idle', cwd: project, name: 'demo-b2', nameSource: 'derived' });

const base = () => ({ lookbackHours: 24, force: true, includeCodex: true, attentionDir: markers });
const find = (r, sid) => r.sessions.find((s) => s.sid === sid);
const kinds = (s, p) => s.changes.filter((c) => c.path === p).map((c) => c.kind).sort();

test('편집·새 파일·셸 기록·셸 추정을 세션별로 모은다', () => {
  const r = S.createModel().scan(base());
  const a = find(r, SID_A);
  assert.ok(a, '세션 A가 있어야 함');
  assert.strictEqual(a.title, 'Refactor the app');
  assert.strictEqual(a.cwd, project);
  assert.deepStrictEqual(kinds(a, fileEdit), ['edit']);
  assert.deepStrictEqual(kinds(a, fileNew), ['edit']);
  assert.deepStrictEqual(kinds(a, fileSed), ['bash']);
  assert.deepStrictEqual(kinds(a, fileGuess), ['shell']);
  const edit = a.changes.find((c) => c.path === fileEdit);
  assert.deepStrictEqual([edit.add, edit.del, edit.created], [2, 1, false]);
  const created = a.changes.find((c) => c.path === fileNew);
  assert.deepStrictEqual([created.add, created.created, created.tool], [2, true, 'Write']);
  assert.ok(a.changes.some((c) => c.sub && c.path.endsWith('sub.txt')), '하위 에이전트 변경도 부모 세션에');
});

test('API 요청 사본 줄은 도구 호출로 세지 않는다', () => {
  const st = S.scanOne(path.join(home, '.claude', 'projects', fx.encode(project), SID_A + '.jsonl'), 'claude');
  assert.strictEqual(st.changes.filter((c) => c.path === fileSed).length, 1, 'sed 변경은 한 번만');
  assert.ok(!st.pendingBash.has('toolu_sed'), '끝난 명령이 대기 목록에 다시 들어가면 안 됨');
  // 사본만 있고 진짜 호출이 뒤따르지 않는 기록: 마지막 도구가 사본 때문에 "진행 중"으로 돌아가면 안 된다
  const sid = '66666666-6666-4666-8666-666666666666';
  const call = rec.toolUse(project, now - 9 * MIN, 'toolu_ls', 'Bash', { command: 'ls', description: 'List files' });
  const file = fx.claudeSession(home, project, sid, [call, rec.toolResult(now - 9 * MIN + 300, 'toolu_ls', rec.bashResult({})), rec.apiCopy(call.message)]);
  const only = S.scanOne(file, 'claude');
  assert.strictEqual(only.lastTool.done, true, '끝난 도구는 끝난 채로');
  assert.strictEqual(only.pendingBash.size, 0);
});

test('지금 하는 일: 결과가 아직 없는 마지막 도구는 진행 중', () => {
  const a = find(S.createModel().scan(base()), SID_A);
  assert.strictEqual(a.activity.tool, 'Bash');
  assert.strictEqual(a.activity.arg, 'Run the tests');
  assert.strictEqual(a.activity.done, false);
});

test('실행 중 목록: 작업 중·쉬는 중, 표시 파일이 있으면 기다림', () => {
  let r = S.createModel().scan(base());
  assert.deepStrictEqual([find(r, SID_A).alive, find(r, SID_A).status], [true, 'busy']);
  assert.deepStrictEqual([find(r, SID_B).alive, find(r, SID_B).status, find(r, SID_B).title], [true, 'idle', 'Quiet session']);
  const marker = fx.writeMarker(markers, SID_A, 'Bash');
  r = S.createModel().scan(base());
  assert.deepStrictEqual([find(r, SID_A).status, find(r, SID_A).waitingFor], ['waiting', 'permission prompt']);
  const light = S.createModel().status(base()).sessions.find((s) => s.sid === SID_A);
  assert.strictEqual(light.status, 'waiting', '상태만 빠르게 읽어도 같아야 함');
  fs.unlinkSync(marker);
});

test('읽은 결과를 저장해 두면 다시 읽지 않는다', () => {
  const cacheFile = path.join(home, 'cache', 'scan.json');
  const m1 = S.createModel();
  const r1 = m1.scan({ ...base(), cacheFile });
  m1.save({ cacheFile });
  assert.ok(r1.stats.bytes > 0);
  const r2 = S.createModel().scan({ ...base(), cacheFile });
  assert.strictEqual(r2.stats.bytes, 0, '저장 파일이 있으면 새로 읽는 양은 0');
  assert.strictEqual(find(r2, SID_A).changes.length, find(r1, SID_A).changes.length);
  assert.strictEqual(find(r2, SID_A).title, 'Refactor the app');
});

test('읽는 도중 중간 결과를 보낸다', () => {
  const partials = [];
  S.createModel().scan({ ...base(), progressMs: -1, onProgress: (p) => partials.push(p.sessions.map((s) => s.sid)) });
  assert.ok(partials.length >= 1, '중간 결과가 한 번은 와야 함');
  assert.ok(partials[0].length >= 1 && partials[0].length <= 2);
});

test('큰 기록은 보는 기간이 시작되는 곳부터 읽고, 기간을 늘리면 다시 읽는다', () => {
  const oldFile = path.join(project, 'old.js');
  const recentFile = path.join(project, 'recent.js');
  const lines = [];
  const start = now - 5 * 24 * 60 * MIN;
  const filler = 'x'.repeat(400);
  for (let i = 0; i < 6000; i++) {
    lines.push(rec.user(project, start + i * 1000, `old message ${i} ${filler}`));
    if (i === 4000) lines.push(rec.aiTitle(SID_BIG, 'Long running session'));
    if (i === 100) {
      lines.push(rec.toolUse(project, start + i * 1000 + 100, 'toolu_old', 'Write', { file_path: oldFile, content: 'o\n' }));
      lines.push(rec.toolResult(start + i * 1000 + 200, 'toolu_old', rec.writeResult(oldFile, 'o\n')));
    }
  }
  lines.push(rec.toolUse(project, now - 60 * MIN, 'toolu_recent', 'Write', { file_path: recentFile, content: 'r\n' }));
  lines.push(rec.toolResult(now - 60 * MIN + 200, 'toolu_recent', rec.writeResult(recentFile, 'r\n')));
  const file = fx.claudeSession(home, project, SID_BIG, lines);
  const size = fs.statSync(file).size;
  assert.ok(size > 2.5 * 1024 * 1024, '시험 파일이 충분히 커야 함');

  const seekMinBytes = 100 * 1024;
  const st = S.scanOne(file, 'claude', now - 24 * 60 * MIN, seekMinBytes);
  assert.ok(st.scanFrom > size / 2, '뒤쪽에서부터 읽어야 함');
  assert.ok(st.changes.some((c) => c.path === recentFile), '기간 안의 변경은 있어야 함');
  assert.ok(!st.changes.some((c) => c.path === oldFile), '기간 밖의 옛 변경은 읽지 않음');
  assert.strictEqual(st.aiTitle, 'Long running session', '제목은 앞쪽에 있어도 찾아야 함');
  assert.ok(st.firstPrompt && st.firstPrompt.startsWith('old message 0'), '첫 질문은 파일 맨 앞에서');
  const full = S.scanOne(file, 'claude');
  assert.strictEqual(full.scanFrom, 0);
  assert.ok(full.changes.some((c) => c.path === oldFile));

  const model = S.createModel();
  const r24 = model.scan({ ...base(), seekMinBytes });
  assert.ok(!find(r24, SID_BIG).changes.some((c) => c.path === oldFile));
  const r200 = model.scan({ ...base(), lookbackHours: 200, seekMinBytes });
  assert.ok(find(r200, SID_BIG).changes.some((c) => c.path === oldFile), '기간을 늘리면 옛 변경이 나와야 함');
});

test('Codex 기록: apply_patch 로 고친 파일과 첫 질문', () => {
  const target = path.join(project, 'codex.txt');
  fx.codexSession(home, CODEX, [
    { timestamp: fx.iso(now - 5 * MIN), type: 'session_meta', payload: { id: CODEX, cwd: project, originator: 'codex_vscode' } },
    { timestamp: fx.iso(now - 5 * MIN), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a codex file' }] } },
    { timestamp: fx.iso(now - 4 * MIN), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: `*** Begin Patch\n*** Add File: ${target}\n+hello\n+world\n*** Update File: src/app.js\n@@\n-a\n+b\n*** End Patch` } },
  ]);
  const r = S.createModel().scan(base());
  const c = find(r, 'codex:' + CODEX);
  assert.ok(c, 'Codex 세션이 있어야 함');
  assert.strictEqual(c.agent, 'codex');
  assert.strictEqual(c.title, 'Add a codex file');
  const added = c.changes.find((x) => x.path === target);
  assert.deepStrictEqual([added.kind, added.add, added.created], ['cxedit', 2, true]);
  assert.ok(c.changes.some((x) => x.path === fileEdit && x.del === 1), '상대 경로는 작업 폴더 기준으로');
  assert.ok(!find(S.createModel().scan({ ...base(), includeCodex: false }), 'codex:' + CODEX), '설정으로 끌 수 있어야 함');
});

test('출력 없는 커밋(-q)도 명령 실행 시간대로 찾는다', (t) => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { t.skip('git 없음'); return; }
  const repo = path.join(home, 'work', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A'); git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  const t0 = Date.now();
  git('add', '-A'); git('commit', '-q', '-m', 'add b');
  const sid = '55555555-5555-4555-8555-555555555555';
  fx.claudeSession(home, repo, sid, [
    rec.user(repo, t0 - 5000, 'commit it'),
    rec.toolUse(repo, t0 - 1000, 'toolu_commit', 'Bash', { command: 'git add -A && git commit -q -m "add b"', description: 'Commit' }),
    rec.toolResult(Date.now() + 1000, 'toolu_commit', rec.bashResult({})),
  ]);
  const s = find(S.createModel().scan(base()), sid);
  const hit = s.changes.find((c) => c.kind === 'commit' && c.path === path.join(repo, 'b.txt'));
  assert.ok(hit, '커밋된 b.txt가 잡혀야 함');
  assert.strictEqual(hit.add, 1);
});

test('셸 명령에서 쓴 파일 추정', () => {
  const t = (cmd) => S.shellTargets(cmd, '/w').sort();
  assert.deepStrictEqual(t('echo a > out.txt'), ['/w/out.txt']);
  assert.deepStrictEqual(t('cd sub && echo a >> log.md 2>&1'), ['/w/sub/log.md']);
  assert.deepStrictEqual(t("sed -i 's/a/b/' one.txt two.txt"), ['/w/one.txt', '/w/two.txt']);
  assert.deepStrictEqual(t('cat x | tee -a /abs/t.log'), ['/abs/t.log']);
  assert.deepStrictEqual(t('ls 2>/dev/null; echo $X > "$OUT"'), [], '변수 경로와 /dev/null 은 뺀다');
  assert.deepStrictEqual(t("python3 - <<'EOF'\nif a > b: pass\nEOF"), [], '여기 문서 안의 > 는 무시');
});

test('apply_patch 글 해석과 임시 파일 판정', () => {
  const parts = S.parsePatch('*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n+z\n*** Delete File: /abs/b.txt\n*** End Patch', '/w');
  assert.deepStrictEqual(parts.map((p) => [p.op, p.path, p.add, p.del]), [['Update', '/w/a.txt', 2, 1], ['Delete', '/abs/b.txt', 0, 0]]);
  assert.strictEqual(S.isScratch('/tmp/claude-0000/no-such-project/abc/scratchpad/out.txt'), true);
  assert.strictEqual(S.isScratch(path.join(home, 'work', 'file.txt')), path.join(home, 'x').startsWith('/tmp/claude-'));
});

test('마지막 활동은 마지막 대화 시각이다(파일이 바뀐 시각이 아님)', () => {
  const sid = '77777777-7777-4777-8777-777777777777';
  const last = now - 6 * 60 * MIN;
  fx.claudeSession(home, project, sid, [
    rec.user(project, last - MIN, 'earlier work'),
    rec.toolUse(project, last, 'toolu_l', 'Bash', { command: 'ls', description: 'List' }),
    rec.toolResult(last + 400, 'toolu_l', rec.bashResult({})),
    { type: 'last-prompt', lastPrompt: 'earlier work', sessionId: sid }, // 꺼질 때 붙는 정리 기록: 시각이 없다
    { type: 'cost-state', sessionId: sid },
  ]);
  const s = find(S.createModel().scan(base()), sid);
  assert.ok(Math.abs(s.lastActivity - (last + 400)) < 1500, '마지막 대화 시각이어야 함: ' + new Date(s.lastActivity).toISOString());
});

test('이 폴더의 오래된 세션은 설정한 날 수만큼 목록에만 보여 준다', () => {
  const sid = '88888888-8888-4888-8888-888888888888';
  const old = now - 5 * 24 * 60 * MIN;
  const oldFile = path.join(project, 'ancient.js');
  const file = fx.claudeSession(home, project, sid, [
    rec.user(project, old - MIN, 'a task from last week'),
    rec.aiTitle(sid, 'Last week task'),
    rec.toolUse(project, old, 'toolu_a', 'Write', { file_path: oldFile, content: 'x\n' }),
    rec.toolResult(old + 300, 'toolu_a', rec.writeResult(oldFile, 'x\n')),
  ]);
  fs.utimesSync(file, new Date(old + 1000), new Date(old + 1000));
  assert.ok(!find(S.createModel().scan(base()), sid), '기본(끔)에서는 보는 기간 밖 세션이 없어야 함');
  assert.ok(!find(S.createModel().scan({ ...base(), listDays: 14, workspaceDirs: ['/some/other/folder'] }), sid), '다른 폴더 창에서는 안 보임');
  assert.ok(!find(S.createModel().scan({ ...base(), listDays: 2, workspaceDirs: [project] }), sid), '날 수보다 오래되면 안 보임');
  const model = S.createModel();
  const s = find(model.scan({ ...base(), listDays: 14, workspaceDirs: [project] }), sid);
  assert.ok(s, '14일로 켜면 보여야 함');
  assert.deepStrictEqual([s.metaOnly, s.title, s.alive, s.changes.length], [true, 'Last week task', false, 0]);
  assert.ok(Math.abs(s.lastActivity - (old + 300)) < 1500);
  const wide = find(model.scan({ ...base(), lookbackHours: 200, listDays: 14, workspaceDirs: [project] }), sid);
  assert.strictEqual(wide.metaOnly, false, '보는 기간에 들어오면 제대로 읽는다');
  assert.ok(wide.changes.some((c) => c.path === oldFile));
});

test('프로그램이 돌린 세션(SDK)은 옛 세션 목록에 넣지 않는다(Claude Code 목록과 같게)', () => {
  const sid = '99999999-9999-4999-8999-999999999999';
  const old = now - 2 * 24 * 60 * MIN;
  const touched = path.join(project, 'by-script.js');
  const file = fx.claudeSession(home, project, sid, [
    { ...rec.user(project, old - MIN, 'run from a script'), entrypoint: 'sdk-cli' },
    rec.aiTitle(sid, 'Scripted run'),
    rec.toolUse(project, old, 'toolu_s', 'Write', { file_path: touched, content: 'x\n' }),
    rec.toolResult(old + 300, 'toolu_s', rec.writeResult(touched, 'x\n')),
  ]);
  fs.utimesSync(file, new Date(old + 1000), new Date(old + 1000));
  assert.ok(!find(S.createModel().scan({ ...base(), listDays: 14, workspaceDirs: [project] }), sid), '목록에는 없어야 함');
  const wide = find(S.createModel().scan({ ...base(), lookbackHours: 72, listDays: 14, workspaceDirs: [project] }), sid);
  assert.ok(wide && wide.changes.some((c) => c.path === touched), '보는 기간 안에 파일을 바꿨으면 그대로 보여 준다');
});

