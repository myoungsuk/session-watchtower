'use strict';
// MCP 서버 목록과 이 폴더에서 끄고 켜기(vscode 없이 돌아가는 부분).
// 끄고 켜기는 Claude Code의 `/mcp disable`·`/mcp enable`과 같은 곳에 쓴다:
// ~/.claude.json 의 projects[<저장소 뿌리 또는 폴더>].disabledMcpServers.
// Claude Code처럼 `<설정 파일>.lock` 폴더로 잠그고, 잠근 채 다시 읽어 그 한 칸만 바꾼 뒤 임시 파일 + 이름 바꾸기로 쓴다.
// 서버 설정의 명령·주소·환경 변수·헤더 값은 읽어도 밖으로 내보내지 않는다(이름·종류만).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const LOCK_WAIT_MS = 4000;
const LIST_TIMEOUT_MS = 90000;

function claudeConfigPath() {
  const d = process.env.CLAUDE_CONFIG_DIR;
  return d ? path.join(d, '.claude.json') : path.join(os.homedir(), '.claude.json');
}
function claudeSettingsPath() {
  const d = process.env.CLAUDE_CONFIG_DIR;
  return path.join(d || path.join(os.homedir(), '.claude'), 'settings.json');
}
function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}

// Claude Code가 프로젝트 설정을 찾는 열쇠: 폴더가 든 git 저장소의 뿌리(.git 폴더나 파일이 있는 곳), 없으면 그 폴더
function projectKey(folder) {
  const start = path.resolve(folder);
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) { d = start; break; }
    d = up;
  }
  return process.platform === 'win32' ? d.replace(/\\/g, '/') : d;
}

function readJson(file) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, missing: e && e.code === 'ENOENT', err: e }; }
}
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const typeOf = (v) => (v && typeof v === 'object' ? (typeof v.type === 'string' ? v.type : v.url ? 'http' : 'stdio') : 'stdio');
const namesOf = (servers) => (servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers).map((name) => ({ name, type: typeOf(servers[name]) })) : []);

// Codex 설정(config.toml)에서 [mcp_servers.<이름>] 표의 이름·종류·enabled만 읽는다. 값(명령·주소·env)은 보지 않는다.
function parseCodexMcp(text) {
  const out = [];
  let cur = null;
  let inTable = false; // [mcp_servers] 표 안(이름 = { … } 한 줄 꼴)
  const unq = (s) => s.replace(/^"(.*)"$|^'(.*)'$/, (m, a, b) => (a !== undefined ? a : b));
  for (const line0 of String(text).split(/\r?\n/)) {
    const line = line0.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const h = /^\[\s*([^\]]+?)\s*\](\s*#.*)?$/.exec(line);
    if (h && !line.startsWith('[[')) {
      const parts = h[1].match(/"[^"]*"|'[^']*'|[^.\s]+/g) || [];
      inTable = parts.length === 1 && parts[0] === 'mcp_servers';
      cur = null;
      if (parts[0] === 'mcp_servers' && parts.length === 2) {
        const name = unq(parts[1]);
        cur = out.find((s) => s.name === name);
        if (!cur) { cur = { name, type: 'stdio', enabled: true }; out.push(cur); }
      }
      continue;
    }
    if (line.startsWith('[[')) { cur = null; inTable = false; continue; }
    const kv = /^("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (cur) {
      const k = unq(kv[1]);
      if (k === 'url') cur.type = 'http';
      else if (k === 'enabled') cur.enabled = !/^false\b/.test(kv[2]);
    } else if (inTable && kv[2].startsWith('{')) {
      const name = unq(kv[1]);
      out.push({ name, type: /\burl\s*=/.test(kv[2]) ? 'http' : 'stdio', enabled: !/\benabled\s*=\s*false\b/.test(kv[2]) });
    }
  }
  return out;
}

// .mcp.json(프로젝트 서버)은 폴더에서 저장소 뿌리까지 올라가며 모은다(가까운 것이 이긴다)
function projectServers(folder, key) {
  const dirs = [];
  let d = path.resolve(folder);
  const stop = path.resolve(key);
  for (;;) {
    dirs.push(d);
    if (d === stop) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const seen = new Map();
  for (const dir of dirs.reverse()) {
    const j = readJson(path.join(dir, '.mcp.json'));
    if (j.ok && j.data) for (const s of namesOf(j.data.mcpServers)) seen.set(s.name, s);
  }
  return [...seen.values()];
}

// .mcp.json 서버를 쓰기로 했는지: 승인(enabled·enableAll)·거절(disabledMcpjsonServers)·아직(대기)
function approvals(folder, key, proj) {
  const lists = { on: new Set(), off: new Set(), all: false };
  const add = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const n of arr(o.enabledMcpjsonServers)) lists.on.add(n);
    for (const n of arr(o.disabledMcpjsonServers)) lists.off.add(n);
    if (o.enableAllProjectMcpServers === true) lists.all = true;
  };
  add(proj);
  const r = readJson(claudeSettingsPath());
  if (r.ok) add(r.data);
  for (const dir of new Set([path.resolve(folder), path.resolve(key)])) {
    for (const f of ['settings.json', 'settings.local.json']) {
      const j = readJson(path.join(dir, '.claude', f));
      if (j.ok) add(j.data);
    }
  }
  return (name) => (lists.off.has(name) ? 'rejected' : lists.all || lists.on.has(name) ? 'approved' : 'pending');
}

// 이 폴더 기준의 서버 목록(설정 파일만 읽음, 서버를 띄우지 않음)
function listServers(folder) {
  const file = claudeConfigPath();
  const key = projectKey(folder);
  const r = readJson(file);
  const data = r.ok && r.data && typeof r.data === 'object' ? r.data : {};
  const proj = data.projects && typeof data.projects === 'object' ? data.projects[key] : undefined;
  const approval = approvals(folder, key, proj);
  const cx = (() => { try { return { ok: true, list: parseCodexMcp(fs.readFileSync(codexConfigPath(), 'utf8')) }; } catch (e) { return { ok: false, missing: e && e.code === 'ENOENT', list: [] }; } })();
  return {
    folder: path.resolve(folder),
    key,
    configOk: r.ok,
    configMissing: !!r.missing,
    hasProject: !!(proj && typeof proj === 'object'),
    disabled: proj ? arr(proj.disabledMcpServers) : [],
    user: namesOf(data.mcpServers),
    local: proj ? namesOf(proj.mcpServers) : [],
    project: projectServers(folder, key).map((s) => ({ ...s, approval: approval(s.name) })),
    claudeAi: arr(data.claudeAiMcpEverConnected),
    codex: cx.list,
    codexOk: cx.ok,
    codexMissing: !!cx.missing,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 설정 파일 잠그기: Claude Code와 같은 `<파일>.lock` 폴더. 다른 쪽이 쥐고 있으면 잠깐 기다렸다가 포기한다(남의 잠금은 지우지 않는다)
async function withLock(file, fn, waitMs = LOCK_WAIT_MS) {
  const lock = file + '.lock';
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      if (Date.now() > until) return { ok: false, reason: 'busy' };
      await sleep(80 + Math.random() * 120);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* 이미 없음 */ } }
}

function writeAtomic(file, text) {
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* 새 파일 */ }
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* 새 파일 */ }
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 없음 */ }
    throw e;
  }
}

// 이 폴더에서 서버 하나를 끄거나(off=true) 켠다. 결과: { ok, changed } 또는 { ok:false, reason: busy|read|noProject|write }
async function setDisabled(folder, name, off, opts = {}) {
  const file = claudeConfigPath();
  const key = projectKey(folder);
  return withLock(file, () => {
    let text;
    let data;
    try { text = fs.readFileSync(file, 'utf8'); data = JSON.parse(text); } catch { return { ok: false, reason: 'read' }; }
    const proj = data && data.projects && typeof data.projects === 'object' ? data.projects[key] : undefined;
    // 이 폴더에서 Claude Code를 연 적이 없으면 항목을 새로 만들지 않는다(Claude Code가 기본값을 채워 만드는 항목이라)
    if (!proj || typeof proj !== 'object') return { ok: false, reason: 'noProject' };
    const list = Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : [];
    if (list.includes(name) === off) return { ok: true, changed: false };
    const next = off ? [...list, name] : list.filter((n) => n !== name);
    data.projects[key] = { ...proj, disabledMcpServers: next };
    const out = JSON.stringify(data, null, 2) + (text.endsWith('\n') ? '\n' : '');
    try { writeAtomic(file, out); } catch { return { ok: false, reason: 'write' }; }
    return { ok: true, changed: true };
  }, opts.waitMs);
}

// 지금 이 폴더에서 꺼져 있는지(저장 뒤 다시 읽어 확인할 때)
function isDisabled(folder, name) {
  const r = readJson(claudeConfigPath());
  const key = projectKey(folder);
  const proj = r.ok && r.data && r.data.projects ? r.data.projects[key] : undefined;
  return proj ? arr(proj.disabledMcpServers).includes(name) : false;
}

// 오류 설명의 주소는 호스트까지만 남긴다(경로·질의 문자열에 열쇠가 들어 있을 수 있다)
function cleanDetail(s) {
  return String(s || '').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (u) => { try { const x = new URL(u); return x.protocol + '//' + x.host; } catch { return '…'; } }).slice(0, 200);
}

function stateOf(status) {
  if (/Disabled for this project|^\s*⊘/.test(status)) return 'off';
  if (/Pending approval|^\s*⏸/.test(status)) return 'pending';
  if (/Rejected/.test(status)) return 'rejected';
  if (/Needs authentication/.test(status)) return 'auth';
  if (/Not configured/.test(status)) return 'unset';
  if (/Failed to connect|Connection error|^\s*[✘✗]/.test(status)) return 'fail';
  if (/Connected/.test(status)) return /fetch failed|^\s*!/.test(status) ? 'warn' : 'ok';
  return 'other';
}

// `claude mcp list` 출력: "이름: 명령 또는 주소 - 상태". 가운데(명령·주소)는 버린다.
function parseMcpList(stdout) {
  const out = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^(.+?): .*? - ((?:[✔✓!✘✗⊘⏸]|Not configured|Connected|Failed|Pending|Disabled|Rejected|Needs).*)$/.exec(line);
    if (!m) continue;
    const status = m[2];
    const dash = status.indexOf(' — ');
    out.set(m[1], { state: stateOf(status), detail: dash > 0 ? cleanDetail(status.slice(dash + 3)) : '' });
  }
  return out;
}

// 상태 확인: Claude Code가 세션을 시작할 때처럼 서버마다 실제로 붙어 본다(stdio 서버는 잠깐 실행된다). 결과: { ok, servers, err }
function checkStatus(bin, folder, timeoutMs = LIST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    execFile(bin, ['mcp', 'list'], { cwd: folder, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: win && !/\.exe$/i.test(bin), env: process.env }, (err, stdout) => {
      const servers = parseMcpList(stdout || '');
      if (err && !servers.size) resolve({ ok: false, err: err.code === 'ENOENT' ? 'nobin' : err.killed ? 'timeout' : 'failed' });
      else resolve({ ok: true, servers, empty: /No MCP servers configured/.test(stdout || '') });
    });
  });
}

module.exports = { claudeConfigPath, codexConfigPath, projectKey, listServers, setDisabled, isDisabled, parseMcpList, parseCodexMcp, checkStatus, cleanDetail, withLock };
