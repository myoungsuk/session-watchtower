'use strict';
// 보는 기간을 분 단위로(10 ~ 50분) 고르는 시험: 고르기 창의 선택지, 저장되는 값, 목록에서 빠지는 파일, 표시 글자.
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
const SID = 'd1d10000-1111-4111-8111-111111111111';
const f5 = path.join(project, 'five.js');
const f15 = path.join(project, 'fifteen.js');
const f45 = path.join(project, 'fortyfive.js');
for (const f of [f5, f15, f45]) { fs.writeFileSync(f, 'v2\n'); fs.utimesSync(f, new Date(now - 60 * MIN), new Date(now - 60 * MIN)); }
const edit = (id, f, ts) => [rec.toolUse(project, ts - 400, id, 'Edit', { file_path: f, old_string: 'v1', new_string: 'v2' }), rec.toolResult(ts, id, rec.editResult(f, 'v1\n', 'v1', 'v2'))];
fx.claudeSession(home, project, SID, [
  rec.user(project, now - 50 * MIN, 'Tidy three files'),
  rec.aiTitle(SID, 'Tidy'),
  ...edit('e45', f45, now - 45 * MIN), ...edit('e15', f15, now - 15 * MIN), ...edit('e5', f5, now - 5 * MIN),
]);
fx.registerSession(home, process.pid, SID, { status: 'idle', cwd: project, name: 't1', nameSource: 'derived', statusUpdatedAt: now - 4 * MIN });

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
const view = () => stub.trees['claudeSessionChanges.tree'];
const files = () => {
  const s = view().provider.getChildren().find((e) => e.t === 'session' && e.s.sid === SID);
  return s ? view().provider.getChildren(s).filter((e) => e.t === 'file').map((e) => path.basename(e.f.path)).sort().join(',') : '';
};
// 고르기 창에서 이름이 label인 줄을 고르고, 설정이 바뀌었다고 알린다(실제 VS Code는 저장하면 알려 준다)
async function pick(label) {
  let shown = null;
  stub.state.pick = (items) => { shown = items; return items.find((i) => i.label === label); };
  await stub.commands.get('claudeSessionChanges.pickWindow')();
  stub.changeConfig('lookbackHours', stub.state.config.lookbackHours);
  return shown;
}

test.before(async () => {
  ext.activate(stub.context);
  await waitFor(() => files() === 'fifteen.js,five.js,fortyfive.js', '첫 읽기(24시간)');
});
test.after(async () => { await ext.deactivate(); });

test('보는 기간: 10 ~ 50분을 고를 수 있고, 그 안에 바뀐 파일만 남으며 "Last 10 min"처럼 보인다', async () => {
  assert.strictEqual(view().description, 'Last 24h', '시간 단위 표시는 그대로');

  const items = await pick('10 minutes');
  assert.deepStrictEqual(items.slice(0, 6).map((i) => i.label), ['10 minutes', '20 minutes', '30 minutes', '40 minutes', '50 minutes', '1 hours'], '분 선택지가 1시간 앞에');
  assert.strictEqual(items.find((i) => i.label === '1 days').description, 'current', '고르기 전에는 24시간이 지금 값');
  assert.ok(Math.abs(stub.state.config.lookbackHours - 10 / 60) < 0.001, '시간의 소수로 저장: ' + stub.state.config.lookbackHours);
  await waitFor(() => files() === 'five.js', '10분: 5분 전에 바꾼 파일만');
  assert.strictEqual(view().description, 'Last 10 min');

  const again = await pick('30 minutes');
  assert.strictEqual(again.find((i) => i.label === '10 minutes').description, 'current', '0.1667도 10분으로 알아본다');
  await waitFor(() => files() === 'fifteen.js,five.js', '30분: 45분 전 파일은 빠짐');
  assert.strictEqual(view().description, 'Last 30 min');

  // 마크다운 요약 제목도 분으로
  const md = await stub.commands.get('claudeSessionChanges.copyFolderSummary')();
  assert.match(md, /^## Session changes · last 30 min/);

  await pick('1 hours');
  await waitFor(() => files() === 'fifteen.js,five.js,fortyfive.js', '1시간: 셋 다');
  assert.strictEqual(view().description, 'Last 1h');
});
