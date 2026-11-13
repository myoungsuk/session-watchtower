'use strict';
// 휴대폰 보드 잇기 시험: 떠 있는 보드를 /healthz 머리로만 알아보고(포트 번호만 믿지 않음), 보드가 적어 둔 run.json이 있으면 그 포트만 보며,
// 보드 폴더의 cli.js pair 출력에서 링크·코드만 읽어 QR과 함께 보여 준다. 링크·코드는 저장하지 않는다. 확장은 보드를 켜거나 끄지 않는다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const fx = require('./helpers/fixture');

const { home, project, markers } = fx.makeHome();
process.env.BOARD_STATE_DIR = path.join(home, 'board-state');
const pb = require('../phoneboard.js');

function serve(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
const board = (label) => (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'X-Session-Board': '1', 'X-Session-Board-Label': encodeURIComponent(label) }); res.end('ok'); return; }
  res.writeHead(404); res.end();
};

// 보드 폴더 대역: 진짜 cli.js pair처럼 QR 그림 줄·링크·만료·코드(뒤에 설명)·안내 줄을 찍는다
const folder = path.join(home, 'tools', 'session-board');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'cli.js'), [
  "if (process.argv[2] !== 'pair') process.exit(2);",
  "console.log('█▀▀▀▀▀█ ▄▀ █▀▀▀▀▀█');",
  "console.log('https://board.example.ts.net/pair?c=AB12CD34');",
  "console.log('(10분 안에 한 번만 쓸 수 있습니다: 오후 4:50:12까지)');",
  "console.log('코드: AB12CD34  (주소줄 없는 아이폰 홈 화면 앱·다른 서버 보드의 \"다른 서버\" 칸에는 이 코드만 넣으면 됨)');",
  "console.log('휴대폰: 이 링크를 Chrome·Safari에서 열기');",
].join('\n'));

let servers = [];
test.after(() => { for (const s of servers) s.close(); });

test('보드 알아보기: X-Session-Board 머리가 있어야 보드, 이름은 디코딩, 다른 서버·닫힌 포트는 아님', async () => {
  const a = await serve(board('95번 서버'));
  const other = await serve((req, res) => { res.writeHead(200); res.end('ok'); });
  servers.push(a, other);
  const pa = a.address().port;
  const po = other.address().port;
  assert.deepStrictEqual(await pb.probe(pa), { port: pa, label: '95번 서버' });
  assert.strictEqual(await pb.probe(po), null, '같은 /healthz라도 보드 머리가 없으면 아님');
  assert.strictEqual(await pb.probe(1), null, '닫힌 포트');
  assert.deepStrictEqual(await pb.findBoards([pa, po, pa, 'x', 70000]), [{ port: pa, label: '95번 서버' }], '겹친 포트·잘못된 값은 뺀다');
});

test('연결 링크: 보드 폴더의 cli.js pair 출력에서 링크와 코드만 읽고, 사설망 주소가 없으면 local로 표시한다', async () => {
  assert.strictEqual(pb.boardFolder(''), folder, '설정이 없으면 흔한 자리(~/tools/session-board)에 cli.js가 있을 때만');
  assert.strictEqual(pb.boardFolder(path.join(home, 'nope')), null);
  const r = await pb.pair(folder);
  assert.deepStrictEqual(r, { ok: true, url: 'https://board.example.ts.net/pair?c=AB12CD34', code: 'AB12CD34', until: '4:50:12', local: false });
  assert.deepStrictEqual(pb.parsePair('http://127.0.0.1:5290/pair?c=ZZ99YY88\n코드: ZZ99YY88  설명\n'), { url: 'http://127.0.0.1:5290/pair?c=ZZ99YY88', code: 'ZZ99YY88', until: '', local: true });
  assert.strictEqual(pb.parsePair('휴대폰: 이 링크를 Chrome·Safari에서 열기\n'), null);
  const svg = pb.qrSvg(r.url);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 (\d+) \1"/);
  assert.ok((svg.match(/h6v6h-6z/g) || []).length > 200, 'QR 칸을 그린다');
});

test('run.json이 있으면 포트를 훑지 않고 그 보드 하나만 본다(넘겨받은 다른 컴퓨터 포트를 착각하지 않게)', async () => {
  fs.mkdirSync(process.env.BOARD_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.BOARD_STATE_DIR, 'run.json'), JSON.stringify({ port: 5291, label: '85번 PC', pid: 1, at: Date.now() }));
  assert.deepStrictEqual(pb.localRun(), { port: 5291, label: '85번 PC' });
  fs.unlinkSync(path.join(process.env.BOARD_STATE_DIR, 'run.json'));
  assert.strictEqual(pb.localRun(), null);
});

test('확장: 보드가 켜져 있으면 세션 창에 단추, 누르면 QR·코드 패널, 복사는 누를 때만, 보드가 없으면 안내', async () => {
  const a = await serve(board('95번 서버'));
  const b = await serve(board('85번 PC'));
  servers.push(a, b);
  const stub = require('./helpers/vscode-stub').install({
    extDir: path.join(__dirname, '..'), language: 'en', workspace: project,
    config: { attentionMarkerDir: markers, pollSeconds: 2, notifyStuckMinutes: 0, notifyWaiting: false, 'phoneBoard.ports': [a.address().port, b.address().port] },
  });
  const ext = require('../extension.js');
  ext.activate(stub.context);
  const web = stub.openWebview('claudeSessionChanges.sessions');
  web.send({ type: 'ready' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = Date.now() + 9000;
  while (Date.now() < until && !(web.lastPayload() && web.lastPayload().phone)) await sleep(50);
  assert.match(web.lastPayload().phone, /Phone board on: 95번 서버, 85번 PC/);
  assert.match(web.view.webview.html, /id="btnPhone" hidden/);
  web.send({ type: 'phone' });
  const until2 = Date.now() + 9000;
  while (Date.now() < until2 && !(stub.state.panels || []).some((p) => p.viewType === 'claudeSessionChanges.phone')) await sleep(50);
  const panel = stub.state.panels.find((p) => p.viewType === 'claudeSessionChanges.phone');
  assert.ok(panel, '패널');
  const html = panel.webview.html;
  assert.match(html, /<svg /);
  assert.match(html, /AB12CD34/);
  assert.match(html, /until 4:50:12/);
  assert.match(html, /More than one board answers here \(95번 서버, 85번 PC\)\. This link is for the board installed in /, '보드가 둘이면 어느 보드 링크인지 밝힌다');
  assert.match(html, /default-src 'none'/);
  assert.notStrictEqual(stub.state.clipboard, 'AB12CD34', '누르기 전에는 복사하지 않는다');
  panel.send({ type: 'copyCode' });
  await sleep(20);
  assert.strictEqual(stub.state.clipboard, 'AB12CD34');
  panel.send({ type: 'copyLink' });
  await sleep(20);
  assert.strictEqual(stub.state.clipboard, 'https://board.example.ts.net/pair?c=AB12CD34');
  const stored = fs.readdirSync(stub.context.globalStorageUri.fsPath).map((f) => { try { return fs.readFileSync(path.join(stub.context.globalStorageUri.fsPath, f), 'utf8'); } catch { return ''; } }).join('');
  assert.ok(!stored.includes('AB12CD34'), '코드를 확장 저장소에 남기지 않는다');
  // 보드가 꺼지면 단추가 사라지고, 링크를 만들려 하면 안내한다
  a.close(); b.close();
  stub.calls.length = 0;
  stub.commands.get('claudeSessionChanges.phoneBoardPair')();
  const until3 = Date.now() + 9000;
  while (Date.now() < until3 && !stub.calls.some((c) => c[0] === 'warn')) await sleep(50);
  assert.match(stub.calls.find((c) => c[0] === 'warn')[1], /No phone board is running on this computer/);
  assert.strictEqual(web.lastPayload().phone, '');
  ext.deactivate();
});
