'use strict';
// Codex 대화 이름 바꾸기(vscode 없이 돌아가는 부분).
// Codex가 이름을 바꿀 때 쓰는 공식 통로(app-server의 thread/name/set)를 그대로 쓴다:
// `codex app-server`를 잠깐 띄워 표준 입출력으로 initialize → thread/name/set만 보내고 바로 끈다.
// Codex가 ~/.codex/session_index.jsonl과 자기 DB에 함께 적는다. 이 확장은 Codex 파일을 직접 고치지 않는다.
// 이름은 명령줄 인자가 아니라 표준 입력의 JSON으로만 넘긴다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { programExists } = require('./findbin');

const SET_TIMEOUT_MS = 20000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// 쓸 Codex 프로그램: ① VS Code Codex 확장(openai.chatgpt)에 든 것 ② PATH의 codex
// extPaths: 확장 폴더 후보(설치된 openai.chatgpt 확장의 extensionPath)
function findCodexBin(extPaths, platform = process.platform) {
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  for (const ext of extPaths || []) {
    if (!ext) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(ext, 'bin'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const d of dirs) {
      const f = path.join(ext, 'bin', d, exe);
      try { if (fs.statSync(f).isFile()) return { cmd: f, shell: false }; } catch { /* 없음 */ }
    }
  }
  // PATH의 codex: Windows의 npm 설치는 codex.cmd라 셸로 찾는다(인자는 고정된 app-server 하나뿐)
  return { cmd: 'codex', shell: platform === 'win32' };
}

// 성공이면 { ok: true }, 아니면 { ok: false, reason: 'missing' | 'timeout' | 'rpc' | 'exit', message }
function setCodexThreadName({ bin, threadId, name, home, timeoutMs = SET_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!UUID_RE.test(String(threadId || ''))) return resolve({ ok: false, reason: 'rpc', message: 'bad thread id' });
    const title = String(name || '').replace(/\s+/g, ' ').trim();
    if (!title) return resolve({ ok: false, reason: 'rpc', message: 'empty name' });
    const b = bin || findCodexBin([]);
    // Through the shell a missing program gives no ENOENT, so check first
    if (b.shell && !programExists(b.cmd)) return resolve({ ok: false, reason: 'missing', message: 'codex not found' });
    let child;
    try {
      child = spawn(b.cmd, ['app-server'], { shell: !!b.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CODEX_HOME: home || codexHome() } });
    } catch (e) {
      return resolve({ ok: false, reason: 'missing', message: String((e && e.message) || e) });
    }
    let done = false;
    let buf = '';
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* 이미 닫힘 */ }
      try { child.kill(); } catch { /* 이미 끝남 */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', message: 'codex app-server did not answer' }), timeoutMs);
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* 끝난 뒤 */ } };
    child.on('error', (e) => finish({ ok: false, reason: e && e.code === 'ENOENT' ? 'missing' : 'exit', message: String((e && e.message) || e) }));
    child.on('exit', (code) => finish({ ok: false, reason: code === 127 || code === 9009 ? 'missing' : 'exit', message: 'codex app-server exited (' + code + ')' }));
    child.stdin.on('error', () => { /* 프로그램이 먼저 끝남: exit에서 처리 */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.id === 1) {
          if (o.error) return finish({ ok: false, reason: 'rpc', message: String(o.error.message || 'initialize failed') });
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'thread/name/set', params: { threadId: String(threadId).toLowerCase(), name: title } });
        } else if (o.id === 2) {
          return finish(o.error ? { ok: false, reason: 'rpc', message: String(o.error.message || 'thread/name/set failed') } : { ok: true });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'session-watchtower', version: '0' } } });
  });
}

module.exports = { findCodexBin, setCodexThreadName, codexHome };
