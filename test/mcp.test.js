'use strict';
// MCP 서버 창 시험: 이 폴더 기준 목록(직접 추가·이 폴더·프로젝트·플러그인·claude.ai·Codex), 이 폴더에서 끄고 켜기
// (Claude Code의 /mcp disable과 같은 ~/.claude.json 칸, 잠금 폴더, 다른 내용은 그대로), 되돌리기, 저장 뒤 다시 확인,
// 상태 확인(claude mcp list 출력 읽기), 비밀 값이 화면으로 나가지 않는지.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
// 창은 저장소 안의 하위 폴더를 연다: Claude Code는 저장소 뿌리를 열쇠로 쓴다
const sub = path.join(project, 'packages', 'api');
fs.mkdirSync(sub, { recursive: true });
execFileSync('git', ['-C', project, 'init', '-q']);
const stub = require('./helpers/vscode-stub').install({
  extDir: path.join(__dirname, '..'), language: 'en', workspace: sub,
  config: { attentionMarkerDir: markers, pollSeconds: 2, notifyStuckMinutes: 0, notifyWaiting: false },
});
const ext = require('../extension.js');
const mcp = require('../mcp.js');

const SECRET = 'sk-test-SECRET-4242';
const CFG = path.join(home, '.claude.json');
const base = () => ({
  numStartups: 3,
  mcpServers: {
    docs: { type: 'http', url: 'https://docs.example.com/mcp?key=' + SECRET, headers: { Authorization: 'Bearer ' + SECRET } },
    files: { type: 'stdio', command: 'files-mcp', args: ['--token', SECRET], env: { API_KEY: SECRET } },
  },
  claudeAiMcpEverConnected: ['claude.ai Notion', 'claude.ai Gmail', 'claude.ai Old'],
  projects: {
    [project]: { allowedTools: [], mcpServers: { db: { command: 'db-mcp', env: { PASS: SECRET } } }, disabledMcpServers: ['claude.ai Gmail'], hasTrustDialogAccepted: true },
    '/elsewhere/app': { allowedTools: [], disabledMcpServers: ['docs'] },
  },
  oauthAccount: { emailAddress: 'someone@example.invalid' },
});
const writeCfg = (d) => { fs.writeFileSync(CFG, JSON.stringify(d, null, 2), { mode: 0o600 }); fs.chmodSync(CFG, 0o600); };
const readCfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));
writeCfg(base());
fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { lint: { command: 'lint-mcp' }, search: { type: 'sse', url: 'https://s.example.com/sse' }, legacy: { command: 'old-mcp' } } }));
fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['lint'], disabledMcpjsonServers: ['legacy'] }));
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
  'model = "some-model"',
  '[mcp_servers.markitdown]',
  'command = "markitdown-mcp"',
  '[mcp_servers.markitdown.env]',
  `TOKEN = "${SECRET}"`,
  '[mcp_servers."openai docs"]',
  `url = "https://developers.openai.com/mcp?k=${SECRET}"`,
  'enabled = false',
  '',
].join('\n'));

ext.activate(stub.context);
const web = stub.openWebview('claudeSessionChanges.mcp');
web.send({ type: 'ready' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 6000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return; await sleep(30); }
  assert.fail('기다렸지만 안 됨: ' + what);
}
const sec = (p, id) => (p.sections || []).find((s) => s.id === id);
const rowOf = (p, id, label) => { const s = sec(p, id); return s && s.rows.find((r) => r.label === label); };
const renders = () => web.posted.filter((m) => m.type === 'render').length;
const toasts = (kind) => stub.calls.filter((c) => c[0] === kind).map((c) => c[1]);

test('이 폴더 기준으로 칸마다 서버가 나오고, 비밀 값은 화면으로 가지 않는다', () => {
  const p = web.lastPayload();
  assert.ok(p && p.sections, '그릴 내용');
  assert.deepStrictEqual(sec(p, 'user').rows.map((r) => [r.label, r.type, r.state, r.can]), [['docs', 'http', 'on', true], ['files', 'stdio', 'on', true]]);
  assert.deepStrictEqual(sec(p, 'local').rows.map((r) => [r.label, r.type]), [['db', 'stdio']]);
  // 프로젝트 서버: 승인됨(켜짐)·승인 대기·거절됨(스위치 잠김)
  assert.deepStrictEqual(sec(p, 'project').rows.map((r) => [r.label, r.state, r.can]), [['lint', 'on', true], ['search', 'pending', true], ['legacy', 'rejected', false]]);
  assert.match(rowOf(p, 'project', 'legacy').why, /rejected/);
  // claude.ai 커넥터는 이름만(설정 파일의 연결 기록), 이 폴더에서 끈 것은 꺼짐
  assert.deepStrictEqual(sec(p, 'claudeai').rows.map((r) => [r.label, r.state, r.on]), [['Gmail', 'off', false], ['Notion', 'on', true], ['Old', 'on', true]]);
  assert.deepStrictEqual(sec(p, 'plugins').rows, []);
  assert.match(sec(p, 'plugins').note, /Check status/);
  // Codex도 스위치(config.toml, 모든 폴더)
  assert.deepStrictEqual(sec(p, 'codex').rows.map((r) => [r.label, r.type, r.on, r.can]), [['markitdown', 'stdio', true, true], ['openai docs', 'http', false, true]]);
  assert.match(p.keyNote, /whole repository/, '하위 폴더를 열었으면 저장소 기준이라고 알린다');
  assert.strictEqual(p.writeNote, '');
  const out = JSON.stringify(p) + web.view.webview.html;
  assert.ok(!out.includes(SECRET), '명령·주소·헤더·환경 변수 값은 내보내지 않는다');
  assert.ok(!out.includes('files-mcp') && !out.includes('docs.example.com'), '명령 줄·주소도 내보내지 않는다');
});

test('끄면 이 폴더 항목의 disabledMcpServers에만 더하고, 나머지 내용·형식·권한은 그대로', async () => {
  const before = base();
  stub.calls.length = 0;
  web.send({ type: 'toggle', name: 'files', off: true });
  await waitFor(() => toasts('info').length === 1, '알림');
  const after = readCfg();
  assert.deepStrictEqual(after.projects[project].disabledMcpServers, ['claude.ai Gmail', 'files']);
  before.projects[project].disabledMcpServers = ['claude.ai Gmail', 'files'];
  assert.strictEqual(fs.readFileSync(CFG, 'utf8'), JSON.stringify(before, null, 2), 'Claude Code와 같은 형식(2칸 들여쓰기, 끝 줄바꿈 없음), 다른 칸은 그대로');
  assert.strictEqual(fs.statSync(CFG).mode & 0o777, 0o600, '파일 권한 유지');
  assert.ok(!fs.existsSync(CFG + '.lock'), '잠금은 풀어 둔다');
  assert.ok(!fs.readdirSync(home).some((f) => f.startsWith('.claude.json.tmp.')), '임시 파일이 남지 않는다');
  assert.match(toasts('info')[0], /files is off in this folder\. New Claude sessions start without it/);
  await waitFor(() => rowOf(web.lastPayload(), 'user', 'files').state === 'off', '줄이 꺼짐으로');
  assert.strictEqual(web.lastPayload().last.name, 'files');
  // 다른 폴더 항목은 건드리지 않는다
  assert.deepStrictEqual(after.projects['/elsewhere/app'].disabledMcpServers, ['docs']);
  await sleep(1700); // 저장 뒤 다시 읽어 확인: 남아 있으니 경고 없음
  assert.deepStrictEqual(toasts('warn'), []);
});

test('화면 맨 위 "되돌리기"와 알림의 "되돌리기"로 다시 켠다', async () => {
  web.send({ type: 'undo' });
  await waitFor(() => !readCfg().projects[project].disabledMcpServers.includes('files'), '되돌리기');
  await waitFor(() => rowOf(web.lastPayload(), 'user', 'files').state === 'on', '줄이 켜짐으로');
  stub.calls.length = 0;
  let clicked = false; // 한 번만 누른다(다시 켠 알림에도 되돌리기가 있다)
  stub.state.answer = (m, b) => { if (!clicked && b.includes('Undo')) { clicked = true; return 'Undo'; } return undefined; };
  web.send({ type: 'toggle', name: 'docs', off: true });
  await waitFor(() => toasts('info').length >= 2, '끄고 알림의 되돌리기로 다시 켬');
  stub.state.answer = undefined;
  await waitFor(() => !readCfg().projects[project].disabledMcpServers.includes('docs'), '알림 되돌리기');
  assert.match(toasts('info')[1], /docs is on again in this folder/);
  await sleep(1700);
});

test('화면에 스위치로 없던 이름·거절된 프로젝트 서버는 바꾸지 않는다', async () => {
  const text = fs.readFileSync(CFG, 'utf8');
  web.send({ type: 'toggle', name: 'not-a-server', off: true });
  web.send({ type: 'toggle', name: 'legacy', off: false });
  await sleep(300);
  assert.strictEqual(fs.readFileSync(CFG, 'utf8'), text);
});

test('다른 프로그램이 잠가 두었으면 기다렸다가 포기하고, 남의 잠금은 지우지 않는다', async () => {
  const text = fs.readFileSync(CFG, 'utf8');
  fs.mkdirSync(CFG + '.lock');
  const t0 = Date.now();
  const r = await mcp.setDisabled(sub, 'files', true, { waitMs: 300 });
  assert.deepStrictEqual(r, { ok: false, reason: 'busy' });
  assert.ok(Date.now() - t0 >= 280, '잠깐 기다린다');
  assert.ok(fs.existsSync(CFG + '.lock'));
  assert.strictEqual(fs.readFileSync(CFG, 'utf8'), text);
  // 잠금이 곧 풀리면 이어서 쓴다
  setTimeout(() => fs.rmdirSync(CFG + '.lock'), 200);
  const r2 = await mcp.setDisabled(sub, 'files', true, { waitMs: 3000 });
  assert.deepStrictEqual(r2, { ok: true, changed: true });
  assert.deepStrictEqual(await mcp.setDisabled(sub, 'files', true), { ok: true, changed: false }, '이미 꺼져 있으면 쓰지 않는다');
  assert.deepStrictEqual(await mcp.setDisabled(sub, 'files', false), { ok: true, changed: true });
});

test('이 폴더에서 Claude Code를 연 적이 없으면 항목을 만들지 않고 안내한다', async () => {
  const fresh = path.join(home, 'work', 'fresh-app');
  fs.mkdirSync(fresh, { recursive: true });
  const text = fs.readFileSync(CFG, 'utf8');
  assert.deepStrictEqual(await mcp.setDisabled(fresh, 'docs', true), { ok: false, reason: 'noProject' });
  assert.strictEqual(fs.readFileSync(CFG, 'utf8'), text);
  const info = mcp.listServers(fresh);
  assert.strictEqual(info.hasProject, false);
  assert.strictEqual(info.key, fresh, 'git 저장소가 아니면 폴더 자체가 열쇠');
  assert.strictEqual(mcp.projectKey(sub), project, '하위 폴더는 저장소 뿌리');
});

test('저장한 직후 다른 프로그램이 예전 내용으로 덮어쓰면 알린다', async () => {
  const old = fs.readFileSync(CFG, 'utf8');
  stub.calls.length = 0;
  web.send({ type: 'toggle', name: 'db', off: true });
  await waitFor(() => readCfg().projects[project].disabledMcpServers.includes('db'), '저장');
  fs.writeFileSync(CFG, old); // 예전 내용을 들고 있던 프로그램이 다시 씀
  await waitFor(() => toasts('warn').some((m) => /did not stay/.test(m)), '덮어쓰기 경고', 4000);
});

test('다른 세션이 설정 파일을 바꾸면(/mcp disable 등) 창이 다시 그린다', async () => {
  const n = renders();
  const d = readCfg();
  d.projects[project].disabledMcpServers = ['claude.ai Notion'];
  fs.writeFileSync(CFG, JSON.stringify(d, null, 2));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(CFG, t, t);
  await waitFor(() => renders() > n && rowOf(web.lastPayload(), 'claudeai', 'Notion').state === 'off', '파일 변경 반영', 7000);
});

test('상태 확인: claude mcp list 결과를 읽고(가운데 명령·주소는 버림), 플러그인 서버를 플러그인별로 보여 준다', async () => {
  const bin = path.join(home, 'fake-claude');
  const log = path.join(home, 'fake-claude.log');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$PWD|$*" > '${log}'\ncat <<'X'\nChecking MCP server health…\n\ndocs: https://docs.example.com/mcp?key=${SECRET} (HTTP) - ✔ Connected\nfiles: files-mcp --token ${SECRET} - ✘ Failed to connect — could not reach https://files.example.com/x?token=${SECRET} - retry\ndb: db-mcp - ⊘ Disabled for this project (re-enable via /mcp)\nclaude.ai Notion: https://mcp.notion.example - ⊘ Disabled for this project (re-enable via /mcp)\nclaude.ai Gmail: https://gmail.example - ! Needs authentication\nplugin:productivity:slack: https://slack.example - ! Needs authentication\nplugin:productivity:gmail:  - Not configured\nplugin:pdf-viewer:pdf: node server.js - ✔ Connected\nlint: lint-mcp - ⏸ Pending approval (run \`claude\` to approve)\nmanaged-x: https://corp.example - ✔ Connected\nX\n`);
  fs.chmodSync(bin, 0o755);
  ext._test.setClaudeBin(bin);
  web.send({ type: 'check' });
  await waitFor(() => web.lastPayload().checking === true, '확인 중 표시');
  await waitFor(() => web.lastPayload().checked, '확인 끝', 8000);
  assert.strictEqual(fs.readFileSync(log, 'utf8').trim(), sub + '|mcp list', '이 폴더에서 mcp list를 돌린다');
  const p = web.lastPayload();
  assert.strictEqual(rowOf(p, 'user', 'docs').state, 'ok');
  const files = rowOf(p, 'user', 'files');
  assert.strictEqual(files.state, 'fail');
  assert.strictEqual(files.detail, 'could not reach https://files.example.com - retry', '오류 설명의 주소는 호스트까지만');
  assert.strictEqual(rowOf(p, 'claudeai', 'Gmail').state, 'auth', '설정 파일에서 다시 켠 것은 확인 결과를 따른다');
  assert.strictEqual(rowOf(p, 'project', 'lint').state, 'pending');
  assert.strictEqual(rowOf(p, 'claudeai', 'Old').state, 'gone', '연결 기록에만 있고 확인 결과에 없는 커넥터');
  assert.strictEqual(rowOf(p, 'claudeai', 'Old').stateText, 'Not in the last check');
  // 서버가 둘인 플러그인은 머리줄로 묶고, 하나뿐인 플러그인은 "플러그인 · 서버"
  assert.deepStrictEqual(sec(p, 'plugins').rows.map((r) => [r.group, r.label, r.state]), [[undefined, 'pdf-viewer · pdf', 'ok'], ['productivity', 'gmail', 'unset'], ['productivity', 'slack', 'auth']]);
  assert.deepStrictEqual(sec(p, 'other').rows.map((r) => [r.label, r.state]), [['managed-x', 'ok']]);
  assert.strictEqual(sec(p, 'plugins').note, '');
  assert.ok(!JSON.stringify(p).includes(SECRET));
  // 플러그인 서버도 이 폴더에서 끌 수 있다(같은 칸)
  web.send({ type: 'toggle', name: 'plugin:productivity:slack', off: true });
  await waitFor(() => readCfg().projects[project].disabledMcpServers.includes('plugin:productivity:slack'), '플러그인 서버 끄기');
  await waitFor(() => rowOf(web.lastPayload(), 'plugins', 'slack').state === 'off', '줄 반영');
  await sleep(1700);
});

test('Claude Code 실행 파일이 없으면 이유를 보여 주고 지난 결과는 남긴다', async () => {
  ext._test.setClaudeBin(path.join(home, 'no-such-claude'));
  web.send({ type: 'check' });
  await waitFor(() => /Could not find the Claude Code program/.test(web.lastPayload().checkErr || ''), '오류 표시', 8000);
  assert.strictEqual(rowOf(web.lastPayload(), 'user', 'docs').state, 'ok', '지난 확인 결과는 그대로');
});

test('출력·설정 읽기 도우미', () => {
  const m = mcp.parseMcpList('a: x - y - ✔ Connected\nweird line\nb: cmd - ! Connected · tools fetch failed\nc:  - Not configured\n');
  assert.deepStrictEqual([...m.entries()].map(([k, v]) => [k, v.state]), [['a', 'ok'], ['b', 'warn'], ['c', 'unset']]);
  assert.deepStrictEqual(mcp.parseCodexMcp('[mcp_servers]\ninline = { command = "x", enabled = false }\nweb = { url = "https://w" }\n[other]\nenabled = false\n'), [
    { name: 'inline', type: 'stdio', enabled: false, inline: true }, { name: 'web', type: 'http', enabled: true, inline: true },
  ]);
  assert.strictEqual(mcp.cleanDetail('see https://h.example:8443/a/b?c=d and ws://x.example/y'), 'see https://h.example:8443 and ws://x.example');
});

test('MCP 창 화면 코드가 문법 오류 없이 읽히고 외부 자원을 막는다', () => {
  const m = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(web.view.webview.html);
  assert.ok(m);
  assert.doesNotThrow(() => new vm.Script(m[1]));
  assert.match(web.view.webview.html, /default-src 'none'/);
});

test('Codex 서버 끄고 켜기: config.toml의 그 표에 enabled 한 줄만 넣거나 바꾸고, 다른 줄·비밀 값은 그대로, 처음 한 번 원본을 남긴다', async () => {
  const CX = path.join(home, '.codex', 'config.toml');
  const original = fs.readFileSync(CX, 'utf8');
  stub.calls.length = 0;
  web.send({ type: 'toggle', name: 'codex:markitdown', off: true });
  await waitFor(() => /enabled = false/.test(fs.readFileSync(CX, 'utf8').split('[mcp_servers.markitdown.env]')[0]), 'markitdown 끔');
  const after = fs.readFileSync(CX, 'utf8');
  assert.strictEqual(after, original.replace('[mcp_servers.markitdown]\n', '[mcp_servers.markitdown]\nenabled = false\n'), '그 표 머리 바로 아래 한 줄만 들어간다');
  assert.strictEqual(fs.readFileSync(CX + '.watchtower-backup', 'utf8'), original, '처음 바꿀 때 원본을 한 번 남긴다');
  await waitFor(() => toasts('info').some((m) => /markitdown is off for Codex in every folder/.test(m)), '알림');
  await waitFor(() => rowOf(web.lastPayload(), 'codex', 'markitdown').on === false, '줄이 꺼짐으로');
  assert.match(web.lastPayload().last.text, /markitdown is off for Codex/);
  // 따옴표 이름 + 이미 enabled = false인 서버를 켜면 그 줄만 true로
  web.send({ type: 'toggle', name: 'codex:openai docs', off: false });
  await waitFor(() => /\[mcp_servers\."openai docs"\]\nurl = [^\n]+\nenabled = true\n/.test(fs.readFileSync(CX, 'utf8')), 'openai docs 켬');
  assert.ok(fs.readFileSync(CX, 'utf8').includes(SECRET), '다른 값(비밀 포함)은 그대로 둔다');
  // 되돌리기
  web.send({ type: 'undo' });
  await waitFor(() => /\[mcp_servers\."openai docs"\]\nurl = [^\n]+\nenabled = false\n/.test(fs.readFileSync(CX, 'utf8')), '되돌리기');
  await sleep(1700);
  assert.ok(!toasts('warn').some((m) => /did not stay/.test(m)), '저장한 값이 남아 있다');
  // 한 줄 표 꼴은 고치지 않는다
  const inl = path.join(home, 'inline-codex');
  fs.mkdirSync(inl, { recursive: true });
  fs.writeFileSync(path.join(inl, 'config.toml'), '[mcp_servers]\nfoo = { command = "x" }\n');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = inl;
  try {
    assert.deepStrictEqual(mcp.setCodexEnabled('foo', false), { ok: false, reason: 'inline' });
    assert.deepStrictEqual(mcp.setCodexEnabled('nope', false), { ok: false, reason: 'missing' });
  } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
  assert.strictEqual(fs.readFileSync(path.join(inl, 'config.toml'), 'utf8'), '[mcp_servers]\nfoo = { command = "x" }\n');
});

test.after(() => { ext.deactivate(); });
