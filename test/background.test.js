'use strict';
// 창이 안 보일 때(사용자가 파일 탐색기를 보고 있을 때)의 동작 시험:
// 대화 기록을 계속 읽어 탐색기 표시·알림이 최신 내용으로 나오는지 본다. 작업 폴더는 원격 창(vscode-remote)처럼 꾸민다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
const { rec } = fx;
const stub = require('./helpers/vscode-stub').install({
  extDir: path.join(__dirname, '..'), language: 'en', workspace: project, workspaceScheme: 'vscode-remote', workspaceAuthority: 'ssh-remote+box',
  // 기다림 알림은 끈다: 그래도 멈춤 알림은 따로 나와야 한다(0.13.0에서는 함께 꺼졌다)
  config: { hideScratchpadFiles: false, attentionMarkerDir: markers, pollSeconds: 2, notifyStuckMinutes: 10, notifyWaiting: false },
});
const ext = require('../extension.js');

const now = Date.now();
const MIN = 60000;
const SID_W = 'b9c00000-1111-4111-8111-111111111111';
const SID_S = 'b9c00000-2222-4222-8222-222222222222';
const fLive = path.join(project, 'src', 'live.js');
const fOld = path.join(project, 'src', 'old.js');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
for (const f of [fLive, fOld]) { fs.writeFileSync(f, 'v1\n'); fs.utimesSync(f, new Date(now - 30 * MIN), new Date(now - 30 * MIN)); }
const edit = (id, f, ts) => [rec.toolUse(project, ts - 400, id, 'Edit', { file_path: f, old_string: 'v1', new_string: 'v2' }), rec.toolResult(ts, id, rec.editResult(f, 'v1\n', 'v1', 'v2'))];
// 작업 중인 세션: 마지막 기록이 9분 56초 전(곧 "10분째 조용함"이 되는 시점)
const fileW = fx.claudeSession(home, project, SID_W, [
  rec.user(project, now - 20 * MIN, 'Keep working on the parser'),
  rec.aiTitle(SID_W, 'Busy worker'),
  ...edit('w0', fOld, now - 15 * MIN),
  rec.toolUse(project, now - 10 * MIN + 4000, 't_run', 'Bash', { command: 'npm test', description: 'Run the tests' }),
]);
// 정말 멈춘 세션: 작업 중인데 12분째 새 기록이 없다
fx.claudeSession(home, project, SID_S, [
  rec.user(project, now - 20 * MIN, 'Run the long migration'),
  rec.aiTitle(SID_S, 'Really stuck'),
  rec.toolUse(project, now - 12 * MIN, 't_hang', 'Bash', { command: 'npm run migrate', description: 'Run the migration' }),
]);
const regW = (o) => fx.registerSession(home, process.pid, SID_W, { status: 'busy', cwd: project, name: 'w1', nameSource: 'derived', statusUpdatedAt: now - 20 * MIN, ...o });
regW({});
fx.registerSession(home, process.ppid, SID_S, { status: 'busy', cwd: project, name: 's1', nameSource: 'derived', statusUpdatedAt: now - 20 * MIN });

const TREE = 'claudeSessionChanges.tree';
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
const add = (recs) => fs.appendFileSync(fileW, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
const warns = (re) => stub.calls.filter((c) => c[0] === 'warn' && re.test(c[1]));
const tree = () => stub.trees[TREE];

test.before(async () => {
  ext.activate(stub.context);
  await waitFor(() => tree().provider.getChildren().some((e) => e.t === 'session'), '첫 읽기');
  tree().visible = false; // 사용자가 파일 탐색기로 옮겨 갔다: 이 확장의 창은 이제 안 보인다
});
test.after(async () => { await ext.deactivate(); });

test('창이 안 보여도: 계속 기록을 쓰는 세션을 "멈춘 것 같다"고 잘못 알리지 않는다', async () => {
  // 10분 경계를 넘는 동안 세션은 1초마다 새 기록을 쓴다
  for (let i = 0; i < 8; i++) {
    add([rec.toolResult(Date.now(), 't_run' + (i || ''), rec.bashResult({})), rec.toolUse(project, Date.now(), 't_run' + (i + 1), 'Bash', { command: 'npm test', description: 'Run the tests' })]);
    await sleep(1000);
  }
  assert.strictEqual(warns(/"Busy worker" has been working/).length, 0, '기록이 계속 생기는데 멈춤 알림이 떴다');
  assert.strictEqual(warns(/"Really stuck" has been working for 1\d minutes/).length, 1, '정말 조용한 세션은 한 번 알린다(기다림 알림을 꺼도)');
});

test('파일 탐색기 표시: 창이 안 보여도 지금 고치는 파일에 도는 배지와 색이 붙고, 끝나면 사라진다', async () => {
  const marks = stub.state.decoProviders[1];
  const remote = (f) => stub.mkUri('vscode-remote', 'ssh-remote+box', f);
  const deco = (f) => marks.provideFileDecoration(remote(f));
  const fired = [];
  marks.onDidChangeFileDecorations((uris) => fired.push(uris.map(String)));
  const firedFor = (f) => fired.filter((u) => u.includes(String(remote(f)))).length;
  assert.strictEqual(deco(fLive), undefined, '고치지 않는 파일에는 표시가 없다');

  // 세션이 파일을 방금 고쳤다 → 다음 확인(2초) 때 표시가 붙는다. 이 확장의 창은 계속 안 보이는 상태다
  add(edit('w_live', fLive, Date.now()));
  const d = await waitFor(() => deco(fLive), '고치는 중 표시', 9000);
  assert.ok(['◐', '◓', '◑', '◒'].includes(d.badge), '배지는 도는 모양 가운데 하나: ' + d.badge);
  assert.strictEqual(d.color.id, 'charts.green');
  assert.match(d.tooltip, /^Being edited now by "Busy worker"/);
  assert.strictEqual(d.propagate, true, '파일을 품은 폴더에도 번진다');
  assert.ok(firedFor(fLive) >= 1, '탐색기에 다시 그리라고 알린다(원격 창 주소로)');
  assert.strictEqual(deco(fOld), undefined, '예전에 고친 파일은 그대로');
  assert.strictEqual(marks.provideFileDecoration(stub.mkUri('file', '', fLive)), undefined, '작업 폴더와 다른 종류의 주소에는 붙이지 않는다');

  // 배지가 돈다: 잠깐 사이에 모양이 바뀌고, 그때마다 다시 그리라고 알린다
  const seen = new Set();
  const before = firedFor(fLive);
  for (let i = 0; i < 12; i++) { seen.add(deco(fLive).badge); await sleep(150); }
  assert.ok(seen.size >= 3, '도는 모양이 바뀐다: ' + [...seen].join(''));
  assert.ok(firedFor(fLive) - before >= 3, '모양이 바뀔 때마다 알린다');

  // "움직임 줄이기"를 켠 사람에게는 멈춘 점
  stub.changeSetting('workbench.reduceMotion', 'on');
  assert.strictEqual(deco(fLive).badge, '●');
  const still = firedFor(fLive);
  await sleep(1000);
  assert.strictEqual(firedFor(fLive), still, '더는 돌지 않는다');
  stub.changeSetting('workbench.reduceMotion', 'auto');
  assert.notStrictEqual(deco(fLive).badge, '●');
  assert.ok(firedFor(fLive) > still, '표시 방식이 바뀌면 다시 그리라고 알린다');

  // 한꺼번에 많은 파일이 바뀌면(포매터 등) 돌리지 않는다: 0.4초마다 수십 줄을 다시 그리지 않게 멈춘 점으로
  const many = Array.from({ length: 21 }, (_, i) => path.join(project, 'src', `gen${i}.js`));
  for (const f of many) fs.writeFileSync(f, 'v1\n');
  add(many.flatMap((f, i) => edit('w_gen' + i, f, Date.now())));
  await waitFor(() => deco(many[20]), '많은 파일 표시', 9000);
  assert.deepStrictEqual([deco(fLive).badge, deco(many[0]).badge], ['●', '●']);
  const quiet = fired.length;
  await sleep(1000);
  assert.strictEqual(fired.length, quiet, '많을 때는 돌지 않는다');

  // 설정을 끄면 표시가 사라지고, 켜면 돌아온다
  stub.changeConfig('explorerMarks', false);
  assert.strictEqual(deco(fLive), undefined);
  stub.changeConfig('explorerMarks', true);
  assert.ok(deco(fLive));

  // 승인을 기다리는 고치기: 파란 느낌표
  add([rec.toolUse(project, Date.now(), 'w_pend', 'Edit', { file_path: fOld, old_string: 'v2', new_string: 'v3' })]);
  regW({ status: 'waiting', waitingFor: 'permission prompt' });
  const a = await waitFor(() => { const x = deco(fOld); return x && x.badge === '!' ? x : null; }, '승인 대기 표시', 9000);
  assert.strictEqual(a.color.id, 'charts.blue');
  assert.match(a.tooltip, /^"Busy worker" is waiting for your approval to edit this file/);

  // 세션이 쉬면 표시가 모두 사라진다
  regW({ status: 'idle', statusUpdatedAt: Date.now() });
  await waitFor(() => !deco(fLive) && !deco(fOld), '쉬는 세션의 표시가 사라짐', 9000);
  const end = firedFor(fLive);
  await sleep(900);
  assert.strictEqual(firedFor(fLive), end, '표시가 없으면 더는 알리지 않는다');
});
