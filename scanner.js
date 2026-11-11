'use strict';
// Claude Code 대화 기록(~/.claude/projects/**/*.jsonl)을 읽어 세션별 변경 파일을 모은다.
// vscode 모듈을 쓰지 않는다. worker 스레드와 시험 스크립트에서 함께 쓴다. 읽기 전용이다.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const REGISTRY = path.join(HOME, '.claude', 'sessions');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const CACHE_VERSION = 3; // 3: 도구 호출(lastTool·events) 추가 — 옛 저장 파일은 버리고 한 번 새로 읽음
const CACHE_SAVE_MS = 20000;
const CODEX_ACTIVE_MS = 90000;
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
const K_TOOLUSE = B('"type":"tool_use"');
const K_ASSISTANT = B('"type":"assistant"');
// Claude Code가 남기는 API 요청 사본(api-request·api-request-blob)에는 이전 대화가 통째로 다시 들어 있어
// 도구 호출을 두 번 세거나 끝난 도구를 "진행 중"으로 되돌린다 → 줄 머리에서 보고 건너뛴다
const K_APIREQ = B('"type":"api-request');

// "지금 하는 일" 한 줄에 쓸 도구 입력 요약(파일 이름·명령 설명 등 짧게)
function summarizeInput(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const one = (s) => String(s || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 80);
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash': return one(i.description || i.command);
    case 'Edit': case 'Write': case 'MultiEdit': case 'Read': return base(i.file_path);
    case 'NotebookEdit': return base(i.notebook_path || i.file_path);
    case 'Grep': case 'Glob': return one(i.pattern);
    case 'Agent': case 'Task': return one(i.description || i.subagent_type);
    case 'WebSearch': return one(i.query);
    case 'WebFetch': try { return new URL(String(i.url)).host; } catch { return ''; }
    case 'Skill': return one(i.skill);
    default: return '';
  }
}

function noteTool(st, tool) {
  st.lastTool = tool;
}
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
    agent: d.agent || 'claude',
    offset: 0,
    mtimeMs: 0,
    size: 0,
    ino: 0,
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
    lastTool: null,
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

// ---------- Codex 기록(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ----------

const CX_META = B('"session_meta"');
const CX_TURN = B('"turn_context"');
const CX_PATCH = B('apply_patch');
const CX_USER = B('"role":"user"');
const CX_EXEC = B('exec_command');
const CX_SHELL = B('"shell_command"');
const CX_COMPACT = B('"type":"compacted"');

function codexUserText(content) {
  for (const c of Array.isArray(content) ? content : []) {
    const t = c && typeof c.text === 'string' ? c.text.trim() : '';
    if (!t || t.startsWith('<') || t.startsWith('#') || /AGENTS\.md|environment_context|user_instructions/.test(t.slice(0, 200))) continue;
    return t.replace(/\s+/g, ' ').slice(0, 60);
  }
  return null;
}

// apply_patch 글: *** Add File / Update File / Delete File (+ Move to) 와 +/− 줄
function parsePatch(text, cwd) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      cur = { op: m[1], path: resolveTarget(m[2].trim(), cwd) || m[2].trim(), add: 0, del: 0, lines: [] };
      out.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && cur) { cur.path = resolveTarget(mv[1].trim(), cwd) || mv[1].trim(); continue; }
    if (!cur || line.startsWith('*** ')) continue;
    cur.lines.push(line);
    if (line[0] === '+') cur.add++;
    else if (line[0] === '-') cur.del++;
  }
  return out;
}

function codexPatchText(p) {
  if (!p) return null;
  if (p.type === 'custom_tool_call' && typeof p.input === 'string') return p.input;
  if (p.type === 'function_call' && typeof p.arguments === 'string') {
    try {
      const a = JSON.parse(p.arguments);
      return typeof a.input === 'string' ? a.input : typeof a.patch === 'string' ? a.patch : null;
    } catch { return null; }
  }
  return null;
}

function codexCommand(p) {
  if (!p) return null;
  if (p.type === 'function_call' && typeof p.arguments === 'string') {
    try {
      const a = JSON.parse(p.arguments);
      if (typeof a.cmd === 'string') return { cmd: a.cmd, cwd: a.workdir || null };
      if (typeof a.command === 'string') return { cmd: a.command, cwd: a.workdir || null };
      if (Array.isArray(a.command)) return { cmd: String(a.command[a.command.length - 1] || ''), cwd: a.workdir || null };
    } catch { return null; }
  }
  if (p.type === 'custom_tool_call' && typeof p.input === 'string') {
    const m = /"cmd"\s*:\s*("(?:\\.|[^"\\])*")/.exec(p.input);
    if (m) { try { return { cmd: JSON.parse(m[1]), cwd: null }; } catch { return null; } }
  }
  return null;
}

function handleCodexLine(st, line, absOffset) {
  const len = line.length;
  if (len < 2) return;
  const meta = line.indexOf(CX_META) >= 0 && len < 400000;
  const turn = !meta && line.indexOf(CX_TURN) >= 0 && len < 400000;
  const patch = line.indexOf(CX_PATCH) >= 0;
  const user = !st.firstPrompt && line.indexOf(CX_USER) >= 0 && len < 200000;
  const exec = line.indexOf(CX_EXEC) >= 0 || line.indexOf(CX_SHELL) >= 0;
  const compacted = !st.firstPrompt && line.indexOf(CX_COMPACT) >= 0;
  if (!meta && !turn && !patch && !user && !exec && !compacted) return;
  let o;
  try { o = JSON.parse(line.toString('utf8')); } catch { return; }
  const p = o && typeof o.payload === 'object' && o.payload ? o.payload : null;
  if (!p) return;
  const ts = Date.parse(o.timestamp) || st.mtimeMs || Date.now();
  if (o.type === 'session_meta') {
    if (p.cwd && !st.cwd) st.cwd = p.cwd;
    if (!st.curCwd) st.curCwd = p.cwd || null;
    return;
  }
  if (o.type === 'turn_context') {
    if (p.cwd) st.curCwd = p.cwd;
    if (p.cwd && !st.cwd) st.cwd = p.cwd;
    return;
  }
  if (o.type === 'compacted') {
    // 이어 붙인(압축된) 세션은 첫 질문이 replacement_history 안에 있다
    for (const it of Array.isArray(p.replacement_history) ? p.replacement_history : []) {
      if (it && it.role === 'user') { const t = codexUserText(it.content); if (t) { st.firstPrompt = t; break; } }
    }
    return;
  }
  if (o.type !== 'response_item') return;
  if (p.type === 'message' && p.role === 'user' && !st.firstPrompt) {
    const t = codexUserText(p.content);
    if (t) st.firstPrompt = t;
    return;
  }
  if (p.name === 'apply_patch') {
    const text = codexPatchText(p);
    if (!text) return;
    const parts = parsePatch(text, st.curCwd || st.cwd);
    noteTool(st, { id: null, tool: 'apply_patch', arg: parts[0] ? path.basename(parts[0].path) : '', ts, done: true });
    parts.forEach((f, i) => {
      pushChange(st, {
        kind: 'cxedit', path: f.path, ts, add: f.add, del: f.del, created: f.op === 'Add', deleted: f.op === 'Delete',
        offset: absOffset, length: len, idx: i,
      });
    });
    return;
  }
  const ex = codexCommand(p);
  if (ex && ex.cmd) {
    noteTool(st, { id: null, tool: 'exec', arg: String(ex.cmd).split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 80), ts, done: false });
    const cwd = ex.cwd || st.curCwd || st.cwd;
    for (const t of shellTargets(ex.cmd, cwd)) {
      let s;
      try { s = fs.statSync(t); } catch { continue; }
      if (!s.isFile() || s.mtimeMs < ts - 2000) continue;
      pushChange(st, { kind: 'shell', path: t, ts, add: 0, del: 0, created: false, cmd: shortCmd(ex.cmd), cwd });
    }
  }
}

function handleLine(st, line, absOffset) {
  if (st.agent === 'codex') return handleCodexLine(st, line, absOffset);
  const len = line.length;
  if (len < 2) return;
  if (line.subarray(0, 48).indexOf(K_APIREQ) >= 0) return;

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
    if (id && st.lastTool && st.lastTool.id === id) st.lastTool.done = true;
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

  // 도구 호출 줄: 지금 하는 일(마지막 도구)·활동 흐름(호출 시각)·셸 명령 대기 목록
  if (line.indexOf(K_TOOLUSE) >= 0 && line.indexOf(K_ASSISTANT) >= 0 && (line.indexOf(K_BASHUSE) >= 0 || len < 400000)) {
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (o.type !== 'assistant') return;
    if (o.cwd && !st.cwd) st.cwd = o.cwd;
    const ts = Date.parse(o.timestamp) || st.mtimeMs;
    const c = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const x of c) {
      if (!x || x.type !== 'tool_use' || !x.id) continue;
      noteTool(st, { id: x.id, tool: String(x.name || ''), arg: summarizeInput(x.name, x.input), ts, done: false });
      if (x.name === 'Bash') {
        const full = String((x.input && x.input.command) || '');
        st.pendingBash.set(x.id, { full, cmd: shortCmd(full), cwd: o.cwd || st.cwd, ts });
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
    // 파일이 줄었거나(다시 써짐) 다른 파일로 바뀌었으면 처음부터
    if (stat.size < st.offset || (st.ino && stat.ino && st.ino !== stat.ino)) {
      const fresh = newFileState(st);
      Object.assign(st, fresh);
    }
    st.ino = stat.ino;
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

// 승인 알림 훅이 남기는 표시 파일(<sha256(세션ID) 앞 12자>.pending, 내용은 기다리는 도구 이름).
// Claude Code가 상태 파일에 waiting을 안 적는 경우의 보조 신호. 승인 뒤 기록이 새로 쌓이면 지난 것으로 본다.
function attentionMarker(dir, sid) {
  if (!dir) return null;
  const p = path.join(dir, crypto.createHash('sha256').update(sid).digest('hex').slice(0, 12) + '.pending');
  try {
    const s = fs.statSync(p);
    let tool = '';
    try { tool = fs.readFileSync(p, 'utf8').trim().slice(0, 80); } catch { tool = ''; }
    return { mtimeMs: s.mtimeMs, tool };
  } catch { return null; }
}

function applyMarker(state, marker, lastActivity) {
  if (!marker || !state.alive || state.status === 'waiting') return state;
  if (marker.mtimeMs < (lastActivity || 0) - 3000) return state;
  const input = marker.tool === 'AskUserQuestion' || marker.tool.startsWith('dialog');
  return { ...state, status: 'waiting', waitingFor: input ? 'input needed' : 'permission prompt', statusSince: Math.round(marker.mtimeMs), waitingSource: 'marker' };
}

// ---------- 모델 ----------

function localDay(ms) {
  const d = new Date(ms);
  return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
}

function discoverCodex(sinceMs) {
  const out = [];
  const seen = new Set();
  for (let t = sinceMs - 86400e3; t <= Date.now() + 3600e3; t += 86400e3) {
    const dir = path.join(CODEX_SESSIONS, ...localDay(t));
    if (seen.has(dir)) continue;
    seen.add(dir);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n);
      try { if (fs.statSync(f).mtimeMs < sinceMs) continue; } catch { continue; }
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(n);
      out.push({ file: f, sid: 'codex:' + (m ? m[1] : n), sub: false, project: 'codex', agent: 'codex' });
    }
  }
  return out;
}

function discover(sinceMs, registry, includeCodex) {
  const out = includeCodex ? discoverCodex(sinceMs) : [];
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

// ---------- 읽은 결과 저장(창을 다시 열어도 새로 붙은 부분만 읽게) ----------

function serializeState(st) {
  const dayAgo = Date.now() - 86400e3;
  const pending = [...st.pendingBash].filter(([, b]) => b.ts >= dayAgo).map(([id, b]) => [id, { ...b, full: String(b.full || '').slice(0, 20000) }]);
  return { ...st, pendingBash: pending, seenSha: [...st.seenSha] };
}

function deserializeState(o) {
  return { ...o, pendingBash: new Map(o.pendingBash || []), seenSha: new Set(o.seenSha || []), changes: o.changes || [], commits: o.commits || [], commitWins: o.commitWins || [] };
}

function loadCache(file, files) {
  if (!file) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.v !== CACHE_VERSION || !Array.isArray(data.files)) return;
    for (const o of data.files) if (o && o.file && !files.has(o.file)) files.set(o.file, deserializeState(o));
  } catch { /* 없거나 깨짐: 처음부터 읽음 */ }
}

function saveCache(file, states) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, savedAt: Date.now(), files: states.map(serializeState) }));
    fs.renameSync(tmp, file);
  } catch { /* 저장 실패는 다음에 다시 */ }
}

function createModel() {
  const files = new Map();
  let disc = [];
  let lastDisc = 0;
  let lastLook = 0;
  let cacheLoaded = false;
  let dirty = false;
  let lastSave = 0;

  function ensureCache(opts) {
    if (cacheLoaded) return;
    cacheLoaded = true;
    loadCache(opts.cacheFile, files);
  }

  function titleOf(sid) {
    for (const st of files.values()) {
      if (st.sid === sid && !st.sub) return st.customTitle || st.aiTitle || st.firstPrompt || null;
    }
    return null;
  }

  // 상태 표시줄용: 대화 기록은 읽지 않고 실행 중 목록과 표시 파일만 본다(가벼움)
  function status(opts) {
    ensureCache(opts);
    const registry = readRegistry();
    const out = [];
    for (const [sid, reg] of registry) {
      let lastActivity = 0;
      let cwd = reg.cwd;
      for (const st of files.values()) if (st.sid === sid) { lastActivity = Math.max(lastActivity, st.mtimeMs); cwd = st.cwd || cwd; }
      let s = { sid, alive: true, status: reg.status, waitingFor: reg.waitingFor, statusSince: reg.statusSince, lastActivity, cwd, project: cwd ? path.basename(cwd) : null };
      s = applyMarker(s, attentionMarker(opts.attentionDir, sid), lastActivity);
      s.title = titleOf(sid) || (reg.nameSource !== 'derived' && reg.name) || sid.slice(0, 8);
      out.push(s);
    }
    return { sessions: out };
  }

  function maybeSave(opts, force) {
    if (!opts.cacheFile || !dirty) return;
    if (!force && Date.now() - lastSave < CACHE_SAVE_MS) return;
    const keep = new Set(disc.map((d) => d.file));
    saveCache(opts.cacheFile, [...files.values()].filter((st) => keep.has(st.file)));
    lastSave = Date.now();
    dirty = false;
  }

  function scan(opts) {
    ensureCache(opts);
    const t0 = Date.now();
    const lookMs = Math.max(1, Number(opts.lookbackHours) || 24) * 3600e3;
    const since = t0 - lookMs;
    const registry = readRegistry();
    if (opts.force || t0 - lastDisc > DISCOVERY_MS || lookMs !== lastLook) {
      disc = discover(since, registry, opts.includeCodex !== false);
      lastDisc = t0;
      lastLook = lookMs;
    }
    let bytes = 0;
    for (const d of disc) {
      let st = files.get(d.file);
      if (!st) { st = newFileState(d); files.set(d.file, st); }
      let s;
      try { s = fs.statSync(d.file); } catch { continue; }
      if (s.size !== st.offset || s.mtimeMs !== st.mtimeMs || (st.ino && s.ino !== st.ino)) {
        bytes += scanAppended(st);
        dirty = true;
      }
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
          dirty = true;
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
          dirty = true;
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
      const codex = main.agent === 'codex';
      let title = main.customTitle || main.aiTitle || null;
      let titleSource = main.customTitle ? 'custom' : main.aiTitle ? 'ai' : null;
      if (!title && reg && reg.name && reg.nameSource !== 'derived') { title = reg.name; titleSource = 'registry'; }
      if (!title && main.firstPrompt) { title = main.firstPrompt; titleSource = 'prompt'; }
      if (!title) { title = codex ? 'Codex ' + sid.slice(6, 14) : sid.slice(0, 8); titleSource = 'id'; }
      // Codex는 실행 중 목록이 없어 최근 기록 시각으로만 작업 중을 짐작한다
      const codexActive = codex && t0 - lastActivity < CODEX_ACTIVE_MS;
      let state = {
        alive: codex ? codexActive : !!reg,
        status: codex ? (codexActive ? 'busy' : null) : reg ? reg.status : null,
        waitingFor: reg ? reg.waitingFor : null,
        statusSince: codex ? (codexActive ? lastActivity : null) : reg ? reg.statusSince : null,
      };
      if (!codex) state = applyMarker(state, attentionMarker(opts.attentionDir, sid), lastActivity);
      // 지금 하는 일: 본 세션·하위 에이전트 중 가장 최근 도구 호출
      let activity = null;
      for (const st of sts) {
        if (st.lastTool && (!activity || st.lastTool.ts > activity.ts)) activity = st.lastTool;
      }
      sessions.push({
        sid, title, titleSource,
        agent: main.agent || 'claude',
        address: reg && reg.nameSource === 'derived' ? reg.name : null,
        project: projectCwd ? path.basename(projectCwd) : main.project,
        cwd: projectCwd,
        lastActivity,
        ...state,
        activity,
        changes,
      });
    }
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    maybeSave(opts, !!opts.flush);
    return { sessions, stats: { ms: Date.now() - t0, files: disc.length, bytes } };
  }

  return { scan, status, save: (opts) => maybeSave(opts, true) };
}

// 시험용: 기록 파일 하나를 통째로 읽은 상태
function scanOne(file, agent) {
  const st = newFileState({ file, sid: 'test', sub: false, project: '', agent });
  scanAppended(st);
  return st;
}

module.exports = { createModel, shellTargets, stripHeredocBodies, hunkCounts, isScratch, readRegistry, parsePatch, attentionMarker, scanOne };
