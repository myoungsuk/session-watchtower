'use strict';
// Claude Code 대화 기록(~/.claude/projects/**/*.jsonl)을 읽어 세션별 변경 파일을 모은다.
// vscode 모듈을 쓰지 않는다. worker 스레드와 시험 스크립트에서 함께 쓴다. 읽기 전용이다.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const REGISTRY = path.join(HOME, '.claude', 'sessions');
const CHUNK = 4 * 1024 * 1024;
const NL = 10;
const DISCOVERY_MS = 30000;

const B = (s) => Buffer.from(s, 'utf8');
const K_RESULT = B('"toolUseResult"');
const K_PATCH = B('"structuredPatch"');
const K_FILEPATH = B('"filePath"');
const K_BASHDIFF = B('"bashEditDiff"');
const K_GITOP = B('"gitOperation"');
const K_BASHUSE = B('"name":"Bash"');
const K_TOOLUSEID = B('"tool_use_id":"');
const K_CUSTOM = B('"type":"custom-title"');
const K_AI = B('"type":"ai-title"');
const K_USER = B('"type":"user"');
const K_STDOUT = B('"stdout"');
const K_TS = B('"timestamp":"');
const COMMIT_CMD_RE = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+(?:commit|merge|cherry-pick|revert|am|rebase)\b/;
const COMMIT_RE = /^\[([^\]\n]{1,120}?) ([0-9a-f]{7,40})\] (.*)$/m;
const SCRATCH_RE = /^\/tmp\/claude-[^/]+\//;
const TMP_CLAUDE = path.join(os.tmpdir(), 'claude-');

function countLines(s) {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === NL) n++;
  if (s.charCodeAt(s.length - 1) === NL) n--;
  return n;
}

function hunkCounts(hunks) {
  let add = 0;
  let del = 0;
  if (!Array.isArray(hunks)) return { add, del };
  for (const h of hunks) {
    for (const l of (h && h.lines) || []) {
      if (typeof l !== 'string') continue;
      if (l[0] === '+') add++;
      else if (l[0] === '-') del++;
    }
  }
  return { add, del };
}

function shortCmd(cmd) {
  const s = String(cmd || '').replace(/\s+/g, ' ').trim();
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

// ---------- 셸 명령에서 쓴 파일 추정 ----------

function tokenize(s) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === ' ' || c === '\t') {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

function stripHeredocBodies(cmd) {
  const lines = String(cmd).split('\n');
  const out = [];
  let ends = [];
  for (const line of lines) {
    if (ends.length) {
      const t = line.replace(/^\t+/, '').trim();
      if (t === ends[0]) ends.shift();
      continue;
    }
    out.push(line);
    const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
    let m;
    while ((m = re.exec(line))) ends.push(m[2]);
  }
  return out.join('\n');
}

function resolveTarget(p, cwd) {
  if (!p) return null;
  p = p.trim();
  if (!p || /[`*?]/.test(p)) return null;
  p = p.replace(/^\$\{HOME\}|^\$HOME/, HOME);
  if (p.includes('$')) return null;
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
  if (p.startsWith('/dev/') || p.startsWith('/proc/')) return null;
  if (!path.isAbsolute(p)) {
    if (!cwd) return null;
    p = path.resolve(cwd, p);
  }
  return path.normalize(p);
}

// 반환: 이 명령이 썼을 것으로 보이는 절대 경로 목록(존재·시간 검사는 호출한 쪽에서)
function shellTargets(cmd, cwd) {
  const out = new Set();
  const text = stripHeredocBodies(cmd);
  let cur = cwd;
  const segs = text.split(/\n|&&|\|\||;|\|/);
  for (const raw of segs) {
    const s = raw.trim();
    if (!s) continue;
    const cd = /^cd\s+(.+)$/.exec(s);
    if (cd) {
      const t = tokenize(cd[1]);
      const d = resolveTarget(t[0], cur);
      if (d) cur = d;
      continue;
    }
    const red = /(?:^|[^<>&0-9])(?:[12]?>>?|&>>?)(?!&)\s*("([^"]+)"|'([^']+)'|([^\s;&|<>()]+))/g;
    let m;
    while ((m = red.exec(s))) {
      const t = resolveTarget(m[2] || m[3] || m[4], cur);
      if (t) out.add(t);
    }
    const toks = tokenize(s.replace(/[<>].*$/, ''));
    let i = 0;
    while (i < toks.length && /^(sudo|env|command|nohup|time|[A-Z_][A-Z0-9_]*=.*)$/.test(toks[i])) i++;
    const prog = toks[i];
    const args = toks.slice(i + 1);
    const plain = args.filter((a) => !a.startsWith('-'));
    if (prog === 'tee') {
      for (const a of plain) { const t = resolveTarget(a, cur); if (t) out.add(t); }
    } else if (prog === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      const hasE = args.some((a) => a === '-e' || a === '--expression' || a === '-f');
      const files = hasE ? plain : plain.slice(1);
      for (const a of files) { const t = resolveTarget(a, cur); if (t) out.add(t); }
    } else if ((prog === 'cp' || prog === 'mv' || prog === 'install') && plain.length >= 2) {
      const dst = resolveTarget(plain[plain.length - 1], cur);
      if (dst) {
        let isDir = false;
        try { isDir = fs.statSync(dst).isDirectory(); } catch { /* 없음 */ }
        if (isDir) {
          for (const a of plain.slice(0, -1)) out.add(path.join(dst, path.basename(a)));
        } else out.add(dst);
      }
    } else if (prog === 'touch') {
      for (const a of plain) { const t = resolveTarget(a, cur); if (t) out.add(t); }
    } else if (prog === 'git' && (args[0] === 'checkout' || args[0] === 'restore')) {
      const dd = args.indexOf('--');
      if (dd >= 0) for (const a of args.slice(dd + 1)) { const t = resolveTarget(a, cur); if (t) out.add(t); }
    }
  }
  return [...out];
}

// ---------- 임시 파일 판정 ----------

const gitDirCache = new Map();
function hasGitUp(dir) {
  const stack = [];
  let d = dir;
  let found = false;
  while (d && d !== '/' && d !== '/tmp' && d !== os.tmpdir()) {
    if (gitDirCache.has(d)) { found = gitDirCache.get(d); break; }
    stack.push(d);
    try {
      if (fs.existsSync(path.join(d, '.git'))) { found = true; break; }
    } catch { /* 무시 */ }
    const parent = path.dirname(d);
    if (parent === d) break; // Windows 드라이브 뿌리(C:\) 등에서 멈춤
    d = parent;
  }
  for (const s of stack) gitDirCache.set(s, found);
  return found;
}

function isScratch(p) {
  if (!SCRATCH_RE.test(p) && !p.startsWith(TMP_CLAUDE)) return false;
  if (/\/tasks\/[^/]+$/.test(p)) return true;
  return !hasGitUp(path.dirname(p));
}

// ---------- 대화 기록 한 파일의 증분 읽기 ----------

function newFileState(d) {
  return {
    file: d.file,
    sid: d.sid,
    sub: d.sub,
    project: d.project,
    offset: 0,
    mtimeMs: 0,
    size: 0,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    cwd: null,
    changes: [],
    pendingBash: new Map(),
    commits: [],
    commitWins: [],
    seenSha: new Set(),
    userChecked: 0,
  };
}

function extractToolUseId(line) {
  const i = line.indexOf(K_TOOLUSEID);
  if (i < 0) return null;
  const s = i + K_TOOLUSEID.length;
  const e = line.indexOf(34, s); // '"'
  if (e < 0 || e - s > 80) return null;
  return line.toString('latin1', s, e);
}

function tsBefore(line) {
  const ri = line.indexOf(K_RESULT);
  let j = ri >= 0 ? line.lastIndexOf(K_TS, ri) : -1;
  if (j < 0) j = line.indexOf(K_TS);
  if (j < 0) return 0;
  const s = j + K_TS.length;
  const e = line.indexOf(34, s);
  if (e < 0 || e - s > 40) return 0;
  return Date.parse(line.toString('latin1', s, e)) || 0;
}

// 커밋 명령이 실행된 git 폴더(앞의 cd, git -C 반영)
function gitDirFor(cmd, cwd) {
  let cur = cwd;
  for (const raw of stripHeredocBodies(cmd).split(/\n|&&|\|\||;|\|/)) {
    const s = raw.trim();
    const cd = /^cd\s+(.+)$/.exec(s);
    if (cd) {
      const d = resolveTarget(tokenize(cd[1])[0], cur);
      if (d) cur = d;
      continue;
    }
    if (COMMIT_CMD_RE.test(s)) {
      const m = /\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(s);
      if (m) {
        const d = resolveTarget(m[2] || m[3] || m[4], cur);
        if (d) return d;
      }
      return cur;
    }
  }
  return cur;
}

function pushChange(st, c) {
  c.scratch = isScratch(c.path);
  c.sub = st.sub;
  c.file = c.file || st.file;
  st.changes.push(c);
}

function textOfUser(o) {
  const m = o.message;
  if (!m) return null;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    for (const x of m.content) if (x && x.type === 'text' && typeof x.text === 'string') return x.text;
  }
  return null;
}

function handleLine(st, line, absOffset) {
  const len = line.length;
  if (len < 2) return;

  if (!st.sub && (line.indexOf(K_CUSTOM) >= 0 || line.indexOf(K_AI) >= 0) && len < 20000) {
    try {
      const o = JSON.parse(line.toString('utf8'));
      if (o.type === 'custom-title' && o.customTitle) st.customTitle = String(o.customTitle);
      if (o.type === 'ai-title' && o.aiTitle) st.aiTitle = String(o.aiTitle);
    } catch { /* 깨진 줄 */ }
    return;
  }

  if (line.indexOf(K_RESULT) >= 0) {
    const id = extractToolUseId(line);
    const bash = id ? st.pendingBash.get(id) : null;
    if (bash) {
      st.pendingBash.delete(id);
      const hasDiff = line.indexOf(K_BASHDIFF) >= 0;
      const hasGit = line.indexOf(K_GITOP) >= 0;
      let str = null;
      let commitHit = false;
      if (!hasDiff && !hasGit && line.indexOf(K_STDOUT) >= 0 && len < 2000000) {
        str = line.toString('utf8');
        commitHit = /\[[^\]\n"]{1,120} [0-9a-f]{7,40}\] /.test(str);
      }
      let o = null;
      if (hasDiff || hasGit || commitHit) {
        try { o = JSON.parse(str || line.toString('utf8')); } catch { o = null; }
      }
      const r = o && o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : null;
      const ts = (o && Date.parse(o.timestamp)) || bash.ts;
      if (r && r.bashEditDiff && typeof r.bashEditDiff === 'object') {
        const bd = r.bashEditDiff;
        const files = Array.isArray(bd.files) ? bd.files : [];
        const byPath = new Map();
        files.forEach((x, i) => { if (x && typeof x.filePath === 'string') byPath.set(x.filePath, i); });
        const all = new Set([...(Array.isArray(bd.changedFiles) ? bd.changedFiles : []), ...byPath.keys()]);
        for (let p of all) {
          if (typeof p !== 'string' || !p) continue;
          if (!path.isAbsolute(p)) p = path.resolve(bash.cwd || st.cwd || '/', p);
          const i = byPath.has(p) ? byPath.get(p) : -1;
          const fx = i >= 0 ? files[i] : null;
          const cnt = hunkCounts(fx && fx.hunks);
          pushChange(st, {
            kind: 'bash', path: p, ts, add: cnt.add, del: cnt.del,
            created: !!(fx && fx.created), idx: i, offset: absOffset, length: len,
            cmd: bash.cmd, cwd: bash.cwd,
          });
        }
      } else {
        for (const t of shellTargets(bash.full, bash.cwd || st.cwd)) {
          let s;
          try { s = fs.statSync(t); } catch { continue; }
          if (!s.isFile() || s.mtimeMs < bash.ts - 2000) continue;
          pushChange(st, { kind: 'shell', path: t, ts: bash.ts, add: 0, del: 0, created: false, cmd: bash.cmd, cwd: bash.cwd });
        }
      }
      let sha = null;
      let msg = '';
      if (r && r.gitOperation && r.gitOperation.commit && r.gitOperation.commit.sha) sha = String(r.gitOperation.commit.sha);
      const so = r && typeof r.stdout === 'string' ? r.stdout : '';
      const cm = so ? COMMIT_RE.exec(so) : null;
      if (cm) { sha = sha || cm[2]; msg = cm[3]; }
      if (sha && /^[0-9a-f]{7,40}$/.test(sha)) st.commits.push({ sha, msg, ts, cwd: bash.cwd || st.cwd, resolved: false });
      if (COMMIT_CMD_RE.test(bash.full)) {
        const rts = Math.max(tsBefore(line) || ts, bash.ts);
        const single = !/\b(?:merge|cherry-pick|revert|am|rebase)\b/.test(bash.full);
        st.commitWins.push({ dir: gitDirFor(bash.full, bash.cwd || st.cwd), from: bash.ts - 3000, to: rts + 3000, at: rts, single, resolved: false });
      }
      return;
    }
    if (line.indexOf(K_PATCH) >= 0 && line.indexOf(K_FILEPATH) >= 0) {
      let o;
      try { o = JSON.parse(line.toString('utf8')); } catch { return; }
      const r = o.toolUseResult;
      if (!r || typeof r !== 'object' || typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return;
      const cnt = hunkCounts(r.structuredPatch);
      const created = r.type === 'create';
      if (created && cnt.add === 0 && typeof r.content === 'string') cnt.add = countLines(r.content);
      pushChange(st, {
        kind: 'edit', path: r.filePath, ts: Date.parse(o.timestamp) || st.mtimeMs, add: cnt.add, del: cnt.del,
        created, offset: absOffset, length: len, tool: r.type === 'create' || r.type === 'update' ? 'Write' : 'Edit',
      });
    }
    return;
  }

  if (line.indexOf(K_BASHUSE) >= 0) {
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (o.cwd && !st.cwd) st.cwd = o.cwd;
    const c = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const x of c) {
      if (x && x.type === 'tool_use' && x.name === 'Bash' && x.id) {
        const full = String((x.input && x.input.command) || '');
        st.pendingBash.set(x.id, { full, cmd: shortCmd(full), cwd: o.cwd || st.cwd, ts: Date.parse(o.timestamp) || st.mtimeMs });
      }
    }
    return;
  }

  if ((!st.firstPrompt || !st.cwd) && st.userChecked < 400 && line.indexOf(K_USER) >= 0 && len < 200000) {
    st.userChecked++;
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (o.cwd && !st.cwd) st.cwd = o.cwd;
    if (!st.firstPrompt && !o.isMeta && !st.sub) {
      const t = textOfUser(o);
      if (t && !/^\s*</.test(t) && !/^Caveat:/.test(t)) st.firstPrompt = t.replace(/\s+/g, ' ').trim().slice(0, 60);
    }
  }
}

function scanAppended(st) {
  let fd;
  try { fd = fs.openSync(st.file, 'r'); } catch { return 0; }
  let read = 0;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < st.offset) {
      const fresh = newFileState(st);
      Object.assign(st, fresh);
    }
    let pos = st.offset;
    let carry = null;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < stat.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, stat.size - pos), pos);
      if (n <= 0) break;
      read += n;
      const chunk = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const chunkStart = pos - (carry ? carry.length : 0);
      let start = 0;
      let idx;
      while ((idx = chunk.indexOf(NL, start)) !== -1) {
        handleLine(st, chunk.subarray(start, idx), chunkStart + start);
        start = idx + 1;
      }
      carry = start < chunk.length ? Buffer.from(chunk.subarray(start)) : null;
      pos += n;
    }
    st.offset = pos - (carry ? carry.length : 0);
    st.size = stat.size;
    st.mtimeMs = stat.mtimeMs;
  } finally {
    fs.closeSync(fd);
  }
  return read;
}

// ---------- git 커밋 → 파일 ----------

const topCache = new Map();
function gitTop(dir) {
  if (topCache.has(dir)) return topCache.get(dir);
  let top = null;
  try {
    top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { top = null; }
  topCache.set(dir, top);
  return top;
}

function renamedTo(p) {
  if (p.includes('{') && p.includes(' => ')) return p.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/\/\//g, '/');
  if (p.includes(' => ')) return p.split(' => ').pop();
  return p;
}

const commitCache = new Map();
function resolveCommit(c, fallbackDirs) {
  const dirs = [c.cwd, ...fallbackDirs].filter((d, i, a) => d && a.indexOf(d) === i);
  for (const d of dirs) {
    try { if (!fs.statSync(d).isDirectory()) continue; } catch { continue; }
    const top = gitTop(d);
    if (!top) continue;
    const key = top + '@' + c.sha;
    if (commitCache.has(key)) return commitCache.get(key);
    let out;
    try {
      out = execFileSync('git', ['-C', top, 'show', '--numstat', '--format=%H%x09%s', '-M', c.sha], { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    const lines = out.split('\n');
    const head = (lines.shift() || '').split('\t');
    const files = [];
    for (const l of lines) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
      if (!m) continue;
      const rel = renamedTo(m[3]);
      files.push({ rel, add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2] });
    }
    const res = { top, full: head[0] || c.sha, subject: head.slice(1).join('\t'), files };
    commitCache.set(key, res);
    return res;
  }
  return null;
}

function addCommitEntries(st, res, ts, msg) {
  if (st.seenSha.has(res.full)) return;
  st.seenSha.add(res.full);
  for (const f of res.files) {
    const p = path.join(res.top, f.rel);
    st.changes.push({ kind: 'commit', path: p, ts, add: f.add, del: f.del, sha: res.full, msg: msg || res.subject, top: res.top, rel: f.rel, sub: st.sub, file: st.file, scratch: isScratch(p) });
  }
}

// 커밋 명령이 돌던 시간 안에 그 저장소에 생긴 커밋(-q로 출력이 없어도 찾는다)
function commitsInWindow(w, fallbackDir) {
  for (const d of [w.dir, fallbackDir]) {
    if (!d) continue;
    try { if (!fs.statSync(d).isDirectory()) continue; } catch { continue; }
    const top = gitTop(d);
    if (!top) continue;
    let out;
    try {
      out = execFileSync('git', ['-C', top, 'log', '--all', '--format=%H%x09%ct%x09%s', `--since=${new Date(w.from).toISOString()}`, `--until=${new Date(w.to).toISOString()}`], { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    const hits = [];
    for (const l of out.split('\n')) {
      const [sha, ct, ...rest] = l.split('\t');
      if (/^[0-9a-f]{40}$/.test(sha || '')) hits.push({ sha, ts: Number(ct) * 1000 || w.to, subject: rest.join('\t'), top });
    }
    return hits;
  }
  return [];
}

// ---------- 실행 중 세션 ----------

function procStart(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

// Linux는 /proc의 시작 시각까지 맞춰 PID 재사용을 거른다. /proc이 없는 Windows·macOS는 프로세스 존재만 본다.
function isAlive(pid, recordedStart) {
  const ps = procStart(pid);
  if (ps !== null) return !recordedStart || String(recordedStart) === ps;
  if (fs.existsSync('/proc/self')) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function readRegistry() {
  const map = new Map();
  let names = [];
  try { names = fs.readdirSync(REGISTRY); } catch { return map; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(REGISTRY, n), 'utf8')); } catch { continue; }
    if (!d || !d.sessionId || !d.pid) continue;
    const alive = isAlive(d.pid, d.procStart);
    if (!alive) continue;
    map.set(d.sessionId, { pid: d.pid, status: d.status || null, waitingFor: typeof d.waitingFor === 'string' ? d.waitingFor : null, statusSince: Number(d.statusUpdatedAt) || null, name: d.name || null, nameSource: d.nameSource || null, cwd: d.cwd || null, entrypoint: d.entrypoint || null });
  }
  return map;
}

// ---------- 모델 ----------

function discover(sinceMs, registry) {
  const out = [];
  let projs = [];
  try { projs = fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { return out; }
  for (const p of projs) {
    if (!p.isDirectory()) continue;
    const pd = path.join(PROJECTS, p.name);
    let ents = [];
    try { ents = fs.readdirSync(pd, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sid = e.name.slice(0, -6);
      const f = path.join(pd, e.name);
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < sinceMs && !registry.has(sid)) continue;
      out.push({ file: f, sid, sub: false, project: p.name });
      let subs = [];
      try { subs = fs.readdirSync(path.join(pd, sid, 'subagents')); } catch { subs = []; }
      for (const n of subs) {
        if (!n.endsWith('.jsonl')) continue;
        const sf = path.join(pd, sid, 'subagents', n);
        try { if (fs.statSync(sf).mtimeMs < sinceMs) continue; } catch { continue; }
        out.push({ file: sf, sid, sub: true, project: p.name });
      }
    }
  }
  return out;
}

function createModel() {
  const files = new Map();
  let disc = [];
  let lastDisc = 0;
  let lastLook = 0;

  function scan(opts) {
    const t0 = Date.now();
    const lookMs = Math.max(1, Number(opts.lookbackHours) || 24) * 3600e3;
    const since = t0 - lookMs;
    const registry = readRegistry();
    if (opts.force || t0 - lastDisc > DISCOVERY_MS || lookMs !== lastLook) {
      disc = discover(since, registry);
      lastDisc = t0;
      lastLook = lookMs;
    }
    let bytes = 0;
    for (const d of disc) {
      let st = files.get(d.file);
      if (!st) { st = newFileState(d); files.set(d.file, st); }
      let s;
      try { s = fs.statSync(d.file); } catch { continue; }
      if (s.size !== st.offset || s.mtimeMs !== st.mtimeMs) bytes += scanAppended(st);
    }

    const bySid = new Map();
    for (const d of disc) {
      const st = files.get(d.file);
      if (!st) continue;
      if (!bySid.has(d.sid)) bySid.set(d.sid, []);
      bySid.get(d.sid).push(st);
    }

    const sessions = [];
    for (const [sid, sts] of bySid) {
      const main = sts.find((x) => !x.sub) || sts[0];
      const reg = registry.get(sid) || null;
      const projectCwd = main.cwd || (reg && reg.cwd) || null;
      const changes = [];
      let lastActivity = 0;
      for (const st of sts) {
        lastActivity = Math.max(lastActivity, st.mtimeMs);
        for (const c of st.commits) {
          if (c.resolved || c.ts < since) continue;
          c.resolved = true;
          const res = resolveCommit(c, [projectCwd]);
          if (!res) {
            st.changes.push({ kind: 'commit', path: null, ts: c.ts, add: 0, del: 0, sha: c.sha, msg: c.msg, unresolved: true, sub: st.sub, file: st.file, scratch: false });
            continue;
          }
          addCommitEntries(st, res, c.ts, c.msg);
        }
        for (const w of st.commitWins) {
          if (w.resolved || w.to < since) continue;
          w.resolved = true;
          let hits = commitsInWindow(w, projectCwd);
          // 커밋 하나만 만드는 명령인데 같은 시간대에 여러 개가 있으면(다른 세션 커밋) 끝난 시각에 가장 가까운 것만
          if (w.single && hits.length > 1) hits = [hits.reduce((a, b) => (Math.abs(a.ts - w.at) <= Math.abs(b.ts - w.at) ? a : b))];
          for (const hit of hits) {
            const res = resolveCommit({ sha: hit.sha, cwd: hit.top }, []);
            if (res) addCommitEntries(st, res, hit.ts, hit.subject);
          }
        }
        for (const c of st.changes) if (c.ts >= since) changes.push(c);
      }
      let title = main.customTitle || main.aiTitle || null;
      let titleSource = main.customTitle ? 'custom' : main.aiTitle ? 'ai' : null;
      if (!title && reg && reg.name && reg.nameSource !== 'derived') { title = reg.name; titleSource = 'registry'; }
      if (!title && main.firstPrompt) { title = main.firstPrompt; titleSource = 'prompt'; }
      if (!title) { title = sid.slice(0, 8); titleSource = 'id'; }
      sessions.push({
        sid, title, titleSource,
        address: reg && reg.nameSource === 'derived' ? reg.name : null,
        project: projectCwd ? path.basename(projectCwd) : main.project,
        cwd: projectCwd,
        lastActivity,
        alive: !!reg,
        status: reg ? reg.status : null,
        waitingFor: reg ? reg.waitingFor : null,
        statusSince: reg ? reg.statusSince : null,
        changes,
      });
    }
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return { sessions, stats: { ms: Date.now() - t0, files: disc.length, bytes } };
  }

  return { scan };
}

module.exports = { createModel, shellTargets, stripHeredocBodies, hunkCounts, isScratch, readRegistry };
