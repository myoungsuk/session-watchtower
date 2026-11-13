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
const CACHE_VERSION = 6; // 4: 마지막 대화 시각(lastMsgTs)·목록용 요약 읽기 추가 — 옛 저장 파일은 버리고 한 번 새로 읽음
const CACHE_SAVE_MS = 20000;
const CODEX_ACTIVE_MS = 90000;
// "지금 고치는 중"으로 보는 시간: 마지막으로 바뀐 뒤 이만큼
const LIVE_MS = 30000;
// 하위 에이전트 기록이 이 시간 안에 바뀌었으면 작업 중으로 본다
const SUB_ACTIVE_MS = 60000;
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

// 파일을 고치는 도구가 겨냥한 파일의 전체 경로(변경 파일 창의 "지금 고치는 중" 표시에 쓴다)
function toolFilePath(name, input, cwd) {
  if (name !== 'Edit' && name !== 'Write' && name !== 'MultiEdit' && name !== 'NotebookEdit') return null;
  const p = input && (input.file_path || input.notebook_path);
  if (!p || typeof p !== 'string') return null;
  return path.isAbsolute(p) ? p : cwd ? path.resolve(cwd, p) : null;
}

// 작업 중인 세션이 이번 기간에 고친 파일 가운데, 디스크에서 방금(LIVE_MS 안) 바뀐 것.
// 스크립트(python·sed 등)로 고치면 Claude Code가 기록을 남기지 않을 때가 많아 대화 기록만으로는 "지금 고치는 중"을 알 수 없다.
// 그래서 파일이 바뀐 시각을 본다. 누가 고쳤는지는 알 수 없으므로(다른 세션·사람일 수도 있음) 이미 이 세션 목록에 있는 파일만 본다.
function recentlyTouched(changes, now) {
  const seen = new Set();
  const out = [];
  for (let i = changes.length - 1; i >= 0 && seen.size < 400; i--) {
    const p = changes[i].path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m >= now - LIVE_MS && m <= now + 5000) out.push(p);
    } catch { /* 지워진 파일 */ }
  }
  return out.sort();
}

// 읽기만 하는 명령인가(ls·cat·grep·git status 등으로만 이루어짐). 이런 명령이 도는 동안 바뀐 파일은 이 명령 탓이 아니다
const RO_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'stat', 'file', 'du', 'df', 'pwd', 'cd', 'which', 'type', 'echo', 'printf', 'sleep',
  'ps', 'pgrep', 'uptime', 'date', 'whoami', 'id', 'printenv', 'sha256sum', 'md5sum', 'diff', 'cmp', 'jq', 'sort', 'uniq', 'cut', 'tr', 'column', 'tree', 'realpath', 'basename',
  'dirname', 'readlink', 'nproc', 'free', 'ss', 'true', 'false', 'test', '[']);
const RO_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'cat-file', 'check-ignore', 'shortlog', 'reflog', 'tag']);
function looksReadOnly(cmd) {
  const src = stripHeredocBodies(String(cmd || ''));
  if (!src.trim()) return true;
  if (/<<-?\s*['"]?\w/.test(src)) return false; // 여기 문서로 스크립트를 넘김
  if (/(^|[^0-9&>])>>?\s*(?!&|\s*\/dev\/null)/.test(src)) return false; // 파일로 내보냄
  for (const seg of src.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const w0 = (words[0] || '').replace(/^.*\//, '');
    if (!w0) continue;
    if (w0 === 'git') {
      const sub = words.slice(1).find((w) => !w.startsWith('-') && !/[=/]/.test(w)) || '';
      if (!RO_GIT.has(sub)) return false;
    } else if (w0 === 'find') {
      if (/\s-(?:delete|exec|execdir|ok)\b/.test(seg)) return false;
    } else if (w0 === 'sed' || w0 === 'awk') {
      if (/\s-i\b|\s--in-place/.test(seg)) return false;
    } else if (!RO_CMDS.has(w0)) return false;
  }
  return true;
}

// 같은 파일을 두 세션 이상이 고친 곳을 표시한다(s.overlaps = [{ path, with: [{ sid, title, ts }] }]).
// 누가 고쳤는지 확실한 기록(편집 도구·기록된 셸 변경·Codex 패치)만 본다. 추정(?)과 커밋은 뺀다.
// 순서대로 일한 것(상대가 고치고 커밋까지 끝낸 파일을 나중에 고침)은 알리지 않으려고,
// 상대 세션이 아직 열려 있거나 그 파일에 커밋하지 않은 변경이 남아 있을 때만 겹침으로 본다.
function markOverlaps(sessions, now) {
  const byPath = new Map();
  for (const s of sessions) {
    s.overlaps = [];
    for (const c of s.changes) {
      if (!c.path || c.scratch || (c.kind !== 'edit' && c.kind !== 'bash' && c.kind !== 'cxedit')) continue;
      let m = byPath.get(c.path);
      if (!m) byPath.set(c.path, (m = new Map()));
      if (!(m.get(s.sid) >= c.ts)) m.set(s.sid, c.ts);
    }
  }
  const bySid = new Map(sessions.map((s) => [s.sid, s]));
  for (const [p, m] of byPath) {
    if (m.size < 2) continue;
    let dirty = null;
    const isDirty = () => {
      if (dirty === null) {
        const dir = path.dirname(p);
        const info = inGitTree(dir) ? gitInfo(dir) : null;
        // 저장소 밖 파일은 커밋 여부를 알 수 없다 → 남아 있는 변경으로 본다
        dirty = info ? repoDirty(info.top, now).some((f) => f.path === p) : true;
      }
      return dirty;
    };
    for (const [sid] of m) {
      const others = [];
      for (const [oid, ots] of m) {
        if (oid === sid) continue;
        const o = bySid.get(oid);
        if ((o && o.alive) || isDirty()) others.push({ sid: oid, title: o ? o.title : oid.slice(0, 8), ts: ots });
      }
      if (others.length) bySid.get(sid).overlaps.push({ path: p, with: others });
    }
  }
}

// 폴더가 git 저장소 안인가(위로 올라가며 .git을 찾는다). 임시 폴더처럼 저장소가 아닌 곳마다 git을 띄우지 않으려고 먼저 본다
const gitTreeMemo = new Map();
function inGitTree(dir) {
  const seen = [];
  let cur = dir;
  let hit = false;
  for (let i = 0; i < 40 && cur; i++) {
    if (gitTreeMemo.has(cur)) { hit = gitTreeMemo.get(cur); break; }
    seen.push(cur);
    if (fs.existsSync(path.join(cur, '.git'))) { hit = true; break; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const d of seen) gitTreeMemo.set(d, hit);
  return hit;
}

// 저장소에서 지금 "커밋되지 않은" 파일과 그 파일이 마지막으로 바뀐 시각(스크립트가 고친 파일을 찾는 데 쓴다)
const dirtyCache = new Map();
function repoDirty(top, now) {
  const hit = dirtyCache.get(top);
  if (hit && now - hit.at < 2000) return hit.files;
  let out = '';
  try {
    out = execFileSync('git', ['--no-optional-locks', '-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { out = ''; }
  const files = [];
  for (const ent of out.split('\0')) {
    if (ent.length < 4 || files.length >= 3000) continue;
    const p = path.join(top, ent.slice(3));
    let s;
    try { s = fs.statSync(p); } catch { continue; }
    // isNew: 아직 git이 모르는 파일(??)이거나 새로 추가한 파일(A). 원래 있던 파일을 고친 것과 구별한다
    if (s.isFile()) files.push({ path: p, mtimeMs: s.mtimeMs, birthMs: s.birthtimeMs || 0, isNew: ent.startsWith('??') || ent[0] === 'A' });
  }
  dirtyCache.set(top, { at: now, files });
  return files;
}

function noteTool(st, tool) {
  st.lastTool = tool;
}
const K_TOOLUSEID = B('"tool_use_id":"');
const K_ENTRY = B('"entrypoint":"');
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
    pendingCx: {}, // Codex: 결과를 기다리는 도구 호출(호출 ID → 패치·명령)
    bashWins: [], // 바뀐 파일 기록이 없는 셸 명령이 돈 시간대(그 사이에 바뀐 파일을 추정으로 넣는다)
    rootSid: d.rootSid || null, // Codex 하위 스레드가 속한 뿌리 세션
    commits: [],
    commitWins: [],
    seenSha: new Set(),
    userChecked: 0,
    lastTool: null,
    scanFrom: null, // 읽기 시작한 바이트 위치(null = 아직 안 읽음, 0 = 처음부터 다 읽음)
    coveredSince: 0, // scanFrom > 0일 때, 이 시각 뒤의 기록은 다 읽었음
    lastMsgTs: 0, // 마지막 대화 시각(파일이 바뀐 시각과 다르다)
    titleSearched: false,
    metaOnly: false, // 목록용 요약만 읽은 상태(변경 기록 없음)
    programmatic: false, // 프로그램이 돌린 세션(SDK). Claude Code 세션 목록에는 나오지 않는다
  };
}

// ---------- 큰 기록 파일에서 "보는 기간"이 시작되는 위치 찾기 ----------
// 기록은 시간순으로 뒤에 붙으므로, 줄의 시각을 보며 반씩 좁혀 가면 앞부분(며칠 치)을 읽지 않아도 된다.

const SEEK_MIN_BYTES = 8 * 1024 * 1024; // 이보다 작으면 그냥 다 읽는다
const SEEK_STOP_BYTES = 1024 * 1024;
const SEEK_MARGIN_MS = 10 * 60 * 1000; // 경계에 걸친 명령을 위해 10분 앞에서부터
const HEAD_BYTES = 1024 * 1024; // 첫 질문·작업 폴더는 파일 맨 앞에 있다
const PROBE_MAX_BYTES = 24 * 1024 * 1024;
const PROBE_LINE_MAX = 2 * 1024 * 1024;
const TITLE_BACK_BYTES = 64 * 1024 * 1024;
let extraRead = 0;

function lineTimestamp(line) {
  if (line.length < 20 || line.length > PROBE_LINE_MAX) return 0;
  if (line.subarray(0, 48).indexOf(K_APIREQ) >= 0) return 0; // 사본 줄의 시각은 옛 대화의 것
  if (line.indexOf(K_TS) < 0) return 0;
  try {
    const o = JSON.parse(line.toString('utf8'));
    return o && typeof o.timestamp === 'string' ? Date.parse(o.timestamp) || 0 : 0;
  } catch { return 0; }
}

// pos 뒤, hi 앞에서 시각이 적힌 기록 줄 하나를 찾는다 → { lineStart, ts } 또는 null
function probeTimestamp(fd, pos, hi, size) {
  const buf = Buffer.allocUnsafe(256 * 1024);
  let cur = pos;
  let carry = null;
  let carryStart = pos;
  let aligned = pos === 0; // 줄 머리에 서 있는지(중간에 떨어졌으면 그 줄은 버린다)
  let budget = PROBE_MAX_BYTES;
  while (cur < size && budget > 0) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - cur), cur);
    if (n <= 0) break;
    budget -= n;
    extraRead += n;
    const chunk = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
    const chunkStart = carry ? carryStart : cur;
    cur += n;
    let start = 0;
    let idx;
    while ((idx = chunk.indexOf(NL, start)) !== -1) {
      if (!aligned) { aligned = true; start = idx + 1; continue; }
      const lineStart = chunkStart + start;
      if (lineStart >= hi) return null;
      const ts = lineTimestamp(chunk.subarray(start, idx));
      if (ts) return { lineStart, ts };
      start = idx + 1;
    }
    if (aligned && chunkStart + start >= hi) return null;
    if (chunk.length - start > PROBE_LINE_MAX) { carry = null; aligned = false; } // 아주 긴 줄은 끝까지 건너뜀
    else { carry = Buffer.from(chunk.subarray(start)); carryStart = chunkStart + start; }
  }
  return null;
}

// sinceMs보다 앞선 시각의 줄 머리 중 가장 뒤쪽 근처(못 찾으면 0 = 처음부터)
function seekByTime(fd, size, sinceMs, minBytes) {
  if (size < (minBytes || SEEK_MIN_BYTES)) return 0;
  const stop = Math.min(SEEK_STOP_BYTES, Math.max(4096, Math.floor(size / 16)));
  let lo = 0;
  let hi = size;
  for (let i = 0; i < 48 && hi - lo > stop; i++) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const p = probeTimestamp(fd, mid, hi, size);
    if (!p || p.ts >= sinceMs) hi = mid;
    else lo = p.lineStart;
  }
  return lo;
}

// 파일 맨 앞에서 첫 질문·작업 폴더만 읽는다(변경 기록은 만들지 않음)
function scanHead(st, fd, bytes) {
  const buf = Buffer.allocUnsafe(bytes);
  const n = fs.readSync(fd, buf, 0, bytes, 0);
  if (n <= 0) return 0;
  // Claude Code는 SDK로 돌린 세션(entrypoint sdk-cli·sdk-ts·sdk-py)을 세션 목록에서 뺀다
  const ep = buf.indexOf(K_ENTRY);
  if (ep >= 0 && ep < n) st.programmatic = buf.toString('latin1', ep + K_ENTRY.length, ep + K_ENTRY.length + 4) === 'sdk-';
  let start = 0;
  let idx;
  while ((idx = buf.indexOf(NL, start)) !== -1 && idx < n) {
    handleLine(st, buf.subarray(start, idx), start, true);
    start = idx + 1;
  }
  return n;
}

// 줄에 적힌 기록 시각. 도구 결과 줄은 결과 내용 앞의 것(맨 위 칸)을 쓴다. 미래 시각은 버린다.
function recordTs(line, ri) {
  const j = ri >= 0 ? line.lastIndexOf(K_TS, ri) : line.lastIndexOf(K_TS);
  if (j < 0) return 0;
  const s = j + K_TS.length;
  const e = line.indexOf(34, s);
  if (e < 0 || e - s > 40) return 0;
  const ts = Date.parse(line.toString('latin1', s, e));
  return ts && ts <= Date.now() + 60000 ? ts : 0;
}

// 뒤에서 앞으로 가며 시각이 적힌 마지막 기록을 찾는다(= 마지막 대화 시각)
function findLastMessageTs(fd, endPos) {
  const step = 1024 * 1024;
  let pos = endPos;
  let read = 0;
  while (pos > 0 && read < TITLE_BACK_BYTES) {
    const from = Math.max(0, pos - step);
    const buf = Buffer.allocUnsafe(pos - from);
    const n = fs.readSync(fd, buf, 0, pos - from, from);
    if (n <= 0) break;
    read += n;
    extraRead += n;
    let end = n;
    for (;;) {
      const j = buf.lastIndexOf(K_TS, end - 1);
      if (j < 0) break;
      const ts = recordTs(buf.subarray(j, Math.min(n, j + 64)), -1);
      if (ts) return ts;
      end = j;
      if (end <= 0) break;
    }
    pos = from;
  }
  return 0;
}

// 읽은 구간에 제목이 없을 때만: 뒤에서 앞으로 가며 마지막 제목 기록을 찾는다
function findLastTitle(st, fd, endPos, size) {
  const step = 4 * 1024 * 1024;
  const overlap = 64 * 1024;
  let pos = endPos;
  let read = 0;
  while (pos > 0 && read < TITLE_BACK_BYTES && !st.customTitle && !st.aiTitle) {
    const from = Math.max(0, pos - step);
    const len = Math.min(pos - from + overlap, size - from);
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, from);
    if (n <= 0) break;
    read += n;
    for (const key of [K_CUSTOM, K_AI]) {
      const i = buf.lastIndexOf(key, n - 1);
      if (i < 0) continue;
      const s = buf.lastIndexOf(NL, i) + 1;
      const e = buf.indexOf(NL, i);
      if (e < 0 || e > n || e - s > 20000) continue;
      try {
        const o = JSON.parse(buf.toString('utf8', s, e));
        if (o.type === 'custom-title' && o.customTitle) st.customTitle = String(o.customTitle);
        if (o.type === 'ai-title' && o.aiTitle) st.aiTitle = String(o.aiTitle);
      } catch { /* 깨진 줄 */ }
    }
    pos = from;
  }
  return read;
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
// 명령이 실제로 돈 폴더들: 시작 폴더에서 출발해 "cd X &&"를 따라간다(cd만 하고 지나간 폴더는 뺀다)
function dirsFor(cmd, cwd) {
  let cur = cwd;
  const used = new Set();
  for (const raw of stripHeredocBodies(String(cmd || '')).split(/\n|&&|\|\||;|\|/)) {
    const s = raw.trim().replace(/^\(\s*/, '');
    if (!s) continue;
    const cd = /^cd\s+(.+)$/.exec(s);
    if (cd) {
      const d = resolveTarget(tokenize(cd[1])[0], cur);
      if (d) cur = d;
      continue;
    }
    if (cur) used.add(cur);
  }
  return [...used].slice(0, 4);
}

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

// 사용자 메시지의 글 전부(글 조각이 여러 개면 이어 붙인다: 앞 조각이 도구 안내문이고 뒤 조각이 실제로 쓴 말인 경우가 있다)
function allTextOfUser(o) {
  const m = o.message;
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join(' ');
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
const CX_OUT = B('"payload":{"type":"custom_tool_call_output"');
const CX_FOUT = B('"payload":{"type":"function_call_output"');
const CX_FAILED = B('"text":"Script failed');
const K_CALLID = B('"call_id":"');

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
  // 한 구간(@@) 안에서 지웠다가 그대로 다시 넣은 줄은 바뀐 줄이 아니다(Codex가 여러 줄을 통째로 갈아 끼울 때 생김) → 줄 수에서 뺀다
  let minus = new Map();
  let plus = new Map();
  const settle = () => {
    if (cur) for (const [l, n] of minus) { const k = Math.min(n, plus.get(l) || 0); cur.add -= k; cur.del -= k; }
    minus = new Map();
    plus = new Map();
  };
  for (const line of String(text || '').split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      settle();
      cur = { op: m[1], path: resolveTarget(m[2].trim(), cwd) || m[2].trim(), add: 0, del: 0, lines: [] };
      out.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && cur) { cur.path = resolveTarget(mv[1].trim(), cwd) || mv[1].trim(); continue; }
    if (!cur || line.startsWith('*** ')) continue;
    cur.lines.push(line);
    if (line.startsWith('@@')) settle();
    else if (line[0] === '+') { cur.add++; plus.set(line.slice(1), (plus.get(line.slice(1)) || 0) + 1); }
    else if (line[0] === '-') { cur.del++; minus.set(line.slice(1), (minus.get(line.slice(1)) || 0) + 1); }
  }
  settle();
  return out;
}

// 자바스크립트 문자열 안의 \n·\"·\uXXXX 등을 푼다
function unescapeJs(s) {
  return String(s).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (m, e) => {
    if ((e[0] === 'u' || e[0] === 'x') && e.length === 1) return e;
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case 'u': return e[1] === '{' ? String.fromCodePoint(parseInt(e.slice(2, -1), 16)) : String.fromCharCode(parseInt(e.slice(1), 16));
      case 'x': return String.fromCharCode(parseInt(e.slice(1), 16));
      case '\n': case '\r': return '';
      default: return e;
    }
  });
}

// 요즘 Codex는 도구를 exec 안의 자바스크립트로 부른다:
//   text(await tools.apply_patch("*** Begin Patch\n…"))   ·   tools.exec_command({cmd:"…",workdir:"…"})
// 패치 문자열을 꺼낸다(없으면 null). 패치는 인자에 바로 쓰기도 하고(tools.apply_patch("*** Begin Patch…")),
// 변수에 담아 넘기기도 한다(const patch = "*** Begin Patch…"; tools.apply_patch(patch)) → "*** Begin Patch"로 시작하는 문자열을 모두 모은다
function jsPatchArg(input) {
  const src = String(input || '');
  if (src.indexOf('apply_patch') < 0) return null;
  const out = [];
  let from = 0;
  while (out.length < 20) {
    const k = src.indexOf('*** Begin Patch', from);
    if (k < 1) break;
    from = k + 15;
    const q = src[k - 1];
    if (q !== '"' && q !== "'" && q !== '`') continue;
    let j = k;
    while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
    if (j >= src.length) break;
    out.push(unescapeJs(src.slice(k, j)));
    from = j + 1;
  }
  return out.length ? out.join('\n') : null;
}

// exec 안의 tools.exec_command({cmd:"…",workdir:"…"}) 들(한 번에 여러 개를 부르기도 한다)
function jsCommands(input) {
  const out = [];
  const src = String(input || '');
  if (src.indexOf('exec_command') < 0) return out;
  const re = /["']?\bcmd["']?\s*:\s*"((?:\\[\s\S]|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(src)) && out.length < 20) {
    const rest = src.slice(re.lastIndex, re.lastIndex + 600);
    const end = rest.search(/\btools\.[A-Za-z_]+\(/);
    const w = /["']?\bworkdir["']?\s*:\s*"((?:\\[\s\S]|[^"\\])*)"/.exec(end >= 0 ? rest.slice(0, end) : rest);
    out.push({ cmd: unescapeJs(m[1]), cwd: w ? unescapeJs(w[1]) : null });
  }
  return out;
}

function codexPatchText(p) {
  if (!p) return null;
  if (p.type === 'custom_tool_call' && typeof p.input === 'string') return p.name === 'apply_patch' ? p.input : jsPatchArg(p.input);
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

function handleCodexLine(st, line, absOffset, headOnly) {
  const len = line.length;
  if (len < 2) return;
  const meta = line.indexOf(CX_META) >= 0 && len < 400000;
  const turn = !meta && line.indexOf(CX_TURN) >= 0 && len < 400000;
  const patch = line.indexOf(CX_PATCH) >= 0;
  const user = !st.firstPrompt && line.indexOf(CX_USER) >= 0 && len < 200000;
  const exec = line.indexOf(CX_EXEC) >= 0 || line.indexOf(CX_SHELL) >= 0;
  const compacted = !st.firstPrompt && line.indexOf(CX_COMPACT) >= 0;
  // 도구 결과 줄: 통째로 풀지 않고(명령 출력이 클 수 있다) 호출 ID와 성공 여부만 본다
  if (!headOnly) {
    const head = line.subarray(0, 240);
    if (head.indexOf(CX_OUT) >= 0 || head.indexOf(CX_FOUT) >= 0) {
      const i = line.indexOf(K_CALLID);
      const e = i >= 0 ? line.indexOf(34, i + K_CALLID.length) : -1;
      if (e > 0 && e - i < 200) codexToolDone(st, line.toString('latin1', i + K_CALLID.length, e), line);
      return;
    }
  }
  if (!meta && !turn && !patch && !user && !exec && !compacted) return;
  let o;
  try { o = JSON.parse(line.toString('utf8')); } catch { return; }
  const p = o && typeof o.payload === 'object' && o.payload ? o.payload : null;
  if (!p) return;
  const ts = Date.parse(o.timestamp) || st.mtimeMs || Date.now();
  if (o.type === 'session_meta') {
    if (p.cwd && !st.cwd) st.cwd = p.cwd;
    if (!st.curCwd) st.curCwd = p.cwd || null;
    // 검토(guardian)·하위 에이전트 스레드는 따로 기록 파일을 갖는다 → 뿌리 세션(session_id) 아래로 묶는다
    const isSub = !!p.parent_thread_id || !!(p.source && typeof p.source === 'object' && p.source.subagent);
    if (isSub && typeof p.session_id === 'string' && p.session_id) { st.sub = true; st.rootSid = 'codex:' + p.session_id; }
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
  if (headOnly) return;
  // 요즘 형식: exec 안의 자바스크립트. 결과 줄이 와야 반영 여부를 알 수 있어 호출 ID로 기다려 둔다
  if (p.type === 'custom_tool_call' && p.name !== 'apply_patch' && typeof p.input === 'string') {
    const id = typeof p.call_id === 'string' ? p.call_id : null;
    const wait = st.pendingCx || (st.pendingCx = {});
    // 한 스크립트에 패치와 명령이 함께 들어 있기도 하다
    const text = jsPatchArg(p.input);
    const parts = text ? parsePatch(text, st.curCwd || st.cwd).map((f) => ({ path: f.path, add: f.add, del: f.del, op: f.op })) : [];
    const cmds = jsCommands(p.input).map((c) => ({ cmd: c.cmd.slice(0, 20000), cwd: c.cwd }));
    if (!parts.length && !cmds.length) return;
    if (parts.length) noteTool(st, { id, tool: 'apply_patch', arg: path.basename(parts[0].path), path: parts[0].path, ts, done: false });
    else noteTool(st, { id, tool: 'exec', arg: String(cmds[cmds.length - 1].cmd).split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 80), ts, done: false });
    if (id) wait[id] = { ts, offset: absOffset, length: len, cwd: st.curCwd || st.cwd, parts: parts.length ? parts : null, cmds: cmds.length ? cmds : null };
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

// Codex 도구가 끝남: 기다려 둔 패치·명령을 반영한다
function codexToolDone(st, id, line) {
  if (st.lastTool && st.lastTool.id === id) st.lastTool.done = true;
  const pend = st.pendingCx && st.pendingCx[id];
  if (!pend) return;
  delete st.pendingCx[id];
  const j = line.indexOf(K_TS);
  const e = j >= 0 && j < 64 ? line.indexOf(34, j + K_TS.length) : -1;
  const doneTs = (e > 0 && Date.parse(line.toString('latin1', j + K_TS.length, e))) || pend.ts;
  // "Script failed"(패치 검증 실패 등)는 파일에 반영되지 않은 수정이다
  if (pend.parts && line.indexOf(CX_FAILED) < 0) {
    pend.parts.forEach((f, i) => {
      pushChange(st, {
        kind: 'cxedit', path: f.path, ts: doneTs, add: f.add, del: f.del, created: f.op === 'Add', deleted: f.op === 'Delete',
        offset: pend.offset, length: pend.length, idx: i,
      });
    });
  }
  for (const c of pend.cmds || []) {
    const cwd = c.cwd || pend.cwd;
    for (const t of shellTargets(c.cmd, cwd)) {
      let s;
      try { s = fs.statSync(t); } catch { continue; }
      if (!s.isFile() || s.mtimeMs < pend.ts - 2000) continue;
      pushChange(st, { kind: 'shell', path: t, ts: pend.ts, add: 0, del: 0, created: false, cmd: shortCmd(c.cmd), cwd });
    }
    if (!looksReadOnly(c.cmd)) (st.bashWins || (st.bashWins = [])).push({ from: pend.ts, to: doneTs, dirs: dirsFor(c.cmd, cwd), cwd, cmd: shortCmd(c.cmd), resolved: false });
    if (COMMIT_CMD_RE.test(c.cmd)) {
      const single = !/\b(?:merge|cherry-pick|revert|am|rebase)\b/.test(c.cmd);
      st.commitWins.push({ dir: gitDirFor(c.cmd, cwd), from: pend.ts - 3000, to: doneTs + 3000, at: doneTs, single, resolved: false });
    }
  }
}

// headOnly: 파일 맨 앞을 따로 읽을 때. 제목·첫 질문·작업 폴더만 챙기고 변경·도구 기록은 만들지 않는다
function handleLine(st, line, absOffset, headOnly) {
  if (st.agent === 'codex') return handleCodexLine(st, line, absOffset, headOnly);
  const len = line.length;
  if (len < 2) return;
  if (line.subarray(0, 48).indexOf(K_APIREQ) >= 0) return;
  const ri = line.indexOf(K_RESULT);
  if (!headOnly) {
    // 마지막 대화 시각: 시각이 적힌 기록만 센다. 세션이 꺼질 때 붙는 정리 기록(비용·마지막 질문 등)에는 시각이 없어서
    // 파일이 바뀐 시각을 쓰면 몇 시간 전에 끝난 세션이 "방금"으로 보인다.
    const ts = recordTs(line, ri);
    if (ts > (st.lastMsgTs || 0)) st.lastMsgTs = ts;
  }

  if (!st.sub && (line.indexOf(K_CUSTOM) >= 0 || line.indexOf(K_AI) >= 0) && len < 20000) {
    try {
      const o = JSON.parse(line.toString('utf8'));
      if (o.type === 'custom-title' && o.customTitle) st.customTitle = String(o.customTitle);
      if (o.type === 'ai-title' && o.aiTitle) st.aiTitle = String(o.aiTitle);
    } catch { /* 깨진 줄 */ }
    return;
  }

  if (ri >= 0) {
    if (headOnly) return;
    const id = extractToolUseId(line);
    if (id && st.lastTool && st.lastTool.id === id) st.lastTool.done = true;
    let bash = id ? st.pendingBash.get(id) : null;
    // 명령 줄은 읽기 시작 위치보다 앞에 있고 결과만 뒤에 있는 경우: 바뀐 파일 기록은 그대로 살린다
    if (!bash && line.indexOf(K_BASHDIFF) >= 0) bash = { full: '', cmd: '', cwd: st.cwd, ts: tsBefore(line) || st.mtimeMs };
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
        // Claude Code가 바뀐 파일을 적어 두지 않은 명령(python·node 스크립트 등): 명령이 돈 시간대를 적어 두고,
        // 나중에 그 시간대에 바뀐 저장소 파일을 추정으로 넣는다(build에서)
        if (bash.full && !looksReadOnly(bash.full)) {
          (st.bashWins || (st.bashWins = [])).push({ from: bash.ts, to: Math.max(tsBefore(line) || 0, bash.ts), dirs: dirsFor(bash.full, bash.cwd || st.cwd), cwd: bash.cwd || st.cwd, cmd: bash.cmd, resolved: false });
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

  // 도구 호출 줄: 지금 하는 일(마지막 도구)·셸 명령 대기 목록
  if (!headOnly && line.indexOf(K_TOOLUSE) >= 0 && line.indexOf(K_ASSISTANT) >= 0 && (line.indexOf(K_BASHUSE) >= 0 || len < 400000)) {
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (o.type !== 'assistant') return;
    if (o.cwd && !st.cwd) st.cwd = o.cwd;
    const ts = Date.parse(o.timestamp) || st.mtimeMs;
    const c = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const x of c) {
      if (!x || x.type !== 'tool_use' || !x.id) continue;
      noteTool(st, { id: x.id, tool: String(x.name || ''), arg: summarizeInput(x.name, x.input), path: toolFilePath(x.name, x.input, o.cwd || st.cwd), ts, done: false });
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
      // 도구가 끼워 넣은 안내문을 걷어 낸 뒤의 첫 말(제목이 없을 때 제목 대신 쓴다)
      const t = cleanPrompt(allTextOfUser(o));
      if (t && t[0] !== '<' && !/^Caveat:/.test(t)) st.firstPrompt = t.slice(0, 60);
    }
  }
}

// sinceMs를 주면, 처음 읽는 큰 파일은 그 시각 근처에서부터 읽는다(seekMinBytes는 시험용)
function scanAppended(st, sinceMs, seekMinBytes) {
  let fd;
  try { fd = fs.openSync(st.file, 'r'); } catch { return 0; }
  let read = 0;
  let headTitle = null;
  extraRead = 0;
  try {
    const stat = fs.fstatSync(fd);
    // 파일이 줄었거나(다시 써짐) 다른 파일로 바뀌었으면 처음부터
    if (stat.size < st.offset || (st.ino && stat.ino && st.ino !== stat.ino)) {
      const fresh = newFileState(st);
      Object.assign(st, fresh);
    }
    st.ino = stat.ino;
    if (st.offset === 0 && st.scanFrom == null) {
      const from = sinceMs ? sinceMs - SEEK_MARGIN_MS : 0;
      const start = from > 0 ? seekByTime(fd, stat.size, from, seekMinBytes) : 0;
      if (start > 0) {
        read += scanHead(st, fd, Math.min(HEAD_BYTES, start));
        // 맨 앞의 제목은 옛 것일 수 있다: 따로 두고, 읽는 구간이나 그 앞쪽에서 더 새 제목을 찾는다
        headTitle = { customTitle: st.customTitle, aiTitle: st.aiTitle };
        st.customTitle = null;
        st.aiTitle = null;
        st.offset = start;
        st.coveredSince = from;
      }
      st.scanFrom = start;
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
    if (st.scanFrom > 0 && st.agent !== 'codex') {
      if (!st.sub && !st.customTitle && !st.aiTitle && !st.titleSearched) {
        st.titleSearched = true;
        read += findLastTitle(st, fd, st.scanFrom, stat.size);
        if (headTitle && !st.customTitle && !st.aiTitle) Object.assign(st, headTitle);
      }
      // 읽은 구간에 대화가 없으면(오래 쉬던 세션) 그 앞에서 마지막 대화 시각을 찾는다
      if (!st.lastMsgTs) st.lastMsgTs = findLastMessageTs(fd, st.scanFrom);
    }
  } finally {
    fs.closeSync(fd);
  }
  return read + extraRead;
}

// 보는 기간보다 오래된 세션: 목록에 보여 줄 것(제목·첫 질문·마지막 대화 시각)만 읽는다. 변경 기록은 읽지 않는다.
function scanMeta(st) {
  let fd;
  try { fd = fs.openSync(st.file, 'r'); } catch { return 0; }
  let read = 0;
  extraRead = 0;
  try {
    const stat = fs.fstatSync(fd);
    Object.assign(st, newFileState(st));
    read += scanHead(st, fd, Math.min(HEAD_BYTES, stat.size));
    if (st.agent !== 'codex') {
      const headTitle = { customTitle: st.customTitle, aiTitle: st.aiTitle };
      st.customTitle = null;
      st.aiTitle = null;
      read += findLastTitle(st, fd, stat.size, stat.size);
      if (!st.customTitle && !st.aiTitle) Object.assign(st, headTitle);
      st.lastMsgTs = findLastMessageTs(fd, stat.size);
    }
    st.metaOnly = true;
    st.scanFrom = stat.size;
    st.offset = stat.size;
    st.size = stat.size;
    st.mtimeMs = stat.mtimeMs;
    st.ino = stat.ino;
  } finally {
    fs.closeSync(fd);
  }
  return read + extraRead;
}

// ---------- git 커밋 → 파일 ----------

// 폴더 → { top: 작업 폴더 뿌리, common: 저장소 공통 폴더(worktree끼리 같음) }
const topCache = new Map();
function gitInfo(dir) {
  if (topCache.has(dir)) return topCache.get(dir);
  let info = null;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    if (out[0]) info = { top: out[0], common: out[1] ? path.resolve(dir, out[1]) : out[0] };
  } catch { info = null; }
  topCache.set(dir, info);
  return info;
}

function gitTop(dir) {
  const info = gitInfo(dir);
  return info ? info.top : null;
}

// 저장소의 최근 커밋과 그 파일 목록을 git 한 번으로 읽어 둔다.
// (커밋마다 git을 따로 부르면 처음 읽을 때 150번쯤 불러 몇 초가 걸린다)
const repoLogs = new Map(); // common → { since, fetchedAt, commits }
function fetchRepoLog(top, sinceMs) {
  let out;
  try {
    out = execFileSync('git', ['-C', top, 'log', '--all', '--numstat', '-M', '--format=%x01%H%x09%ct%x09%s', `--since=${new Date(sinceMs).toISOString()}`],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const commits = [];
  for (const block of out.split('\x01')) {
    const lines = block.split('\n');
    const [sha, ct, ...rest] = (lines[0] || '').split('\t');
    if (!/^[0-9a-f]{40}$/.test(sha || '')) continue;
    const files = [];
    for (const l of lines.slice(1)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
      if (m) files.push({ rel: renamedTo(m[3]), add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2] });
    }
    commits.push({ sha, ts: Number(ct) * 1000, subject: rest.join('\t'), files });
  }
  return commits;
}

// needSince 뒤의 커밋 목록. freshAfter 뒤에 읽은 것이어야 한다(방금 생긴 커밋을 놓치지 않게).
function repoCommits(info, needSince, freshAfter) {
  let c = repoLogs.get(info.common);
  if (!c || c.since > needSince) {
    const commits = fetchRepoLog(info.top, needSince);
    if (!commits) return null;
    c = { since: needSince, fetchedAt: Date.now(), commits };
    repoLogs.set(info.common, c);
  } else if (c.fetchedAt < freshAfter) {
    const at = Date.now();
    const more = fetchRepoLog(info.top, c.fetchedAt - 60000);
    if (more) {
      const have = new Set(c.commits.map((x) => x.sha));
      for (const x of more) if (!have.has(x.sha)) c.commits.push(x);
      c.fetchedAt = at;
    }
  }
  return c.commits;
}

function renamedTo(p) {
  if (p.includes('{') && p.includes(' => ')) return p.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/\/\//g, '/');
  if (p.includes(' => ')) return p.split(' => ').pop();
  return p;
}

const commitCache = new Map();
function resolveCommit(c, fallbackDirs, since) {
  const dirs = [c.cwd, ...fallbackDirs].filter((d, i, a) => d && a.indexOf(d) === i);
  for (const d of dirs) {
    try { if (!fs.statSync(d).isDirectory()) continue; } catch { continue; }
    const info = gitInfo(d);
    if (!info) continue;
    const top = info.top;
    const key = top + '@' + c.sha;
    if (commitCache.has(key)) return commitCache.get(key);
    // 먼저 한 번에 읽어 둔 최근 커밋 목록에서 찾고, 없을 때만 git을 따로 부른다
    const recent = since ? repoCommits(info, since - 5000, c.ts + 1000) : null;
    const known = recent ? recent.find((x) => x.sha.startsWith(c.sha)) : null;
    if (known) {
      const res = { top, full: known.sha, subject: known.subject, files: known.files };
      commitCache.set(key, res);
      return res;
    }
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
function commitsInWindow(w, fallbackDir, since) {
  for (const d of [w.dir, fallbackDir]) {
    if (!d) continue;
    try { if (!fs.statSync(d).isDirectory()) continue; } catch { continue; }
    const info = gitInfo(d);
    if (!info) continue;
    const commits = repoCommits(info, Math.min(since, w.from) - 5000, w.to + 1000);
    if (!commits) continue;
    // git의 --since/--until 처럼 초 단위로 비교한다
    const lo = Math.floor(w.from / 1000) * 1000;
    const hi = Math.floor(w.to / 1000) * 1000;
    return commits.filter((c) => c.ts >= lo && c.ts <= hi).map((c) => ({ sha: c.sha, ts: c.ts, subject: c.subject, top: info.top, files: c.files }));
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

// Codex 기록은 "세션을 시작한 날" 폴더에 있다. 며칠·몇 주씩 이어 쓰는 세션이 있으니
// 보는 기간보다 CODEX_BACK_DAYS일 앞 폴더까지 훑고, 파일이 바뀐 시각으로 거른다
const CODEX_BACK_DAYS = 60;
function discoverCodex(sinceMs) {
  const out = [];
  const seen = new Set();
  for (let t = sinceMs - CODEX_BACK_DAYS * 86400e3; t <= Date.now() + 3600e3; t += 86400e3) {
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

// listSinceMs·projectDirs: 이 폴더의 세션은 보는 기간보다 오래돼도(listSinceMs까지) 목록용으로 찾는다(meta: true)
// otherListSinceMs: 다른 폴더의 세션도 이 시각까지는 목록용으로 찾는다(보통 더 짧은 기간)
function discover(sinceMs, registry, includeCodex, listSinceMs, projectDirs, otherListSinceMs) {
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
      if (st.mtimeMs < sinceMs && !registry.has(sid)) {
        const cut = projectDirs && projectDirs.has(p.name) ? listSinceMs : otherListSinceMs;
        if (cut && st.mtimeMs >= cut) out.push({ file: f, sid, sub: false, project: p.name, meta: true });
        continue;
      }
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

// ---------- 내가 보낸 말 색인(대화 내용으로 세션 찾기) ----------
// 대화 기록은 수 GB라 찾을 때마다 다 읽을 수 없다. 사용자가 직접 쓴 말만 따로 모아 두고(기록 파일이 자란 만큼만 더 읽음) 그 안에서 찾는다.
const PROMPT_INDEX_VERSION = 3; // 2: 세션 답의 첫 줄(reply), 끼워 넣은 말 빼기. 3: Codex 기록도 모은다
const PROMPT_MAX = 2000;
const K_ISMETA = B('"isMeta":true');

function cleanPrompt(text) {
  let t = String(text || '');
  if (!t) return '';
  // 도구·시스템이 끼워 넣은 덩어리는 사용자가 쓴 말이 아니다
  t = t.replace(/<(system-reminder|ide_opened_file|ide_selection|local-command-stdout|local-command-caveat|command-message|command-args|task-notification|browser_instruction)[^>]*>[\s\S]*?<\/\1>/g, ' ');
  t = t.replace(/<command-name>([^<]*)<\/command-name>/g, '$1 ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > PROMPT_MAX ? t.slice(0, PROMPT_MAX) : t;
}

// 사용자가 친 것이 아니라 Claude Code가 끼워 넣은 user 기록(중단 표시, 긴 대화 요약, 명령 안내)
const NOT_TYPED_RE = /^(\[Request interrupted by user|This session is being continued from a previous conversation|Caveat: The messages below were generated)/;
const K_TEXTPART = B('"type":"text"');

// 세션이 답한 글의 첫 줄(마크다운 꾸밈은 걷어 낸다). 사용자의 세션들은 첫 줄에 결론을 쓴다
function replyHead(text) {
  for (const raw of String(text || '').split('\n')) {
    const t = raw.replace(/^\s*(#{1,6}\s+|[-*]\s+|>\s*)/, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
    if (t) return t.length > 300 ? t.slice(0, 300) + '…' : t;
  }
  return '';
}

// Codex 기록에서 내가 친 말: user 메시지의 글 조각 가운데 Codex가 끼워 넣은 것(AGENTS.md·환경 정보 등)을 뺀 나머지
const K_CXASSIST = B('"role":"assistant"');
const K_RESPONSE = B('"response_item"');
function codexPromptText(content) {
  const parts = [];
  for (const c of Array.isArray(content) ? content : []) {
    const t = c && typeof c.text === 'string' ? c.text.trim() : '';
    if (!t || t.startsWith('<') || t.startsWith('#') || /AGENTS\.md|environment_context|user_instructions/.test(t.slice(0, 200))) continue;
    parts.push(t);
  }
  return cleanPrompt(parts.join(' '));
}

// Codex 기록 한 줄: 하위 스레드(검토·하위 에이전트, 부모가 시킨 말)는 통째로 뺀다. 차례마다 마지막 답의 첫 줄을 남긴다
function codexPromptLine(e, line) {
  if (e.skip || line.length < 2 || line.length > 400000) return;
  const meta = line.indexOf(CX_META);
  if (meta >= 0 && meta < 80) {
    let o; try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const p = (o && o.payload) || {};
    if (p.parent_thread_id || (p.source && typeof p.source === 'object' && p.source.subagent)) { e.skip = true; e.prompts = []; return; }
    if (typeof p.cwd === 'string' && !e.cwd) e.cwd = p.cwd;
    return;
  }
  if (line.indexOf(K_RESPONSE) < 0) return;
  const user = line.indexOf(CX_USER) >= 0;
  if (!user && !(e.open && e.prompts.length && line.indexOf(K_CXASSIST) >= 0)) return;
  let o; try { o = JSON.parse(line.toString('utf8')); } catch { return; }
  const p = (o && o.payload) || {};
  if (p.type !== 'message') return;
  const ts = Date.parse(o.timestamp) || 0;
  if (p.role === 'user') {
    const text = codexPromptText(p.content);
    if (text.length < 2) return;
    e.prompts.push({ ts, text });
    e.open = true;
    if (!e.title) e.title = text.slice(0, 60);
  } else if (p.role === 'assistant' && e.open && e.prompts.length) {
    const txt = (Array.isArray(p.content) ? p.content : []).filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
    const head = replyHead(txt);
    if (head) { const last = e.prompts[e.prompts.length - 1]; last.reply = head; last.replyTs = ts; }
  }
}

function createPromptIndex() {
  const idx = new Map(); // 기록 파일 → { offset, size, mtimeMs, sid, cwd, title, prompts: [{ ts, text }] }
  let loadedFrom = null;
  let dirty = false;

  function load(file) {
    if (loadedFrom === file) return;
    loadedFrom = file;
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.v === PROMPT_INDEX_VERSION && Array.isArray(data.files)) for (const e of data.files) if (e && e.file) idx.set(e.file, e);
    } catch { /* 없거나 깨짐: 처음부터 */ }
  }

  function save(file) {
    if (!file || !dirty) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ v: PROMPT_INDEX_VERSION, files: [...idx.values()] }));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch { /* 다음에 다시 */ }
  }

  function readMore(e) {
    let fd;
    try { fd = fs.openSync(e.file, 'r'); } catch { return 0; }
    let read = 0;
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size < e.offset) { e.offset = 0; e.prompts = []; e.skip = false; e.open = false; }
      let pos = e.offset;
      let carry = null;
      const buf = Buffer.allocUnsafe(CHUNK);
      const onLine = e.codex ? (line) => codexPromptLine(e, line) : (line) => {
        if (line.length < 2) return;
        if (line.length < 20000 && (line.indexOf(K_CUSTOM) >= 0 || line.indexOf(K_AI) >= 0)) {
          try { const o = JSON.parse(line.toString('utf8')); if (o.type === 'custom-title' && o.customTitle) { e.title = String(o.customTitle); e.custom = true; } else if (o.type === 'ai-title' && o.aiTitle && !e.custom) e.title = String(o.aiTitle); } catch { /* 깨진 줄 */ }
          return;
        }
        // 세션의 답: 마지막 말 다음에 나온 assistant 글. 차례가 끝날 때까지 덮어써서 마지막 답의 첫 줄이 남는다
        if (e.open && e.prompts.length && line.length < 400000 && line.indexOf(K_ASSISTANT) >= 0 && line.indexOf(K_TEXTPART) >= 0 && line.subarray(0, 48).indexOf(K_APIREQ) < 0) {
          let a;
          try { a = JSON.parse(line.toString('utf8')); } catch { return; }
          if (!a || a.type !== 'assistant' || a.isSidechain || !a.message || !Array.isArray(a.message.content)) return;
          const txt = a.message.content.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
          const head = replyHead(txt);
          if (head) { const last = e.prompts[e.prompts.length - 1]; last.reply = head; last.replyTs = Date.parse(a.timestamp) || 0; }
          return;
        }
        // 사용자가 쓴 말: user 기록이면서 도구 결과가 아니고, 시스템이 끼워 넣은 것(isMeta)이 아닌 줄
        if (line.length > 400000 || line.indexOf(K_USER) < 0 || line.indexOf(K_TOOLUSEID) >= 0) return;
        if (line.subarray(0, 48).indexOf(K_APIREQ) >= 0) return;
        let o;
        try { o = JSON.parse(line.toString('utf8')); } catch { return; }
        if (!o || o.type !== 'user' || o.toolUseResult || o.isSidechain) return;
        // 차례 경계: 다른 세션이 보낸 말(peer)·작업 알림·명령 뒤에 나온 답은 그 일에 대한 것이라 앞의 내 말에 붙이지 않는다.
        // 그림 첨부 같은 isMeta 기록과 긴 대화 요약은 같은 차례 안의 것이라 경계로 보지 않는다
        const kind = o.origin && typeof o.origin === 'object' && typeof o.origin.kind === 'string' ? o.origin.kind : '';
        if (o.isMeta) { if (kind === 'peer') e.open = false; return; }
        if (o.isCompactSummary) return;
        if (kind && kind !== 'human') { e.open = false; return; }
        if (o.cwd && !e.cwd) e.cwd = o.cwd;
        const text = cleanPrompt(allTextOfUser(o));
        if (text.length < 2 || text[0] === '<' || NOT_TYPED_RE.test(text)) { e.open = false; return; }
        e.prompts.push({ ts: Date.parse(o.timestamp) || 0, text });
        e.open = true;
      };
      while (pos < stat.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, stat.size - pos), pos);
        if (n <= 0) break;
        read += n;
        const chunk = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let start = 0;
        let i;
        while ((i = chunk.indexOf(NL, start)) !== -1 && !e.skip) { onLine(chunk.subarray(start, i)); start = i + 1; }
        carry = start < chunk.length ? Buffer.from(chunk.subarray(start)) : null;
        pos += n;
        if (e.skip) { pos = stat.size; carry = null; break; } // 하위 스레드: 첫 줄에서 알아봤으니 나머지는 읽지 않는다
      }
      e.offset = pos - (carry ? carry.length : 0);
      e.size = stat.size;
      e.mtimeMs = stat.mtimeMs;
    } finally { fs.closeSync(fd); }
    return read;
  }

  // 색인을 지금 기록에 맞춘다. onProgress(끝난 파일 수, 전체 파일 수)
  function update(opts) {
    load(opts.indexFile);
    const found = [];
    let projs = [];
    try { projs = fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { projs = []; }
    for (const p of projs) {
      if (!p.isDirectory()) continue;
      let ents = [];
      try { ents = fs.readdirSync(path.join(PROJECTS, p.name), { withFileTypes: true }); } catch { continue; }
      for (const en of ents) if (en.isFile() && en.name.endsWith('.jsonl')) found.push({ file: path.join(PROJECTS, p.name, en.name), sid: en.name.slice(0, -6) });
    }
    // Codex 기록(~/.codex/sessions/연/월/일/rollout-…-<id>.jsonl). 세션 ID는 화면과 같은 "codex:<id>"
    if (opts.includeCodex !== false) {
      const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
      for (const y of ls(CODEX_SESSIONS)) {
        if (!y.isDirectory()) continue;
        for (const m of ls(path.join(CODEX_SESSIONS, y.name))) {
          if (!m.isDirectory()) continue;
          for (const d of ls(path.join(CODEX_SESSIONS, y.name, m.name))) {
            if (!d.isDirectory()) continue;
            const dir = path.join(CODEX_SESSIONS, y.name, m.name, d.name);
            for (const f of ls(dir)) {
              if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue;
              const u = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(f.name);
              found.push({ file: path.join(dir, f.name), sid: 'codex:' + (u ? u[1] : f.name), codex: true });
            }
          }
        }
      }
    }
    const keep = new Set(found.map((f) => f.file));
    for (const k of [...idx.keys()]) if (!keep.has(k)) { idx.delete(k); dirty = true; }
    let done = 0;
    let bytes = 0;
    for (const f of found) {
      let st;
      try { st = fs.statSync(f.file); } catch { done++; continue; }
      let e = idx.get(f.file);
      if (!e) { e = { file: f.file, sid: f.sid, offset: 0, size: 0, mtimeMs: 0, cwd: null, title: null, prompts: [], codex: !!f.codex }; idx.set(f.file, e); }
      if (st.size !== e.size || st.mtimeMs !== e.mtimeMs) { bytes += readMore(e); dirty = true; }
      done++;
      if (opts.onProgress) opts.onProgress(done, found.length);
    }
    save(opts.indexFile);
    return { files: found.length, bytes };
  }

  // 낱말(띄어 쓴 것 모두)이 다 들어 있는 말을 최근 것부터 찾는다
  function search(query, opts) {
    const o = opts || {};
    const stats = update(o);
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    if (terms.length) {
      for (const e of idx.values()) {
        for (const p of e.prompts) {
          const low = p.text.toLowerCase();
          if (!terms.every((t) => low.includes(t))) continue;
          const at = Math.max(0, low.indexOf(terms[0]) - 40);
          out.push({ sid: e.sid, file: e.file, cwd: e.cwd, project: e.cwd ? path.basename(e.cwd) : null, title: e.title || (e.prompts[0] ? e.prompts[0].text.slice(0, 60) : e.sid.slice(0, 8)), ts: p.ts, snippet: (at > 0 ? '…' : '') + p.text.slice(at, at + 160) });
        }
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    const max = o.max || 200;
    return { results: out.slice(0, max), total: out.length, stats };
  }

  // 고른 세션들에 내가 쓴 말을 최근 것부터(그룹 보드의 "내가 한 말")
  function recent(sids, opts) {
    const o = opts || {};
    const stats = update(o);
    const want = new Set((sids || []).map(String));
    const out = [];
    for (const e of idx.values()) {
      if (!want.has(e.sid)) continue;
      for (const p of e.prompts) out.push({ sid: e.sid, title: e.title || '', ts: p.ts, text: p.text, reply: p.reply || '', replyTs: p.replyTs || 0 });
    }
    out.sort((a, b) => b.ts - a.ts);
    return { results: out.slice(0, o.max || 50), total: out.length, stats };
  }

  return { update, search, recent };
}

// ---------- 읽은 결과 저장(창을 다시 열어도 새로 붙은 부분만 읽게) ----------

function serializeState(st) {
  const dayAgo = Date.now() - 86400e3;
  const pending = [...st.pendingBash].filter(([, b]) => b.ts >= dayAgo).map(([id, b]) => [id, { ...b, full: String(b.full || '').slice(0, 20000) }]);
  const cx = {};
  for (const [id, v] of Object.entries(st.pendingCx || {})) if (v && v.ts >= dayAgo) cx[id] = v;
  return { ...st, pendingBash: pending, pendingCx: cx, bashWins: (st.bashWins || []).filter((w) => !w.resolved && w.to >= Date.now() - 7 * 86400e3), seenSha: [...st.seenSha] };
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
  let discSids = new Set(); // 지난번에 찾은(또는 찾아 봤지만 기록 파일이 아직 없던) 세션
  let codexDirSeen = -1;
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
      let lastWrite = 0;
      let cwd = reg.cwd;
      for (const st of files.values()) {
        if (st.sid !== sid) continue;
        lastWrite = Math.max(lastWrite, st.mtimeMs);
        lastActivity = Math.max(lastActivity, st.lastMsgTs || 0);
        cwd = st.cwd || cwd;
      }
      let s = { sid, alive: true, status: reg.status, waitingFor: reg.waitingFor, statusSince: reg.statusSince, lastActivity: lastActivity || lastWrite, cwd, project: cwd ? path.basename(cwd) : null };
      s = applyMarker(s, attentionMarker(opts.attentionDir, sid), lastWrite);
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
    const lookMs = Math.max(0.1, Number(opts.lookbackHours) || 24) * 3600e3; // 소수 허용(10분 = 0.1667)
    const since = t0 - lookMs;
    const registry = readRegistry();
    // 세션 목록용: 이 폴더(workspaceDirs)의 세션은 listDays일 전까지 보여 준다(Claude 목록의 자동 보관 기준과 같은 14일이 기본)
    const listDays = Math.max(0, Number(opts.listDays) || 0);
    const listSince = listDays ? Math.min(since, t0 - listDays * 86400e3) : 0;
    const dirs = (Array.isArray(opts.workspaceDirs) ? opts.workspaceDirs : []).map((d) => String(d).replace(/[^a-zA-Z0-9]/g, '-'));
    // 다른 폴더의 세션은 otherListDays일 전까지(그 폴더 창의 목록에 남아 있을 만큼 최근 것만)
    const otherDays = Math.max(0, Number(opts.otherListDays) || 0);
    const otherSince = otherDays ? Math.min(since, t0 - otherDays * 86400e3) : 0;
    const dirSet = new Set(dirs);
    const discKey = `${lookMs}|${listDays}|${otherDays}|${dirs.join(',')}`;
    // 새 세션은 주기(DISCOVERY_MS)를 기다리지 않고 바로 찾는다: 실행 중 목록에 처음 보는 세션이 생겼거나, 오늘 자 Codex 폴더에 파일이 생겼을 때
    let fresh = false;
    for (const sid of registry.keys()) if (!discSids.has(sid)) { fresh = true; break; }
    let codexDir = -1;
    if (opts.includeCodex !== false) { try { codexDir = fs.statSync(path.join(CODEX_SESSIONS, ...localDay(t0))).mtimeMs; } catch { codexDir = -1; } }
    if (codexDir !== codexDirSeen) fresh = true;
    if (opts.force || fresh || t0 - lastDisc > DISCOVERY_MS || discKey !== lastLook) {
      disc = discover(since, registry, opts.includeCodex !== false, listSince, dirSet, otherSince);
      lastDisc = t0;
      lastLook = discKey;
      discSids = new Set([...disc.map((d) => d.sid), ...registry.keys()]);
      codexDirSeen = codexDir;
    }
    let bytes = 0;
    let lastProgress = Date.now();
    // 실행 중인 세션의 기록부터, 본 기록을 하위 에이전트 기록보다 먼저 읽는다(먼저 읽은 것부터 화면에 보여 주려고)
    const order = [...disc].sort((a, b) => Number(registry.has(b.sid)) - Number(registry.has(a.sid)) || Number(a.sub) - Number(b.sub));
    for (const d of order) {
      let st = files.get(d.file);
      if (!st) { st = newFileState(d); files.set(d.file, st); }
      let s;
      try { s = fs.statSync(d.file); } catch { continue; }
      const pin = Number((opts.pinned || {})[st.rootSid || d.sid]) || 0;
      const fileSince = pin ? Math.min(since, pin) : since;
      if (d.meta && !pin) {
        // 오래된 세션: 목록용 요약만. 이미 제대로 읽어 둔 파일이면 그대로 쓴다
        if (st.scanFrom != null && !st.metaOnly) continue;
        if (!st.metaOnly || s.size !== st.size || s.mtimeMs !== st.mtimeMs) { bytes += scanMeta(st); dirty = true; }
        continue;
      }
      if (st.metaOnly) Object.assign(st, newFileState(d)); // 요약만 읽어 둔 파일이 보는 기간 안으로 들어옴 → 제대로 읽는다
      // 보는 기간이 늘어 이미 읽은 구간보다 앞이 필요해지면 그 파일만 다시 읽는다
      if (st.scanFrom > 0 && fileSince - SEEK_MARGIN_MS < st.coveredSince - 60000) Object.assign(st, newFileState(d));
      if (s.size !== st.offset || s.mtimeMs !== st.mtimeMs || (st.ino && s.ino !== st.ino) || st.scanFrom == null) {
        const n = scanAppended(st, fileSince, opts.seekMinBytes);
        bytes += n;
        dirty = true;
        if (n > 0 && opts.onProgress && Date.now() - lastProgress > (opts.progressMs == null ? 800 : opts.progressMs)) {
          opts.onProgress({ sessions: build(registry, since, t0, opts, true) });
          lastProgress = Date.now();
        }
      }
    }

    // 읽기는 끝났고 git 확인이 남았다: 읽는 데 시간이 걸렸으면 지금까지의 결과를 먼저 보여 준다
    if (opts.onProgress && bytes > 0 && Date.now() - t0 > 300) opts.onProgress({ sessions: build(registry, since, t0, opts, true) });
    // 요약만 읽은 옛 세션은 Claude Code 세션 목록에 나오는 것만: 목록 기간 안이고, 프로그램이 돌린 세션이 아닌 것
    // 제목도 첫 질문도 없는 세션(다른 세션이 보낸 메시지나 로컬 명령만 있는 것)도 Claude Code처럼 뺀다
    const sessions = build(registry, since, t0, opts, false).filter((s) => {
      if (!s.metaOnly) return true;
      if (s.programmatic || s.titleSource === 'id') return false;
      const cut = dirSet.has(s.projectDir) ? listSince : otherSince;
      return !!cut && s.lastActivity >= cut;
    });
    maybeSave(opts, !!opts.flush);
    return { sessions, stats: { ms: Date.now() - t0, files: disc.length, bytes } };
  }

  // 읽은 상태 → 세션 목록. partial이면(읽는 도중) 아직 안 읽은 세션은 빼고 git 확인도 미룬다
  function build(registry, since, t0, opts, partial) {
    const bySid = new Map();
    for (const d of disc) {
      const st = files.get(d.file);
      if (!st) continue;
      const key = st.rootSid || d.sid; // Codex 하위 스레드는 뿌리 세션에 묶는다
      if (!bySid.has(key)) bySid.set(key, []);
      bySid.get(key).push(st);
    }

    // 다른 기록으로 이미 설명되는 변경(편집 도구·기록된 셸 변경·Codex 패치): 경로 → 시각들. 추정에 다시 넣지 않는다
    const exact = new Map();
    if (!partial) {
      for (const st of files.values()) {
        for (const c of st.changes) {
          if (!c.path || (c.kind !== 'edit' && c.kind !== 'bash' && c.kind !== 'cxedit')) continue;
          if (!exact.has(c.path)) exact.set(c.path, []);
          exact.get(c.path).push(c.ts);
        }
      }
    }
    const explained = (p, at) => (exact.get(p) || []).some((ts) => Math.abs(ts - at) <= 3000);
    const pins = opts.pinned && typeof opts.pinned === 'object' ? opts.pinned : {};

    const sessions = [];
    for (const [sid, sts] of bySid) {
      const main = sts.find((x) => !x.sub) || sts[0];
      // 사용자가 불러온 세션은 그 세션의 마지막 작업 구간까지 본다
      const pinSince = Number(pins[sid]) || 0;
      const sSince = pinSince ? Math.min(since, pinSince) : since;
      if (partial && main.scanFrom == null && main.offset === 0) continue;
      const reg = registry.get(sid) || null;
      const projectCwd = main.cwd || (reg && reg.cwd) || null;
      const changes = [];
      let lastActivity = 0; // 마지막 대화 시각(Claude 세션 목록이 보여 주는 시간과 같은 뜻)
      let lastWrite = 0; // 기록 파일이 마지막으로 바뀐 시각
      for (const st of sts) {
        lastWrite = Math.max(lastWrite, st.mtimeMs);
        lastActivity = Math.max(lastActivity, st.lastMsgTs || 0);
        for (const c of partial ? [] : st.commits) {
          if (c.resolved || c.ts < sSince) continue;
          c.resolved = true;
          dirty = true;
          const res = resolveCommit(c, [projectCwd], sSince);
          if (!res) {
            st.changes.push({ kind: 'commit', path: null, ts: c.ts, add: 0, del: 0, sha: c.sha, msg: c.msg, unresolved: true, sub: st.sub, file: st.file, scratch: false });
            continue;
          }
          addCommitEntries(st, res, c.ts, c.msg);
        }
        for (const w of partial ? [] : st.commitWins) {
          if (w.resolved || w.to < sSince) continue;
          w.resolved = true;
          dirty = true;
          let hits = commitsInWindow(w, projectCwd, sSince);
          // 커밋 하나만 만드는 명령인데 같은 시간대에 여러 개가 있으면(다른 세션 커밋) 끝난 시각에 가장 가까운 것만
          if (w.single && hits.length > 1) hits = [hits.reduce((a, b) => (Math.abs(a.ts - w.at) <= Math.abs(b.ts - w.at) ? a : b))];
          for (const hit of hits) addCommitEntries(st, { top: hit.top, full: hit.sha, subject: hit.subject, files: hit.files }, hit.ts, hit.subject);
        }
        // 셸 명령이 돈 시간대에 바뀐(아직 커밋되지 않은) 저장소 파일을 추정으로 넣는다
        for (const w of partial ? [] : st.bashWins || []) {
          if (w.resolved || w.to < sSince) continue;
          w.resolved = true;
          dirty = true;
          // 명령이 돈 폴더들이 속한 저장소(같은 저장소는 한 번만)
          const tops = new Set();
          for (const d of w.dirs && w.dirs.length ? w.dirs : [w.cwd]) { const info = d && inGitTree(d) ? gitInfo(d) : null; if (info) tops.add(info.top); }
          let n = 0;
          for (const top of tops) {
            for (const f of repoDirty(top, t0)) {
              if (n >= 200) break;
              if (f.mtimeMs < w.from - 500 || f.mtimeMs > w.to + 1500 || explained(f.path, f.mtimeMs)) continue;
              if (st.changes.some((c) => c.path === f.path && c.kind === 'shell' && c.ts >= w.from - 1000 && c.ts <= w.to + 1500)) continue;
              pushChange(st, { kind: 'shell', path: f.path, ts: Math.round(f.mtimeMs), add: 0, del: 0, created: f.isNew && f.birthMs >= w.from - 1000, cmd: w.cmd, cwd: w.cwd, via: 'mtime' });
              n++;
            }
          }
        }
        for (const c of st.changes) if (c.ts >= sSince) changes.push(c);
      }
      const codex = main.agent === 'codex';
      // 뿌리 세션 기록은 보는 기간 밖이고 하위 스레드(검토 등)만 걸린 Codex 세션: 바꾼 파일이 없으면 보여 줄 것이 없다
      if (codex && main.sub && !changes.length) continue;
      if (!lastActivity || codex) lastActivity = lastWrite;
      let title = main.customTitle || main.aiTitle || null;
      let titleSource = main.customTitle ? 'custom' : main.aiTitle ? 'ai' : null;
      if (!title && reg && reg.name && reg.nameSource !== 'derived') { title = reg.name; titleSource = 'registry'; }
      if (!title && main.firstPrompt) { title = main.firstPrompt; titleSource = 'prompt'; }
      if (!title) { title = codex ? 'Codex ' + sid.slice(6, 14) : sid.slice(0, 8); titleSource = 'id'; }
      // Codex는 실행 중 목록이 없어 최근 기록 시각으로만 작업 중을 짐작한다
      const codexActive = codex && t0 - lastWrite < CODEX_ACTIVE_MS;
      let state = {
        alive: codex ? codexActive : !!reg,
        status: codex ? (codexActive ? 'busy' : null) : reg ? reg.status : null,
        waitingFor: reg ? reg.waitingFor : null,
        statusSince: codex ? (codexActive ? lastActivity : null) : reg ? reg.statusSince : null,
      };
      if (!codex) state = applyMarker(state, attentionMarker(opts.attentionDir, sid), lastWrite);
      const liveFiles = !partial && state.alive && state.status === 'busy' ? recentlyTouched(changes, t0) : [];
      const worktree = projectCwd ? /^(.+)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)$/.exec(projectCwd) : null;
      // 지금 하는 일: 본 세션·하위 에이전트 중 가장 최근 도구 호출
      let activity = null;
      for (const st of sts) {
        if (st.lastTool && (!activity || st.lastTool.ts > activity.ts)) activity = st.lastTool;
      }
      sessions.push({
        sid, title, titleSource,
        agent: main.agent || 'claude',
        address: reg && reg.nameSource === 'derived' ? reg.name : null,
        // Claude Code가 만든 git worktree(<저장소>/.claude/worktrees/<이름>)는 저장소 이름으로 묶는다
        project: worktree ? path.basename(worktree[1]) : projectCwd ? path.basename(projectCwd) : main.project,
        worktree: worktree ? worktree[2] : null,
        cwd: projectCwd,
        lastActivity,
        metaOnly: !!main.metaOnly,
        pinned: !!pinSince,
        projectDir: main.project || null, // ~/.claude/projects 아래 폴더 이름
        file: main.file, // 이 세션의 대화 기록 파일(이름을 바꿀 때 제목 기록을 덧붙인다)
        programmatic: !!main.programmatic,
        ...state,
        activity,
        liveFiles,
        // 하위 에이전트(Codex는 하위 스레드): 기록 파일이 방금까지 자라고 있으면 작업 중으로 본다
        subagents: { total: sts.filter((x) => x.sub).length, active: sts.filter((x) => x.sub && t0 - x.mtimeMs < SUB_ACTIVE_MS).length },
        changes,
      });
    }
    if (!partial) markOverlaps(sessions, t0);
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return sessions;
  }

  return { scan, status, save: (opts) => maybeSave(opts, true) };
}

// 시험용: 기록 파일 하나를 읽은 상태(sinceMs를 주면 그 시각 근처부터)
function scanOne(file, agent, sinceMs, seekMinBytes) {
  const st = newFileState({ file, sid: 'test', sub: false, project: '', agent });
  const read = scanAppended(st, sinceMs, seekMinBytes);
  st.bytesRead = read;
  return st;
}

module.exports = { LIVE_MS, codexPatchText, looksReadOnly, createPromptIndex, createModel, shellTargets, stripHeredocBodies, hunkCounts, isScratch, readRegistry, parsePatch, attentionMarker, scanOne };
