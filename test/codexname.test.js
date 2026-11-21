'use strict';
// Codex 대화 이름: ~/.codex/session_index.jsonl 읽기(같은 id는 마지막 줄), 이름 바꾸기는 codex app-server의 thread/name/set으로만
// (가짜 codex로 보낸 내용·성공·오류·대답 없음·프로그램 없음), Codex 확장 안의 프로그램 찾기.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('./helpers/fixture');

fx.makeHome();
const { parseCodexIndex, codexNames } = require('../scanner');
const { findCodexBin, setCodexThreadName } = require('../codexname');

const { linkBin, win } = require('./helpers/fake-bin');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'swt-cx-'));
// Windows starts the .cmd stand-in through the shell, like an npm-installed codex.cmd
const FAKE = { cmd: linkBin(tmp(), 'codex', path.join(__dirname, 'helpers', 'fake-codex.js')), shell: win };
const ID = '01a1e6f3-d0a2-71d3-b842-1306c64643ca';

test('session_index.jsonl: 같은 id는 마지막 이름, 깨진 줄·빈 이름은 건너뛴다', () => {
  const m = parseCodexIndex([
    JSON.stringify({ id: ID, thread_name: '처음 이름' }),
    '{"id":"broken',
    JSON.stringify({ id: 'AAAAAAAA-0000-4000-8000-000000000000', thread_name: '  띄어   쓴  이름 ' }),
    JSON.stringify({ id: ID, thread_name: '바꾼 이름' }),
    JSON.stringify({ id: 'bbbbbbbb-0000-4000-8000-000000000000', thread_name: '   ' }),
    '',
  ].join('\n'));
  assert.strictEqual(m.get(ID), '바꾼 이름');
  assert.strictEqual(m.get('aaaaaaaa-0000-4000-8000-000000000000'), '띄어 쓴 이름', 'id는 소문자로, 이름의 공백은 하나로');
  assert.ok(!m.has('bbbbbbbb-0000-4000-8000-000000000000'));
});

test('session_index.jsonl이 바뀌면 다시 읽고, 없으면 빈 목록', () => {
  const d = tmp();
  const f = path.join(d, 'session_index.jsonl');
  assert.strictEqual(codexNames(f).size, 0);
  fs.writeFileSync(f, JSON.stringify({ id: ID, thread_name: 'A' }) + '\n');
  assert.strictEqual(codexNames(f).get(ID), 'A');
  fs.appendFileSync(f, JSON.stringify({ id: ID, thread_name: 'B 이름' }) + '\n');
  assert.strictEqual(codexNames(f).get(ID), 'B 이름');
});

test('Codex 프로그램 찾기: Codex 확장 안의 bin/<플랫폼>/codex를 먼저, 없으면 PATH의 codex', () => {
  const ext = tmp();
  assert.deepStrictEqual(findCodexBin([ext], 'linux'), { cmd: 'codex', shell: false });
  assert.deepStrictEqual(findCodexBin([], 'win32'), { cmd: 'codex', shell: true }, 'Windows의 npm 설치(codex.cmd)는 셸로 찾는다');
  fs.mkdirSync(path.join(ext, 'bin', 'linux-x86_64'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'bin', 'linux-x86_64', 'codex'), '');
  assert.deepStrictEqual(findCodexBin([undefined, ext], 'linux'), { cmd: path.join(ext, 'bin', 'linux-x86_64', 'codex'), shell: false });
  fs.mkdirSync(path.join(ext, 'bin', 'windows-x86_64'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'bin', 'windows-x86_64', 'codex.exe'), '');
  assert.deepStrictEqual(findCodexBin([ext], 'win32'), { cmd: path.join(ext, 'bin', 'windows-x86_64', 'codex.exe'), shell: false });
});

test('이름 바꾸기: initialize → initialized → thread/name/set만 보내고, Codex가 적은 이름이 목록에 읽힌다', async () => {
  const home = tmp();
  const log = path.join(home, 'rpc.log');
  process.env.FAKE_CODEX_LOG = log;
  try {
    const r = await setCodexThreadName({ bin: FAKE, threadId: ID.toUpperCase(), name: '  새   이름 ; rm -rf / ', home });
    assert.deepStrictEqual(r, { ok: true });
  } finally { delete process.env.FAKE_CODEX_LOG; }
  const sent = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(sent.map((o) => o.method), ['initialize', 'initialized', 'thread/name/set']);
  assert.deepStrictEqual(sent[2].params, { threadId: ID, name: '새 이름 ; rm -rf /' }, '이름은 명령줄이 아니라 JSON으로만 간다');
  assert.strictEqual(codexNames(path.join(home, 'session_index.jsonl')).get(ID), '새 이름 ; rm -rf /');
});

test('이름 바꾸기 실패: 오류 대답·대답 없음·바로 끝남·프로그램 없음·잘못된 id는 ok:false', async () => {
  const home = tmp();
  const run = async (mode, extra) => {
    process.env.FAKE_CODEX_MODE = mode;
    try { return await setCodexThreadName({ bin: FAKE, threadId: ID, name: 'x', home, ...extra }); } finally { delete process.env.FAKE_CODEX_MODE; }
  };
  assert.deepStrictEqual(await run('error'), { ok: false, reason: 'rpc', message: 'thread not found' });
  assert.strictEqual((await run('silent', { timeoutMs: 800 })).reason, 'timeout');
  assert.strictEqual((await run('exit')).reason, 'exit');
  assert.strictEqual((await setCodexThreadName({ bin: { cmd: path.join(home, 'no-such-codex'), shell: false }, threadId: ID, name: 'x', home })).reason, 'missing');
  assert.strictEqual((await setCodexThreadName({ bin: { cmd: path.join(home, 'no-such-codex'), shell: true }, threadId: ID, name: 'x', home })).reason, 'missing', 'through the shell too');
  assert.strictEqual((await setCodexThreadName({ bin: FAKE, threadId: '../etc', name: 'x', home })).ok, false);
  assert.ok(!fs.existsSync(path.join(home, 'session_index.jsonl')), '실패하면 아무것도 적히지 않는다');
});
