'use strict';
// 휴대폰 보드(따로 설치한 session-board) 잇기 — vscode 없이 돌아가는 부분.
// 확장은 보드를 켜거나 끄지 않는다. 이미 떠 있는 보드를 찾고(/healthz의 X-Session-Board 머리로 확인),
// 보드 폴더의 `cli.js pair`로 휴대폰 연결 링크·코드를 받아 QR로 그린다. 링크·코드는 저장하지 않는다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const PROBE_MS = 1500;
const PAIR_MS = 20000;

// 127.0.0.1:<port>/healthz → { port, label } 또는 null. 포트 번호만 믿지 않는다(원격 창에서 넘겨받은 다른 컴퓨터의 포트일 수 있어 이름도 본다)
function probe(port, timeoutMs = PROBE_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs, agent: false, headers: { Accept: 'text/plain', Connection: 'close' } }, (res) => {
      res.resume();
      const ok = res.statusCode === 200 && String(res.headers['x-session-board'] || '') === '1';
      let label = '';
      try { label = decodeURIComponent(String(res.headers['x-session-board-label'] || '')); } catch { label = ''; }
      finish(ok ? { port, label: label.replace(/[\u0000-\u001f<>]/g, '').slice(0, 60) } : null);
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

async function findBoards(ports) {
  const list = [...new Set((ports || []).map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536))].slice(0, 8);
  const res = await Promise.all(list.map((p) => probe(p)));
  return res.filter(Boolean);
}

// 이 컴퓨터에 설치된 보드가 스스로 적어 두는 실행 정보(있을 때만): <상태 폴더>/run.json = { port, label }.
// 이게 있으면 포트를 훑지 않고 그 보드 하나만 본다(다른 컴퓨터에서 넘겨받은 포트를 이 컴퓨터 보드로 착각하지 않게)
function localRun() {
  const dir = process.env.BOARD_STATE_DIR || path.join(os.homedir(), '.config', 'session-board');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    const port = Number(j && j.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? { port, label: typeof j.label === 'string' ? j.label.slice(0, 60) : '' } : null;
  } catch { return null; }
}

// 보드 폴더: 설정값, 없으면 흔한 자리(~/tools/session-board)에 cli.js가 있을 때만
function boardFolder(setting) {
  const cands = [];
  if (setting) cands.push(setting.replace(/^~(?=$|[\\/])/, os.homedir()));
  else cands.push(path.join(os.homedir(), 'tools', 'session-board'));
  for (const d of cands) { try { if (fs.statSync(path.join(d, 'cli.js')).isFile()) return d; } catch { /* 없음 */ } }
  return null;
}

// `cli.js pair` 출력에서 링크 한 줄(…/pair?c=코드)과 "코드: …" 줄의 코드만 읽는다(코드 줄 뒤의 설명·앞의 QR 그림 줄은 버림).
// 사설망 주소를 못 찾은 보드는 http://127.0.0.1… 링크를 내는데, 휴대폰에서는 열리지 않으니 local로 표시한다
function parsePair(stdout) {
  const text = String(stdout || '');
  const m = text.match(/^(https?:\/\/\S+\/pair\?c=([A-Za-z0-9_-]{4,64}))\s*$/m);
  if (!m) return null;
  const code = (text.match(/^\s*(?:코드|[Cc]ode)\s*[:：]\s*([A-Za-z0-9_-]{4,64})/m) || [])[1] || m[2];
  const until = (text.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*까지/) || text.match(/until\s+(\d{1,2}:\d{2}(?::\d{2})?)/i) || [])[1] || '';
  return { url: m[1], code, until, local: !/^https:\/\//.test(m[1]) };
}

// 확장의 node(데스크톱 VS Code에서는 Electron을 node로)로 보드 폴더의 cli.js pair를 돌린다
function pair(folder, timeoutMs = PAIR_MS) {
  return new Promise((resolve) => {
    const cli = path.join(folder, 'cli.js');
    execFile(process.execPath, [cli, 'pair'], { cwd: folder, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, stdout) => {
      const p = parsePair(stdout);
      if (p) resolve({ ok: true, ...p });
      else resolve({ ok: false, err: err && err.killed ? 'timeout' : 'failed' });
    });
  });
}

// QR(오류 정정 M)을 SVG로. 흰 바탕에 검은 칸이라 어두운 테마에서도 휴대폰이 읽는다
function qrSvg(text, cell = 6) {
  const QRCode = require('./vendor/qrcode');
  const QRErrorCorrectLevel = require('./vendor/qrcode/QRErrorCorrectLevel');
  const q = new QRCode(-1, QRErrorCorrectLevel.M);
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const quiet = 4;
  const size = (n + quiet * 2) * cell;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${(c + quiet) * cell} ${(r + quiet) * cell}h${cell}v${cell}h-${cell}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { probe, findBoards, localRun, boardFolder, parsePair, pair, qrSvg };
