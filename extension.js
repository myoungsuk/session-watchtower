'use strict';
// Session Watchtower: Claude Code 세션마다 상태와 바뀐 파일을 옆 창에 보여 준다. 읽기 전용(되돌리기 없음).
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const { parsePatch, LIVE_MS, codexPatchText } = require('./scanner');

// 화면 글자: 영어 원문 + l10n/bundle.l10n.ko.json(한국어). 날짜·시간 형식만 언어별로 직접 만든다.
const L = (message, ...args) => vscode.l10n.t(message, ...args);
const isKo = () => (vscode.env.language || '').toLowerCase().startsWith('ko');

const VIEW = 'claudeSessionChanges.tree';
const SESSIONS_VIEW = 'claudeSessionChanges.sessions';
const CFG = 'claudeSessionChanges';
const CTX_ALIVE = 'claudeSessionChanges.aliveOnly';
const DIFF_SCHEME = 'claude-session-changes';
const ITEM_SCHEME = 'claude-session-changes-item';
const HOME = os.homedir();
const SCRATCH_DIR_RE = /^\/tmp\/claude-[^/]+\/[^/]+\/[0-9a-f-]{36}\/scratchpad(?:\/(.*))?$/;

let worker = null;
let reqId = 0;
let inflight = false;
let pending = null;
let raw = [];
let loaded = false;
let stillReading = false;
let lastError = null;
let lastFire = 0;
let aliveOnly = false;
let timer = null;
let treeView = null;
let sessionsView = null;
let sessionsModel = [];
let archivedModel = [];
let ctx = null;
const diffRegistry = new Map();
let diffSeq = 0;

// 보는 기간(시간 단위, 소수 허용: 10분 = 0.1667). 6분보다 짧게는 받지 않는다
const MIN_LOOKBACK_H = 0.1;
// 보는 기간을 글자로: 짧게("24h"·"10 min")와 길게("24 hours"·"10 minutes")
const roundH = (h) => Math.round(h * 100) / 100;
function spanShort(h) { return h < 1 ? L('{0} min', Math.round(h * 60)) : L('{0}h', roundH(h)); }
function spanLong(h) { return h < 1 ? L('{0} minutes', Math.round(h * 60)) : L('{0} hours', roundH(h)); }

function cfg() {
  const c = vscode.workspace.getConfiguration(CFG);
  return {
    lookbackHours: Math.max(MIN_LOOKBACK_H, Number(c.get('lookbackHours', 24)) || 24),
    showShellGuesses: c.get('showShellGuesses', true) !== false,
    hideScratchpadFiles: c.get('hideScratchpadFiles', true) !== false,
    includeSubagents: c.get('includeSubagents', true) !== false,
    pollSeconds: Math.max(2, Number(c.get('pollSeconds', 5)) || 5),
    sessionDetails: c.get('sessionDetails', true) !== false,
    sessionListDays: Math.max(0, Math.min(365, Number(c.get('sessionListDays', 90)) || 0)),
    notifyWaiting: c.get('notifyWaiting', true) !== false,
    notifyOverlap: c.get('notifyOverlap', true) !== false,
    overlapIgnore: Array.isArray(c.get('overlapIgnore')) ? c.get('overlapIgnore').map(String) : ['**/.claude/projects/*/memory/**'],
    notifyStuckMinutes: Math.max(0, Number(c.get('notifyStuckMinutes', 10)) || 0),
    explorerMarks: c.get('explorerMarks', true) !== false,
    boardPageSize: Math.min(200, Math.max(5, Number(c.get('boardPageSize', 20)) || 20)),
    archiveAfter: String(c.get('archiveAfter', 'claude')),
    statusBar: c.get('statusBar', true) !== false,
    includeCodex: c.get('includeCodex', true) !== false,
    attentionDir: expandHome(String(c.get('attentionMarkerDir', '~/.cache/claude-attention') || '')),
  };
}

function expandHome(p) {
  if (!p) return '';
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(1));
  return p;
}

// 읽기 스레드에 넘기는 설정(읽은 결과 저장 파일은 VS Code가 이 확장에 주는 전용 폴더)
function workerOpts(extra) {
  const o = cfg();
  return {
    lookbackHours: o.lookbackHours,
    includeCodex: o.includeCodex,
    attentionDir: o.attentionDir,
    cacheFile: ctx ? path.join(ctx.globalStorageUri.fsPath, 'scan-cache-v2.json') : '',
    listDays: o.sessionListDays,
    otherListDays: otherListDays(),
    pinned: Object.fromEntries(pinned),
    workspaceDirs: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    ...extra,
  };
}

// ---------- 표시용 글자 ----------

function fmtTime(ms, withSec) {
  const d = new Date(ms);
  const now = new Date();
  const h = d.getHours();
  const hm = `${((h + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}${withSec ? ':' + String(d.getSeconds()).padStart(2, '0') : ''}`;
  const t = isKo() ? `${h < 12 ? '오전' : '오후'} ${hm}` : `${hm} ${h < 12 ? 'AM' : 'PM'}`;
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return same ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

function fmtAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const ko = isKo();
  if (s < 60) return ko ? '방금 전' : 'just now';
  if (s < 3600) return ko ? `${Math.floor(s / 60)}분 전` : `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return ko ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 3600)}h ago`;
  return ko ? `${Math.floor(s / 86400)}일 전` : `${Math.floor(s / 86400)}d ago`;
}

function fmtFor(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const ko = isKo();
  if (s < 60) return ko ? '방금' : 'just now';
  if (s < 3600) return ko ? `${Math.floor(s / 60)}분째` : `${Math.floor(s / 60)}m`;
  if (s < 86400) return ko ? `${Math.floor(s / 3600)}시간째` : `${Math.floor(s / 3600)}h`;
  return ko ? `${Math.floor(s / 86400)}일째` : `${Math.floor(s / 86400)}d`;
}

// Claude Code가 ~/.claude/sessions/<pid>.json에 적는 status: busy·idle·waiting(waitingFor: permission prompt | input needed)
// 색은 Claude 세션 목록과 같게: 작업 중 초록, 승인·답 기다림 파랑, 방금 끝남(Claude의 "안 읽음") 주황, 쉬는 중 회색
const DONE_MS = 10 * 60 * 1000;
function stateOf(s) {
  const sinceShort = s.statusSince ? fmtFor(s.statusSince) : '';
  const since = sinceShort ? ' · ' + sinceShort : '';
  if (!s.alive) {
    // 실행 중 목록(~/.claude/sessions)에 없음: 창을 닫았거나 끝난 세션. 이어서 쓰면 다시 켜진다.
    const ago = fmtAgo(s.lastActivity);
    return { key: 'off', label: L('Off (no Claude process)'), short: L('Off'), time: ago, text: `${L('Off')} · ${ago}`, icon: new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground')) };
  }
  if (s.status === 'busy') {
    const quietMin = Math.floor((Date.now() - s.lastActivity) / 60000);
    const quiet = quietMin >= 10 ? ` · ${L('no log for {0}m', quietMin)}` : '';
    return { note: quiet.slice(3), key: 'busy', label: L('Working'), short: L('Working'), time: sinceShort, text: `${L('Working')}${since}${quiet}`, icon: new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.green')) };
  }
  if (s.status === 'waiting') {
    const what = s.waitingFor === 'permission prompt' ? L('needs approval') : s.waitingFor === 'input needed' ? L('needs answer') : L('waiting');
    return { key: 'waiting', label: L('Waiting ({0})', what), short: what, time: sinceShort, text: `${L('Waiting')} · ${what}${since}`, icon: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.blue')) };
  }
  if (s.status === 'idle') {
    // 쉰 시간은 마지막 대화부터 센다. 상태가 바뀐 시각은 창을 다시 열 때도 새로 찍혀서,
    // 6시간 전에 끝난 세션이 "방금 끝남"으로 보였다.
    const from = Math.min(s.statusSince || Infinity, s.lastActivity || Infinity);
    const idleFor = Number.isFinite(from) ? fmtFor(from) : '';
    const idleSince = idleFor ? ' · ' + idleFor : '';
    if (s.lastActivity && Date.now() - s.lastActivity < DONE_MS) {
      return { key: 'done', label: L('Just finished'), short: L('Just finished'), time: idleFor, text: `${L('Just finished')}${idleSince}`, icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.orange')) };
    }
    return { key: 'idle', label: L('Idle'), short: L('Idle'), time: idleFor, text: `${L('Idle')}${idleSince}`, icon: new vscode.ThemeIcon('debug-pause') };
  }
  return { key: 'alive', label: L('Running'), short: L('Running'), time: '', text: L('Running'), icon: new vscode.ThemeIcon('circle-filled') };
}


// 지금 고치는 파일. 고치는 도구는 대개 1초 안에 끝나 "도구가 도는 순간"만 보면 화면에 잡히지 않는다.
// 그래서 (가) 아직 끝나지 않은 고치기 도구가 겨냥한 파일(승인 대기 포함),
// (나) 작업 중인 세션이 방금(LIVE_MS 안) 바꾼 파일,
// (다) 작업 중인 세션의 목록에 있는 파일 가운데 디스크에서 방금 바뀐 파일(스크립트로 고쳐 기록이 없는 수정)을 "고치는 중"으로 본다.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function liveState(s, f) {
  if (!s.alive || (s.status !== 'busy' && s.status !== 'waiting')) return null;
  const a = s.activity;
  if (a && !a.done && a.path === f.path && EDIT_TOOLS.has(a.tool)) return s.status === 'waiting' ? 'approval' : 'editing';
  if (s.status !== 'busy') return null;
  return Date.now() - f.lastTs < LIVE_MS || (s.liveFiles || []).includes(f.path) ? 'editing' : null;
}

// "고치는 중" 표시는 새 기록이 없어도 시간이 지나면 꺼져야 한다 → 가장 먼저 끝나는 시각에 한 번 다시 그린다
let liveTimer = null;
function scheduleLiveExpiry() {
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  const t = Date.now();
  let next = Infinity;
  for (const s of model) {
    if (!s.alive || s.status !== 'busy') continue;
    for (const f of s.files) {
      const left = f.lastTs + LIVE_MS - t;
      if (left > 0 && left < next) next = left;
    }
  }
  if (next === Infinity) return;
  liveTimer = setTimeout(() => { liveTimer = null; provider.fire(); updateExplorerMarks(); scheduleLiveExpiry(); }, next + 200);
  if (liveTimer.unref) liveTimer.unref();
}

// "지금 하는 일": 마지막 도구 호출을 쉬운 말로(진행 중일 때만 의미가 있음)
function activityText(a) {
  if (!a || !a.tool) return '';
  const arg = a.arg || '';
  switch (a.tool) {
    case 'Bash': case 'exec': return arg ? L('Running: {0}', arg) : L('Running a command');
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': case 'apply_patch': return arg ? L('Editing {0}', arg) : L('Editing files');
    case 'Read': return arg ? L('Reading {0}', arg) : L('Reading files');
    case 'Grep': case 'Glob': return arg ? L('Searching {0}', arg) : L('Searching');
    case 'Agent': case 'Task': return arg ? L('Subagent: {0}', arg) : L('Running a subagent');
    case 'WebSearch': return arg ? L('Web search: {0}', arg) : L('Searching the web');
    case 'WebFetch': return arg ? L('Opening {0}', arg) : L('Opening a web page');
    default: return arg ? `${a.tool}: ${arg}` : a.tool;
  }
}

// 하위 에이전트가 일하는 중이면 몇 개인지
function subText(s, st) {
  const n = s.subagents ? s.subagents.active : 0;
  if (!n || (st.key !== 'busy' && st.key !== 'waiting')) return '';
  return n === 1 ? L('1 subagent working') : L('{0} subagents working', n);
}

// 작업 중이면 진행 중인 도구, 도구가 끝났으면 "생각 중", 기다림이면 기다리는 도구
function nowText(s, st) {
  if (st.key !== 'busy' && st.key !== 'waiting') return '';
  if (s.activity && !s.activity.done) return activityText(s.activity);
  return st.key === 'busy' ? L('Thinking…') : '';
}

function sessionTooltip(s, st) {
  const now = nowText(s, st);
  return [
    s.title,
    L('Status: {0}', st.label) + (s.statusSince ? ' ' + L('(since {0})', fmtTime(s.statusSince, true)) : ''),
    now ? L('Now: {0}', now) : null,
    s.pinned ? L("Loaded on request: changes from the last {0} of this session's work.", spanShort(cfg().lookbackHours)) : null,
    s.address ? L('Address: {0}', s.address) : null,
    s.cwd ? L('Folder: {0}', s.cwd) : null,
    L('Last log: {0}', fmtTime(s.lastActivity, true)),
    L('Session ID: {0}', s.sid),
  ].filter(Boolean).join('\n');
}

function displayDir(p, s) {
  const d = path.dirname(p);
  const m = SCRATCH_DIR_RE.exec(d);
  if (m) return 'scratchpad' + (m[1] ? '/' + m[1] : '');
  const mem = /^(.*)\/\.claude\/projects\/[^/]+\/memory$/.exec(d);
  if (mem && mem[1] === HOME) return L('Claude memory');
  if (s.cwd && d === s.cwd) return '';
  if (s.cwd && d.startsWith(s.cwd + '/')) return path.relative(s.cwd, d);
  if (d === HOME) return '~';
  if (d.startsWith(HOME + path.sep)) return '~' + path.sep + d.slice(HOME.length + 1);
  return d;
}

function counts(add, del) {
  return add || del ? `+${add} −${del}` : '';
}

const kindText = (k) => ({ edit: L('edit tool'), bash: L('shell command'), shell: L('shell command (guessed)'), commit: L('commit'), cxedit: L('Codex edit') })[k] || k;

// ---------- 모델 → 화면 묶음 ----------

let model = [];
let existsMemo = new Map();

function existsCached(p) {
  if (!existsMemo.has(p)) existsMemo.set(p, fs.existsSync(p));
  return existsMemo.get(p);
}

function rebuild() {
  const o = cfg();
  const out = [];
  existsMemo = new Map();
  const archive = loadArchive();
  for (const s of raw) {
    if (aliveOnly && !s.alive) continue;
    // 직접 보관한 세션만 숨긴다. 오래돼서 보관함에 간 세션은 보는 기간 안에 바꾼 파일이 있으면 계속 보여 준다
    if (archiveReason(s, archive, 0) === 'manual') continue;
    const files = new Map();
    const unresolved = [];
    for (const c of s.changes) {
      if (!c.path) { unresolved.push(c); continue; }
      if (o.hideScratchpadFiles && c.scratch) continue;
      if (!o.showShellGuesses && c.kind === 'shell') continue;
      if (!o.includeSubagents && c.sub) continue;
      let f = files.get(c.path);
      if (!f) {
        f = { path: c.path, changes: [], add: 0, del: 0, kinds: new Set(), lastTs: 0 };
        files.set(c.path, f);
      }
      f.changes.push(c);
      f.kinds.add(c.kind);
      if (c.ts > f.lastTs) f.lastTs = c.ts;
    }
    const list = [...files.values()];
    for (const f of list) {
      f.changes.sort((a, b) => b.ts - a.ts);
      const exact = f.changes.filter((c) => c.kind === 'edit' || c.kind === 'bash' || c.kind === 'cxedit');
      const src = exact.length ? exact : f.changes.filter((c) => c.kind === 'commit');
      for (const c of src) { f.add += c.add || 0; f.del += c.del || 0; }
      const oldest = f.changes[f.changes.length - 1];
      const newest = f.changes[0];
      f.created = !!(oldest && oldest.created);
      // 색은 git 관례대로 "무엇이 바뀌었나"만: A 새 파일(초록) · M 수정(노랑) · D 지금 없음(빨강) · ? 셸 글자 추정(회색, 확실하지 않음)
      f.deleted = !!(newest && newest.deleted) || !existsCached(f.path);
      const sure = f.kinds.has('edit') || f.kinds.has('bash') || f.kinds.has('cxedit') || f.kinds.has('commit');
      f.badge = f.deleted ? 'D' : !sure ? '?' : f.created ? 'A' : 'M';
    }
    list.sort((a, b) => b.lastTs - a.lastTs);
    if (!list.length && !unresolved.length && !s.alive) continue;
    // 같은 파일을 다른 세션도 고쳤으면 표시한다(알리지 않기로 한 파일은 뺀다)
    const ov = new Map((s.overlaps || []).filter((o) => !overlapIgnored(o.path)).map((o) => [o.path, o.with]));
    for (const f of list) f.overlap = ov.get(f.path) || null;
    out.push({ ...s, files: list, unresolved });
  }
  out.sort((a, b) => Number(inWorkspace(b)) - Number(inWorkspace(a)));
  model = out;
  if (treeView) {
    treeView.description = L('Last {0}', spanShort(o.lookbackHours)) + (aliveOnly ? ' · ' + L('open only') : '');
    treeView.message = stillReading ? L('Reading more logs…') : undefined;
  }
  rebuildSessions();
  provider.fire();
  updateExplorerMarks();
  scheduleLiveExpiry();
  checkOverlaps();
}

// ---------- 겹침(같은 파일을 두 세션이 고침) ----------
// "이 파일은 알리지 않기"로 고른 파일은 파일에 적어 같은 컴퓨터의 여러 창이 함께 쓴다.
let overlapIgnoreMemo = { mtimeMs: -1, list: [] };
function overlapIgnoreFile() {
  return ctx ? path.join(ctx.globalStorageUri.fsPath, 'overlap-ignore.json') : '';
}
function loadOverlapIgnore() {
  const f = overlapIgnoreFile();
  if (!f) return [];
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs !== overlapIgnoreMemo.mtimeMs) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      overlapIgnoreMemo = { mtimeMs: st.mtimeMs, list: Array.isArray(data) ? data.map(String) : [] };
    }
  } catch { overlapIgnoreMemo = { mtimeMs: -1, list: [] }; }
  return overlapIgnoreMemo.list;
}
function saveOverlapIgnore(list) {
  const f = overlapIgnoreFile();
  if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(list));
    overlapIgnoreMemo = { mtimeMs: fs.statSync(f).mtimeMs, list };
  } catch (e) {
    vscode.window.showWarningMessage(L('Could not save the list of ignored files: {0}', String((e && e.message) || e)));
  }
}
// 간단한 glob: ** 는 폴더를 넘어, * 는 한 칸 안에서, ? 는 한 글자
const globMemo = new Map();
function globToRe(g) {
  if (!globMemo.has(g)) {
    const src = String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    let re = null;
    try { re = new RegExp('^' + src + '$'); } catch { re = null; }
    globMemo.set(g, re);
  }
  return globMemo.get(g);
}
function overlapIgnored(p) {
  if (loadOverlapIgnore().includes(p)) return true;
  const norm = p.split(path.sep).join('/');
  return cfg().overlapIgnore.some((g) => { const re = globToRe(g); return !!re && (re.test(norm) || re.test(path.basename(p))); });
}

// 새로 생긴 겹침을 한 번 알린다(이 폴더 세션, 방금 고친 것만. 창을 열 때 이미 있던 겹침은 표시만 하고 알리지 않는다)
const overlapSeen = new Set();
let overlapSeeded = false;
function checkOverlaps() {
  const first = !overlapSeeded;
  if (loaded && !stillReading) overlapSeeded = true;
  for (const s of model) {
    for (const f of s.files) {
      for (const o of f.overlap || []) {
        const key = f.path + '|' + [s.sid, o.sid].sort().join('|');
        if (overlapSeen.has(key)) continue;
        overlapSeen.add(key);
        // 둘 중 나중에 고친 쪽이 이 폴더의 세션이고, 방금(2분 안) 고쳤을 때만 알린다
        if (first || !cfg().notifyOverlap || !inWorkspace(s) || f.lastTs < o.ts || Date.now() - f.lastTs > 120000) continue;
        const compare = L('Compare both changes');
        const mute = L("Don't warn for this file");
        Promise.resolve(vscode.window.showWarningMessage(L('"{0}" just changed {1}. "{2}" also changed this file ({3}).', s.title, path.basename(f.path), o.title, fmtAgo(o.ts)), compare, mute)).then((pick) => {
          if (pick === compare) openOverlapCompare(f.path, s.sid, o.sid);
          else if (pick === mute) { saveOverlapIgnore([...new Set([...loadOverlapIgnore(), f.path])]); rebuild(); }
        });
      }
    }
  }
}

// 두 세션이 각각 그 파일에 한 변경을 비교 창 두 개로 연다
async function openOverlapCompare(p, sidA, sidB) {
  for (const sid of [sidB, sidA]) {
    const s = model.find((x) => x.sid === sid);
    const f = s && s.files.find((x) => x.path === p);
    if (f) await openFileDiff({ s, f }, { keep: true, label: s.title });
  }
}

// ---------- 대화 내용으로 세션 찾기 ----------
// 처음에는 대화 기록 전체를 한 번 읽어 "내가 쓴 말"만 모아 둔다. 오래 걸릴 수 있어 화면용 일꾼과 따로 띄운다.
let searchWorker = null;
let searchSeq = 0;
const searchWaiters = new Map();
function ensureSearchWorker() {
  if (!searchWorker) {
    searchWorker = new Worker(path.join(__dirname, 'worker.js'));
    searchWorker.on('message', (m) => {
      const w = searchWaiters.get(m.id);
      if (!w) return;
      if (m.type === 'searchProgress') { if (w.onProgress) w.onProgress(m.done, m.total); return; }
      if (m.type === 'searchResult') { searchWaiters.delete(m.id); w.resolve(m); }
    });
    const fail = (e) => { for (const w of searchWaiters.values()) w.resolve({ results: [], total: 0, error: String((e && e.message) || e || 'stopped') }); searchWaiters.clear(); searchWorker = null; };
    searchWorker.on('error', fail);
    searchWorker.on('exit', () => fail(null));
  }
  return searchWorker;
}

function searchPrompts(query, onProgress) {
  ensureSearchWorker();
  const id = ++searchSeq;
  return new Promise((resolve) => {
    searchWaiters.set(id, { resolve, onProgress });
    searchWorker.postMessage({ type: 'search', id, query, opts: { indexFile: ctx ? path.join(ctx.globalStorageUri.fsPath, 'prompt-index-v1.json') : '' } });
  });
}

function searchConversations(initial) {
  const qp = vscode.window.createQuickPick();
  qp.placeholder = L('Type words you wrote in a session (all of them must match)');
  qp.matchOnDescription = true;
  let seq = 0;
  let timer = null;
  const run = async () => {
    const q = qp.value.trim();
    const mine = ++seq;
    if (!q) { qp.items = []; qp.busy = false; qp.title = undefined; return; }
    qp.busy = true;
    const res = await searchPrompts(q, (done, total) => { if (mine === seq) qp.title = L('Reading conversation logs… {0}/{1}', done, total); });
    if (mine !== seq) return;
    qp.busy = false;
    qp.title = res.error ? res.error : res.total > res.results.length ? L('{0} matches (showing the newest {1})', res.total, res.results.length) : L('{0} matches', res.total);
    qp.items = res.results.map((r) => ({
      label: r.snippet,
      description: [String(r.title).replace(/\s+/g, ' ').slice(0, 40), r.ts ? fmtAgo(r.ts) : '', r.project && !inWorkspace({ cwd: r.cwd }) ? r.project : ''].filter(Boolean).join(' · '),
      alwaysShow: true, // 걸러 내기는 이미 끝났다(보이는 글귀에 낱말이 다 들어 있지 않을 수 있다)
      r,
    }));
  };
  qp.onDidChangeValue(() => { if (timer) clearTimeout(timer); timer = setTimeout(run, 250); });
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0] || qp.activeItems[0];
    if (!it || !it.r) return;
    qp.hide();
    // 지금 읽어 둔 세션이면 그대로, 아니면 찾은 정보로 연다(오래된 세션일 수 있다)
    if (!raw.some((x) => x.sid === it.r.sid)) raw.push({ sid: it.r.sid, title: it.r.title, cwd: it.r.cwd, project: it.r.project, changes: [] });
    openClaudeSession(it.r.sid);
  });
  qp.onDidHide(() => { if (timer) clearTimeout(timer); qp.dispose(); });
  qp.show();
  if (initial) { qp.value = String(initial); run(); }
  return qp;
}

// ---------- 세션 이름 바꾸기 ----------
// Claude Code가 이름을 바꿀 때와 똑같이, 대화 기록 끝에 제목 기록 한 줄({type:"custom-title"})을 덧붙인다.
// 이 확장이 자기 저장소 밖에 쓰는 것은 이것 하나뿐이다. 프로젝트 파일은 건드리지 않는다.
async function renameSession(arg) {
  const sid = sidOf(arg);
  const s = raw.find((x) => x.sid === sid);
  if (!s) return false;
  if (s.agent === 'codex' || sid.startsWith('codex:')) { vscode.window.showInformationMessage(L('Codex sessions cannot be renamed from here.')); return false; }
  const input = await vscode.window.showInputBox({
    prompt: L('New name for this session'),
    value: String(s.title || '').replace(/\s+/g, ' '),
    validateInput: (v) => (!String(v).trim() ? L('The name cannot be empty.') : String(v).length > 200 ? L('The name is too long (200 characters at most).') : undefined),
  });
  const title = String(input || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 200 || title === s.title) return false;
  const file = s.file;
  try {
    if (!file || !UUID_RE.test(sid)) throw new Error('no session log');
    // 기록 끝이 줄 바꿈이 아니면 Claude Code가 한 줄을 쓰는 도중일 수 있다 → 잠깐 기다렸다가 다시 본다(줄 가운데에 끼어들면 기록이 깨진다)
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      const fd = fs.openSync(file, 'r');
      try { const size = fs.fstatSync(fd).size; const b = Buffer.alloc(1); ok = size === 0 || (fs.readSync(fd, b, 0, 1, size - 1) === 1 && b[0] === 10); } finally { fs.closeSync(fd); }
      if (!ok) await new Promise((r) => setTimeout(r, 200));
    }
    if (!ok) throw new Error(L('the session log is being written right now; try again in a moment'));
    fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', sessionId: sid, customTitle: title }) + '\n');
  } catch (e) {
    vscode.window.showWarningMessage(L('Could not rename the session: {0}', String((e && e.message) || e)));
    return false;
  }
  s.title = title; // 다음 읽기 전에도 바로 보이게
  rebuild();
  requestScan(true);
  return true;
}

// ---------- 변경 요약(마크다운) ----------
function relTo(p, base) {
  return base && (p === base || p.startsWith(base + path.sep)) ? path.relative(base, p) : p.startsWith(HOME + path.sep) ? '~' + path.sep + p.slice(HOME.length + 1) : p;
}
function summaryOf(s) {
  const lines = [];
  const add = s.files.reduce((a, f) => a + (f.add || 0), 0);
  const del = s.files.reduce((a, f) => a + (f.del || 0), 0);
  const ts = s.files.flatMap((f) => f.changes.map((c) => c.ts)).filter(Boolean);
  const from = ts.length ? fmtTime(Math.min(...ts)) : '';
  const to = ts.length ? fmtTime(Math.max(...ts)) : '';
  const span = from === to ? from : `${from} ~ ${to}`;
  lines.push(`### ${String(s.title).replace(/\s+/g, ' ')}${s.agent === 'codex' ? ' (Codex)' : ''}`);
  lines.push('');
  lines.push(`- ${[s.files.length === 1 ? L('1 file') : L('{0} files', s.files.length), `+${add} −${del}`, span].filter(Boolean).join(' · ')}`);
  const commits = new Map();
  for (const f of s.files) for (const c of f.changes) if (c.kind === 'commit' && c.sha) { if (!commits.has(c.sha)) commits.set(c.sha, { msg: c.msg || '', n: 0 }); commits.get(c.sha).n++; }
  for (const c of s.unresolved || []) if (c.sha && !commits.has(c.sha)) commits.set(c.sha, { msg: c.msg || '', n: 0 });
  if (commits.size) {
    lines.push(`- ${L('Commits')}:`);
    for (const [sha, c] of commits) lines.push(`  - \`${String(sha).slice(0, 7)}\` ${String(c.msg).split('\n')[0]}`);
  }
  if (s.files.length) {
    lines.push(`- ${L('Files')}:`);
    for (const f of s.files.slice(0, 40)) lines.push(`  - \`${relTo(f.path, s.cwd)}\` ${f.badge}${f.add || f.del ? ` (+${f.add} −${f.del})` : ''}${f.overlap ? ' ⚠ ' + L('also changed by {0}', f.overlap.map((o) => o.title).join(', ')) : ''}`);
    if (s.files.length > 40) lines.push(`  - … ${L('and {0} more', s.files.length - 40)}`);
  }
  return lines.join('\n');
}
function summaryMarkdown(list, heading) {
  return [`## ${heading}`, '', ...list.map((s) => summaryOf(s) + '\n')].join('\n').trimEnd() + '\n';
}
async function copySummary(arg) {
  const sid = sidOf(arg);
  const s = model.find((x) => x.sid === sid);
  if (!s || !s.files.length) { vscode.window.showInformationMessage(L('This session has no changed files in the last {0}.', spanShort(cfg().lookbackHours))); return ''; }
  const md = summaryMarkdown([s], L('Session changes · last {0}', spanShort(cfg().lookbackHours)));
  await vscode.env.clipboard.writeText(md);
  vscode.window.showInformationMessage(L('Copied a summary of {0} file(s) as Markdown.', s.files.length));
  return md;
}
async function copyFolderSummary() {
  const list = model.filter((s) => inWorkspace(s) && s.files.length);
  if (!list.length) { vscode.window.showInformationMessage(L('No files changed in the last {0}', spanShort(cfg().lookbackHours))); return ''; }
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const md = summaryMarkdown(list, [L('Session changes · last {0}', spanShort(cfg().lookbackHours)), folder ? path.basename(folder.uri.fsPath) : ''].filter(Boolean).join(' · '));
  await vscode.env.clipboard.writeText(md);
  vscode.window.showInformationMessage(L('Copied a summary of {0} session(s) as Markdown.', list.length));
  return md;
}

// ---------- 파일에서 거꾸로: 이 파일을 고친 세션 ----------
async function sessionsForFile(uri) {
  const ed = vscode.window.activeTextEditor;
  const p = uri && uri.fsPath ? uri.fsPath : ed && ed.document && ed.document.uri ? ed.document.uri.fsPath : '';
  if (!p) return undefined;
  const hits = [];
  for (const s of model) { const f = s.files.find((x) => x.path === p); if (f) hits.push({ s, f }); }
  if (!hits.length) return vscode.window.showInformationMessage(L('No session changed {0} in the last {1}.', path.basename(p), spanShort(cfg().lookbackHours)));
  hits.sort((a, b) => b.f.lastTs - a.f.lastTs);
  const items = hits.map((h) => ({
    label: String(h.s.title).replace(/\s+/g, ' '),
    description: [h.s.agent === 'codex' ? 'Codex' : '', counts(h.f.add, h.f.del), fmtAgo(h.f.lastTs), [...h.f.kinds].map((k) => kindText(k)).join(', ')].filter(Boolean).join(' · '),
    h,
  }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: L('Sessions that changed {0} (last {1}). Pick one to see its change.', path.basename(p), spanShort(cfg().lookbackHours)) });
  if (pick) await openFileDiff(pick.h);
  return hits.length;
}

// 이 폴더 세션과 다른 폴더 묶음(진행 중 묶음 먼저, 최근 활동 순)
function splitByFolder(list) {
  const mine = list.filter(inWorkspace);
  const groups = new Map();
  for (const s of list) {
    if (inWorkspace(s)) continue;
    const key = folderKey(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const recent = (items) => Math.max(...items.map((s) => s.lastActivity || 0));
  const alive = (items) => items.some((s) => s.alive);
  const sorted = [...groups.entries()].sort((a, b) => Number(alive(b[1])) - Number(alive(a[1])) || recent(b[1]) - recent(a[1]));
  return { mine, groups: sorted };
}

// ---------- 보관함 ----------
// Claude Code 세션 목록처럼 "목록"과 "보관함" 두 칸으로 나눈다.
// - 자동: Claude Code 설정(claudeCode.archiveInactiveSessions, 기본 14일)만큼 대화가 없던 세션은 보관함에 보인다.
// - 직접: 보관 단추로 넣은 세션. 보관한 뒤 새 대화가 생기면 저절로 목록으로 돌아온다.
// Claude Code에서 직접 보관하거나 꺼낸 목록은 다른 확장이 읽을 수 없어 그 부분만은 맞출 수 없다.
// 파일에 두어 같은 컴퓨터의 여러 VS Code 창이 함께 쓴다: { archived: {세션: 보관한 시각}, restored: {세션: 꺼낸 시각} }

const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_ARCHIVE = { archived: {}, restored: {} };
let archiveMemo = { mtimeMs: -1, map: EMPTY_ARCHIVE };

// 대화가 없던 세션을 보관함으로 보내는 날 수(0 = 안 함).
// 기본은 Claude Code 설정(Archive Inactive Sessions)을 따르고, 이 확장 설정 archiveAfter로 따로 정할 수 있다
// (Claude Code에서 세션을 직접 보관하는 사람은 그 목록을 읽을 수 없으니 날 수를 짧게 잡아 비슷하게 맞춘다).
const ARCHIVE_CHOICES = ['claude', '1', '2', '3', '7', '14', '30', 'never'];
function followsClaudeArchive() {
  const own = cfg().archiveAfter;
  return own !== 'never' && !(Number(own) > 0);
}
function autoArchiveDays() {
  const own = cfg().archiveAfter;
  if (own === 'never') return 0;
  if (Number(own) > 0) return Number(own);
  const v = Number(vscode.workspace.getConfiguration('claudeCode').get('archiveInactiveSessions', 14));
  return Number.isFinite(v) && v >= 0 ? v : 14;
}

// 다른 폴더 세션을 며칠 전 것까지 보여 줄지: 그 폴더 창의 목록에 남아 있을 만큼 최근 것만(보관함으로 갈 만큼 오래된 것은 그 폴더 창에서 본다)
function otherListDays() {
  const list = cfg().sessionListDays;
  if (list <= 0) return 0;
  const days = autoArchiveDays();
  return Math.min(list, 14, days > 0 ? days : 14);
}

async function pickArchiveAfter() {
  const cur = ARCHIVE_CHOICES.includes(cfg().archiveAfter) ? cfg().archiveAfter : 'claude';
  const label = (v) => (v === 'claude' ? L('Same as Claude Code ("Archive Inactive Sessions")') : v === 'never' ? L('Never (only what I archive myself)') : v === '1' ? L('1 day') : L('{0} days', v));
  const items = ARCHIVE_CHOICES.map((v) => ({ label: label(v), description: v === cur ? L('current') : '', v }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: L('Move a session to Archived after how long without conversation?') });
  if (!pick) return;
  await vscode.workspace.getConfiguration(CFG).update('archiveAfter', pick.v, vscode.ConfigurationTarget.Global);
}

function normalizeArchive(data) {
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const d = obj(data);
  return { archived: { ...obj(d.archived) }, restored: { ...obj(d.restored) } };
}

function archiveFile() {
  return ctx ? path.join(ctx.globalStorageUri.fsPath, 'archived-sessions.json') : '';
}

function loadArchive() {
  const f = archiveFile();
  if (!f) return EMPTY_ARCHIVE;
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs !== archiveMemo.mtimeMs) {
      archiveMemo = { mtimeMs: st.mtimeMs, map: normalizeArchive(JSON.parse(fs.readFileSync(f, 'utf8'))) };
    }
  } catch {
    archiveMemo = { mtimeMs: -1, map: EMPTY_ARCHIVE };
  }
  return archiveMemo.map;
}

function saveArchive(map) {
  const f = archiveFile();
  if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, f);
    archiveMemo = { mtimeMs: fs.statSync(f).mtimeMs, map };
  } catch (e) {
    vscode.window.showWarningMessage(L('Could not save the archive: {0}', String((e && e.message) || e)));
  }
}

// 보관함에 보일 까닭: 'manual'(직접 보관) · 'auto'(오래 대화가 없음) · ''(목록에 보임)
// 지금 일하거나 기다리는 세션은 숨기지 않는다. 열려 있는 세션은 오래됐어도 자동으로 보관하지 않는다(Claude Code와 같음).
function archiveReason(s, store, days) {
  if (s.alive && (s.status === 'busy' || s.status === 'waiting')) return '';
  const at = store.archived[s.sid];
  if (at && !(s.lastActivity > at + 5000)) return 'manual';
  if (s.alive || !(days > 0)) return '';
  const last = Math.max(s.lastActivity || 0, store.restored[s.sid] || 0);
  return last && Date.now() - last > days * DAY_MS ? 'auto' : '';
}

function setArchived(arg, on) {
  const sid = sidOf(arg);
  if (!sid) return;
  const store = normalizeArchive(loadArchive());
  if (on) { store.archived[sid] = Date.now(); delete store.restored[sid]; }
  else { delete store.archived[sid]; store.restored[sid] = Date.now(); } // 꺼낸 시각부터 다시 날 수를 센다
  saveArchive(store);
  rebuild();
}

// ---------- 세션 그룹 ----------
// 사용자가 세션을 묶는 그룹(예: "챗봇 운영" = 감시·배포·개발 세션). 세션 하나는 그룹 하나에만 들어간다.
// 그룹마다 역할 꼬리표와 공유 메모 파일(협업보드 같은 마크다운)을 붙이고, 보드 화면에서 한꺼번에 본다.
// 파일에 두어 같은 컴퓨터의 여러 VS Code 창이 함께 쓴다(보관함과 같은 방식):
// { groups: [{ id, name, memo: 메모 파일 절대 경로 또는 '', members: { 세션: { role, at } }, at }] }

const EMPTY_GROUPS = { groups: [] };
const teamRolesCache = new Map(); // 그룹 → 세션별 실제 역할(세션 창을 그리는 동안만 씀)
const ROLE_MAX = 40; // 역할 여러 개(예: "개발, 시험, 검토")가 들어갈 만큼
let groupsMemo = { mtimeMs: -1, data: EMPTY_GROUPS };

function groupsFile() {
  return ctx ? path.join(ctx.globalStorageUri.fsPath, 'session-groups.json') : '';
}

function normalizeGroups(data) {
  const list = data && Array.isArray(data.groups) ? data.groups : [];
  const seen = new Set();
  const groups = [];
  for (const g of list) {
    if (!g || typeof g.id !== 'string' || !g.id || typeof g.name !== 'string') continue;
    const members = {};
    const m = g.members && typeof g.members === 'object' && !Array.isArray(g.members) ? g.members : {};
    for (const [sid, v] of Object.entries(m)) {
      if (seen.has(sid)) continue; // 세션 하나는 그룹 하나에만
      seen.add(sid);
      members[sid] = { role: v && typeof v.role === 'string' ? v.role.slice(0, ROLE_MAX) : '', at: v && Number(v.at) > 0 ? Number(v.at) : 0 };
    }
    groups.push({ id: g.id, name: g.name.slice(0, 60), memo: typeof g.memo === 'string' ? g.memo : '', lead: typeof g.lead === 'string' && (members[g.lead] || g.lead === '__none__') ? g.lead : '', members, at: Number(g.at) > 0 ? Number(g.at) : 0 });
  }
  return { groups };
}

function loadGroups() {
  const f = groupsFile();
  if (!f) return EMPTY_GROUPS;
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs !== groupsMemo.mtimeMs) groupsMemo = { mtimeMs: st.mtimeMs, data: normalizeGroups(JSON.parse(fs.readFileSync(f, 'utf8'))) };
  } catch {
    groupsMemo = { mtimeMs: -1, data: EMPTY_GROUPS };
  }
  return groupsMemo.data;
}

// 다른 창이 그룹을 바꿨는지(확인 주기마다 본다). 세션 창이 마지막으로 그린 판과 비교한다:
// 보드 같은 다른 곳이 먼저 새 파일을 읽어도 세션 창은 다시 그려야 한다
let groupsRendered = -1;
function groupsChangedOnDisk() {
  const f = groupsFile();
  if (!f) return false;
  let m = -1;
  try { m = fs.statSync(f).mtimeMs; } catch { m = -1; }
  return m !== groupsRendered;
}

function saveGroups(data) {
  const f = groupsFile();
  if (!f) return false;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, f);
    groupsMemo = { mtimeMs: fs.statSync(f).mtimeMs, data };
    return true;
  } catch (e) {
    vscode.window.showWarningMessage(L('Could not save the groups: {0}', String((e && e.message) || e)));
    return false;
  }
}

// 바꿀 때는 늘 파일에서 새로 읽은 뒤 고친다(다른 창이 방금 바꾼 것을 덮지 않게)
function updateGroups(fn) {
  const data = normalizeGroups(JSON.parse(JSON.stringify(loadGroups())));
  const res = fn(data);
  if (res === false) return false;
  const ok = saveGroups(normalizeGroups(data));
  if (ok) rebuildSessions();
  return ok;
}

function groupById(id) {
  return loadGroups().groups.find((g) => g.id === id) || null;
}

function groupOfSession(sid) {
  return loadGroups().groups.find((g) => g.members[sid]) || null;
}

function sessionBySid(sid) {
  return raw.find((s) => s.sid === sid) || null;
}

async function askGroupName(value) {
  const name = await vscode.window.showInputBox({ prompt: L('Group name'), placeHolder: L('For example: Chatbot operations'), value: value || '', validateInput: (v) => (String(v || '').trim() ? undefined : L('Enter a name')) });
  return name && name.trim() ? name.trim().slice(0, 60) : null;
}

async function createGroup() {
  const name = await askGroupName('');
  if (!name) return null;
  const g = { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, memo: '', members: {}, at: Date.now() };
  updateGroups((d) => { d.groups.push(g); });
  return g.id;
}

// 그룹 고르기(새 그룹 만들기 포함). 돌려주는 값은 그룹 id
async function pickGroup(placeHolder, exceptId) {
  const groups = loadGroups().groups.filter((g) => g.id !== exceptId);
  const NEW = '__new';
  const items = groups.map((g) => ({ label: g.name, description: L('{0} session(s)', Object.keys(g.members).length), id: g.id }));
  items.push({ label: '$(add) ' + L('New group…'), id: NEW });
  const pick = await vscode.window.showQuickPick(items, { placeHolder });
  if (!pick) return null;
  return pick.id === NEW ? createGroup() : pick.id;
}

async function addToGroup(arg, groupId) {
  const sid = sidOf(arg);
  if (!sid) return;
  const cur = groupOfSession(sid);
  const s = sessionBySid(sid);
  const id = groupId || (await pickGroup(L('Put "{0}" in which group?', s ? s.title : sid.slice(0, 8)), cur ? cur.id : ''));
  if (!id) return;
  updateGroups((d) => {
    const target = d.groups.find((g) => g.id === id);
    if (!target) return false;
    let role = '';
    for (const g of d.groups) if (g.members[sid]) { role = g.members[sid].role; delete g.members[sid]; }
    target.members[sid] = { role, at: Date.now() };
  });
}

function removeFromGroup(arg) {
  const sid = sidOf(arg);
  if (!sid) return;
  updateGroups((d) => {
    let hit = false;
    for (const g of d.groups) if (g.members[sid]) { delete g.members[sid]; hit = true; }
    return hit ? undefined : false;
  });
}

// ---------- 보드가 정한 역할(유동 역할) ----------
// 대장·배포는 고정이고, 나머지 역할은 대장이 할 일마다 정해 협업 보드의 "세션과 역할" 표를 고친다.
// 그래서 그룹에 메모(보드) 파일이 연결돼 있으면 그 표에서 세션별 역할을 읽어 꼬리표로 보여 준다(보드가 손으로 정한 역할보다 앞선다).
// 표는 이 확장이 만드는 틀("세션과 역할" / "Sessions and roles") 또는 같은 칸 이름(역할·세션 이름)을 쓴 표면 읽는다.
function parseBoardRoles(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{1,6}\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:세션과\s*(?:역할|맡은\s*범위)|sessions?\s+and\s+roles?)/i.test(l.trim()));
  if (at < 0) return [];
  let j = at + 1;
  while (j < lines.length && !/^\s*\|/.test(lines[j])) { if (/^#{1,6}\s/.test(lines[j].trim())) return []; j++; }
  if (j >= lines.length) return [];
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const plain = (t) => String(t || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  const head = cells(lines[j]).map((h) => plain(h).toLowerCase());
  const ri = head.findIndex((h) => /^(역할|role)\b/.test(h) || h === '역할');
  const si = head.findIndex((h) => /세션\s*이름|session\s*name/.test(h) || h === '세션' || h === 'session');
  if (ri < 0 || si < 0) return [];
  const out = [];
  for (let k = j + 1; k < lines.length && /^\s*\|/.test(lines[k]); k++) {
    const c = cells(lines[k]);
    if (c.every((x) => !x || /^:?-{2,}:?$/.test(x))) continue; // 구분 줄
    const role = plain(c[ri]).slice(0, ROLE_MAX);
    const cell = c[si] || '';
    if (!role || !cell || /^<.*>$/.test(plain(cell))) continue; // 틀의 빈 칸(<세션 이름>)
    out.push({ role, cell: plain(cell), bold: (cell.match(/\*\*([^*]+)\*\*/g) || []).map((b) => plain(b)) });
  }
  return out;
}

const boardRoleMemo = new Map(); // 파일 → { mtimeMs, rows }
function boardRowsOf(file) {
  if (!file) return [];
  let st;
  try { st = fs.statSync(file); } catch { boardRoleMemo.delete(file); return []; }
  const hit = boardRoleMemo.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.rows;
  let rows = [];
  try { if (st.size < 2 * 1024 * 1024) rows = parseBoardRoles(fs.readFileSync(file, 'utf8')); } catch { rows = []; }
  boardRoleMemo.set(file, { mtimeMs: st.mtimeMs, rows });
  return rows;
}

// 연결된 보드 파일이 바뀌었는지(확인 주기마다 본다): 대장이 역할을 고치면 보드 화면을 열지 않아도 세션 창 꼬리표가 바뀌게.
// 세션 창이 마지막으로 그릴 때 본 판과 비교한다: 보드 화면이 먼저 새 파일을 읽어도 세션 창은 다시 그려야 한다(그룹 파일과 같은 이유)
const boardsRendered = new Map(); // 파일 → 세션 창이 그릴 때 본 수정 시각
function memoMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return -1; }
}
function boardFilesChanged() {
  for (const g of loadGroups().groups) {
    if (!g.memo) continue;
    if (memoMtime(g.memo) !== (boardsRendered.has(g.memo) ? boardsRendered.get(g.memo) : -2)) return true;
  }
  return false;
}

// 대장은 그룹에 하나뿐인 고정 지위라 보드 표에 덮이지 않는다. 정해 두지 않았으면 손으로 "대장"을 붙인 세션을 대장으로 본다
// 역할 하나하나가 정확히 대장 이름일 때만 대장으로 본다("QA lead" 같은 직접 만든 역할은 대장이 아니다)
const LEAD_RE = /^(lead|leader|대장|총괄|리더)$/i;
function leadOf(g) {
  if (g.lead === '__none__') return '';
  if (g.lead && g.members[g.lead]) return g.lead;
  return Object.keys(g.members).find((sid) => splitRoles(g.members[sid].role).some((r) => LEAD_RE.test(r))) || '';
}
const withoutLead = (role) => splitRoles(String(role || '').replace(/·/g, ',')).filter((r) => !LEAD_RE.test(r)).join('·');

// 보드 표의 줄과 세션 제목 짝짓기: 굵은 글씨 제목이 같은 줄 → 세션 이름 칸 전체가 같은 줄 → 세션 이름 칸에 제목이 들어 있는 줄
const normTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function rowForTitle(rows, title) {
  const t = normTitle(title);
  if (t.length < 2) return null;
  return rows.find((r) => r.bold.includes(t)) || rows.find((r) => r.cell === t) || rows.find((r) => r.cell.includes(t)) || null;
}

// 그룹 세션별 실제 역할: 보드 표에 그 세션 이름이 있으면 보드의 역할, 없으면 손으로 정한 역할.
// 대장은 따로 표시한다(lead: true). extra는 대장이 함께 맡은 다른 일(보드나 손으로 정한 역할에서 대장을 뺀 것)
function effectiveRoles(g) {
  const out = new Map();
  const rows = boardRowsOf(g.memo);
  const lead = leadOf(g);
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  for (const sid of Object.keys(g.members)) {
    const s = sessionBySid(sid);
    const t = norm(s && s.title);
    let row = null;
    row = rowForTitle(rows, t);
    const base = row ? { role: row.role, source: 'board' } : { role: g.members[sid].role || '', source: 'manual' };
    if (sid === lead) {
      const extra = withoutLead(base.role);
      const leadName = isKo() ? '대장' : 'Lead';
      out.set(sid, { role: extra ? `${leadName}, ${extra}` : leadName, source: base.source, lead: true, extra, extraSource: base.source });
    } else out.set(sid, { ...base, lead: false, extra: base.role, extraSource: base.source });
  }
  return out;
}

// 보드 표와 그룹을 맞춰 본다. 그룹이 팀의 원본이라 확장은 보드 파일을 고치지 않는다:
// 보드에만 있는 세션은 그룹에 넣을 수 있게, 그룹에만 있는 세션은 대장에게 보드에 넣어 달라고 할 글을 만든다
function boardGroupSync(g) {
  const rows = boardRowsOf(g.memo);
  if (!g.memo || !rows.length) return null;
  const memberRows = new Set();
  const groupOnly = [];
  for (const sid of Object.keys(g.members)) {
    const s = sessionBySid(sid);
    const row = rowForTitle(rows, s && s.title);
    if (row) memberRows.add(row);
    else groupOnly.push({ sid, title: s ? s.title : sid.slice(0, 8), role: g.members[sid].role || '' });
  }
  const known = [...sessionsModel, ...archivedModel];
  const boardOnly = [];
  for (const r of rows) {
    if (memberRows.has(r)) continue;
    const name = r.bold[0] || r.cell;
    // 그 줄의 세션을 이 컴퓨터의 세션 목록에서 찾는다(다른 그룹에 든 세션이면 알려 준다)
    const s = known.find((x) => rowForTitle([r], x.title) === r);
    const other = s ? groupOfSession(s.sid) : null;
    boardOnly.push({ name, role: r.role, sid: s ? s.sid : '', inGroup: other && other.id !== g.id ? other.name : '' });
  }
  return boardOnly.length || groupOnly.length ? { boardOnly, groupOnly } : null;
}

function boardSyncText(g, sync) {
  const ko = isKo();
  const out = [];
  if (ko) {
    out.push(`[보드 맞추기] Session Watchtower의 "${g.name}" 그룹과 협업 보드 1절 "세션과 역할" 표가 다릅니다.`);
    if (sync.groupOnly.length) out.push('', '그룹에는 있는데 보드 표에 없는 세션입니다. 표에 줄을 더해 주세요(세션 이름은 아래 제목 그대로 굵게):', ...sync.groupOnly.map((x) => `- **${x.title}**${x.role ? ` — ${x.role}` : ''}`));
    if (sync.boardOnly.length) out.push('', '보드 표에는 있는데 그룹에 없는 세션입니다. 이 팀에서 빠졌으면 표에서 빼거나 "그룹 밖"으로 표시해 주세요:', ...sync.boardOnly.map((x) => `- ${x.name} — ${x.role}`));
  } else {
    out.push(`[Board sync] The group "${g.name}" in Session Watchtower and the "Sessions and roles" table of the team board differ.`);
    if (sync.groupOnly.length) out.push('', 'In the group but not in the table. Please add a row for each (session name in bold, exactly as below):', ...sync.groupOnly.map((x) => `- **${x.title}**${x.role ? ` — ${x.role}` : ''}`));
    if (sync.boardOnly.length) out.push('', 'In the table but not in the group. If they left this team, remove them or mark them "outside the group":', ...sync.boardOnly.map((x) => `- ${x.name} — ${x.role}`));
  }
  return out.join('\n') + '\n';
}

// 고정 역할(대장·배포)이 둘 이상이면 알린다: 배포가 둘이면 두 세션이 각자 서버에 올리는 사고가 날 수 있다
function roleWarnings(g, eff) {
  const name = (sid) => { const s = sessionBySid(sid); return s ? s.title : sid.slice(0, 8); };
  const out = [];
  const items = (role) => splitRoles(String(role || '').replace(/·/g, ','));
  for (const [key, test] of [['deploy', (role) => /deploy|release|배포|승격|릴리스/i.test(role)], ['lead', (role) => items(role).some((r) => LEAD_RE.test(r))]]) {
    const who = [...eff.entries()].filter(([, v]) => test(v.role)).map(([sid]) => name(sid));
    if (who.length > 1) out.push(key === 'deploy' ? L('More than one session has the deploy role: {0}. Only one session should deploy.', who.join(', ')) : L('More than one session has the lead role: {0}. A team should have one lead.', who.join(', ')));
  }
  return out;
}

// 역할 고르기: 개발 프로젝트에 흔히 필요한 역할 목록에서 하나 이상 고르거나, 직접 쳐서 넣는다(여러 개면 "개발, 시험"처럼 쉼표로)
function splitRoles(role) {
  return String(role || '').split(/[,،、/]+/).map((x) => x.trim()).filter(Boolean);
}

function roleDuty(name) {
  const d = ROLE_DUTIES.find((x) => x.re.test(name));
  return d ? (isKo() ? d.ko : d.en) : '';
}

function setSessionRole(arg) {
  const sid = sidOf(arg);
  const g = sid && groupOfSession(sid);
  if (!g) { vscode.window.showInformationMessage(L('Put the session in a group first. Roles belong to a group.')); return Promise.resolve(); }
  const s = sessionBySid(sid);
  const ko = isKo();
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const current = splitRoles(g.members[sid].role);
  const presets = ROLE_PRESETS.map((p) => (ko ? p.ko : p.en));
  let items = presets.map((n) => ({ label: n, detail: roleDuty(n) }));
  for (const r of current) if (!items.some((i) => same(i.label, r))) items.push({ label: r, description: L('Custom role') });
  const qp = vscode.window.createQuickPick();
  qp.canSelectMany = true;
  qp.matchOnDetail = true;
  qp.title = L('Role of "{0}" in {1}', s ? s.title : sid.slice(0, 8), g.name);
  const fromBoard = effectiveRoles(g).get(sid);
  if (fromBoard && fromBoard.source === 'board') qp.title += ' · ' + L('the team board says "{0}" and wins over this', fromBoard.role);
  qp.placeholder = L('Check roles, or type your own (none checked = no role)');
  qp.items = items;
  qp.selectedItems = items.filter((i) => current.some((r) => same(r, i.label)));
  // 친 글자가 목록에 없으면 "직접 넣기" 줄을 맨 위에 보여 준다. 고른 것은 다음 글자를 쳐도 남는다
  qp.onDidChangeValue((v) => {
    const t = v.trim().slice(0, 24);
    const keep = qp.selectedItems.map((i) => i.label);
    const typed = t && !items.some((i) => same(i.label, t)) ? [{ label: t, description: L('Your own role: check it to use it'), alwaysShow: true, custom: true }] : [];
    qp.items = [...typed, ...items];
    qp.selectedItems = qp.items.filter((i) => keep.some((k) => same(k, i.label)));
  });
  if (qp.onDidChangeSelection) {
    qp.onDidChangeSelection((sel) => {
      for (const i of sel || []) if (i.custom && !items.some((x) => same(x.label, i.label))) items.push({ label: i.label, description: L('Custom role') });
    });
  }
  return new Promise((resolve) => {
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      let picked = qp.selectedItems.map((i) => i.label);
      const t = qp.value.trim().slice(0, 24);
      if (!picked.length && t) picked = [t]; // 아무것도 고르지 않고 글자만 친 채 Enter: 친 글자를 역할로
      // 늘 같은 순서로(목록 순서, 직접 넣은 역할은 그 뒤): 고른 순서에 따라 "감시, 문서"와 "문서, 감시"가 갈리지 않게
      const rank = (r) => { const i = presets.findIndex((n) => same(n, r)); return i < 0 ? presets.length : i; };
      const role = [...new Set(picked)].map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]).join(', ').slice(0, ROLE_MAX);
      qp.hide();
      updateGroups((d) => {
        const x = d.groups.find((y) => y.members[sid]);
        if (!x) return false;
        x.members[sid].role = role;
        // 대장은 하나: 고르면 그 세션이 대장이 되고 다른 세션의 손으로 적은 "대장"은 지운다. 빼면 대장 자리를 비운다
        if (splitRoles(role).some((r) => LEAD_RE.test(r))) { // 항목 하나가 정확히 대장일 때
          x.lead = sid;
          for (const o of Object.keys(x.members)) if (o !== sid) x.members[o].role = splitRoles(x.members[o].role).filter((r) => !LEAD_RE.test(r)).join(', ');
        } else if (leadOf(x) === sid) x.lead = '__none__';
      });
      resolve(role);
    });
    qp.onDidHide(() => { qp.dispose(); if (!done) resolve(undefined); });
    qp.show();
  });
}

async function renameGroup(id) {
  const g = id ? groupById(id) : groupById(await pickGroup(L('Rename which group?')));
  if (!g) return;
  const name = await askGroupName(g.name);
  if (!name) return;
  updateGroups((d) => { const t = d.groups.find((x) => x.id === g.id); if (!t) return false; t.name = name; });
  refreshBoard(g.id);
}

async function deleteGroup(id) {
  const g = id ? groupById(id) : groupById(await pickGroup(L('Delete which group?')));
  if (!g) return;
  const yes = L('Delete group');
  const pick = await vscode.window.showWarningMessage(L('Delete the group "{0}"? The sessions stay as they are; only the grouping, roles and the link to the memo file are removed.', g.name), { modal: true }, yes);
  if (pick !== yes) return;
  updateGroups((d) => { d.groups = d.groups.filter((x) => x.id !== g.id); });
  const b = boards.get(g.id);
  if (b) b.panel.dispose();
}

// ---------- 역할 안내 ----------
// 역할 꼬리표는 사람이 보는 이름표라 세션은 모른다. 세션이 역할대로 일하게 하려면 그 세션에 직접 알려야 한다.
// 그래서 세션마다 붙여 넣을 안내 글을 만든다: 그룹·역할·하는 일·동료·공유 메모·함께 일하는 규칙.
// 처음 쓰는 사람(협업 규칙이 따로 없는 프로젝트)도 이 글만 붙여 넣으면 되게 규칙까지 넣는다. 화면 언어(한국어·영어)를 따른다.
// 개발 프로젝트에 흔히 필요한 역할(고르기 창의 목록). 하는 일은 아래 ROLE_DUTIES에서 이름으로 찾는다
const ROLE_PRESETS = [
  { en: 'Lead', ko: '대장' }, { en: 'Watch', ko: '감시' }, { en: 'Plan', ko: '기획' }, { en: 'Design', ko: '설계' }, { en: 'Develop', ko: '개발' }, { en: 'Test', ko: '시험' },
  { en: 'Review', ko: '검토' }, { en: 'Docs', ko: '문서' }, { en: 'Deploy', ko: '배포' }, { en: 'Security', ko: '보안' }, { en: 'Research', ko: '조사' },
];
const ROLE_DUTIES = [
  { re: /\blead(er)?\b|coordinat|대장|총괄|리더/i, en: 'Set up the team and keep the team board. Collect the reports of the working sessions, summarise them for the user, take the user\'s decisions and give the next instructions. Do not change code yourself unless that is part of your job.', ko: '팀을 꾸리고 협업 보드를 관리합니다. 작업 세션의 보고를 모아 사용자에게 요약하고, 사용자 결정을 받아 다음 지시를 내립니다. 맡은 일이 아니면 직접 코드를 고치지 않습니다.' },
  { re: /watch|monitor|감시|관제/i, en: 'Watch the other sessions, collect what needs the user\'s decision and ask the user. Do not change code or servers yourself.', ko: '다른 세션의 진행을 지켜보고, 사용자 결정이 필요한 것을 모아 사용자에게 묻습니다. 코드나 서버는 직접 고치지 않습니다.' },
  { re: /plan|기획|요구|요건/i, en: 'Turn the request into clear tasks, split the work and set the order. Do not change code.', ko: '요청을 분명한 할 일로 정리하고, 일을 쪼개고, 순서를 정합니다. 코드는 고치지 않습니다.' },
  { re: /design|architect|설계|구조/i, en: 'Decide the structure and the interfaces before code is written, and write them down.', ko: '코드를 짜기 전에 구조와 연결 방식(인터페이스)을 정하고 문서로 남깁니다.' },
  { re: /dev|code|build|개발|구현|코드/i, en: 'Change the code for your part and run the tests. Do not deploy.', ko: '맡은 부분의 코드를 고치고 시험을 돌립니다. 배포는 하지 않습니다.' },
  { re: /deploy|release|ops|배포|운영|승격/i, en: 'Build releases and put them on the servers. Before a release, check whose commits it contains; put it on production only after the user approves.', ko: '판을 만들고 서버에 올립니다. 판을 만들기 전에 들어가는 커밋이 누구 것인지 확인하고, 실서버에는 사용자가 승인한 뒤에만 올립니다.' },
  { re: /doc|문서|기록/i, en: 'Keep the documents and the change log up to date.', ko: '문서와 변경 기록을 최신으로 유지합니다.' },
  { re: /test|qa|verif|시험|테스트|검증/i, en: 'Test what changed and report the results in a table. Do not fix code; report the problems.', ko: '바뀐 기능을 시험하고 결과를 표로 남깁니다. 코드는 고치지 않고 문제만 알립니다.' },
  { re: /review|리뷰|검토/i, en: 'Read the other sessions\' changes and report problems.', ko: '다른 세션의 변경을 읽고 문제를 찾아 알립니다.' },
  { re: /secur|보안/i, en: 'Check secrets, permissions and vulnerable dependencies, and report the risks before a release.', ko: '비밀 정보·권한·취약한 의존 패키지를 점검하고, 배포 전에 위험을 알립니다.' },
  { re: /research|조사|탐색/i, en: 'Look up documents, libraries and facts, and report them with their sources. Do not change code.', ko: '문서·라이브러리·사실을 찾아 출처와 함께 알립니다. 코드는 고치지 않습니다.' },
];

function roleBrief(groupId, sid) {
  const g = groupById(groupId);
  if (!g || !g.members[sid]) return '';
  const ko = isKo();
  const name = (x) => { const s = sessionBySid(x); return s ? s.title : x.slice(0, 8); };
  const effAll = effectiveRoles(g);
  const role = effAll.get(sid).role;
  const isLead = effAll.get(sid).lead;
  const duties = role ? ROLE_DUTIES.filter((d) => d.re.test(role)).map((d) => (ko ? d.ko : d.en)) : [];
  const isCx = (x) => { const s = sessionBySid(x); return !!(s && s.agent === 'codex') || String(x).startsWith('codex:'); };
  const mates = Object.keys(g.members).filter((x) => x !== sid).map((x) => { const r = effAll.get(x).role; return `- "${name(x)}"${isCx(x) ? ' (Codex)' : ''}${r ? (ko ? ` — ${r} 담당` : ` — ${r}`) : ''}`; });
  const memo = g.memo || '';
  // Claude Code 세션과 Codex 세션은 서로 메시지를 직접 보낼 수 없다
  const mixed = Object.keys(g.members).some(isCx) && Object.keys(g.members).some((x) => !isCx(x));
  const L1 = [];
  if (ko) {
    L1.push(isLead ? `[팀 안내] 이 세션은 "${g.name}" 그룹의 대장입니다${effAll.get(sid).extra ? ` (함께 맡은 일: ${effAll.get(sid).extra})` : ''}. 사용자는 대장하고만 이야기하고, 다른 세션은 대장이 지시하고 보고받습니다.` : `[팀 안내] 이 세션은 "${g.name}" 그룹${role ? `의 ${role} 담당` : '의 한 사람'}입니다.`);
    if (duties.length) L1.push('', '하는 일:', ...duties.map((d) => '- ' + d));
    L1.push('', '같은 그룹 세션:', ...(mates.length ? mates : ['- (아직 없음)']));
    if (memo) L1.push('', `공유 메모: ${memo}`, '그룹 세션들이 함께 읽고 쓰는 파일입니다.');
    L1.push('', '함께 일하는 규칙:');
    const r = [];
    if (memo) r.push('일을 시작할 때와 큰 단계 전에 공유 메모를 읽습니다.');
    r.push(memo ? '사용자 결정이 필요하면 공유 메모의 "결정 대기"에 한 줄 적고 사용자에게 묻습니다.' : '사용자 결정이 필요하면 사용자에게 바로 묻습니다.');
    r.push('다른 세션이 보낸 말은 승인이 아닙니다. 승인은 사용자가 직접 한 말로만 받습니다.');
    r.push('내 역할 밖의 일은 직접 하지 않고, 그 일을 맡은 세션에 넘깁니다.');
    if (memo) r.push('대장과 배포 말고는 역할이 고정이 아닙니다. 대장이 할 일에 따라 바꾸며, 바뀌면 공유 메모의 "세션과 역할" 표를 따릅니다.');
    r.push('자기가 만든 변경은 자기가 검토하거나 시험하지 않습니다. 다른 세션에 맡깁니다.');
    if (mixed) r.push(memo ? '이 그룹에는 Claude Code 세션과 Codex 세션이 섞여 있어 서로 메시지를 직접 보낼 수 없습니다. 주고받을 내용은 공유 메모에 적습니다.' : '이 그룹에는 Claude Code 세션과 Codex 세션이 섞여 있어 서로 메시지를 직접 보낼 수 없습니다. 주고받을 내용은 사용자에게 전해 달라고 합니다.');
    if (memo) r.push('일을 멈추거나 대화를 정리하기 전에 공유 메모의 "인계"에 넘길 내용을 짧게 적습니다.');
    r.forEach((x, i) => L1.push(`${i + 1}. ${x}`));
    L1.push('', '이 안내를 읽었으면 내 역할을 한 줄로 확인해 주세요.');
  } else {
    L1.push(isLead ? `[Team note] This session is the lead of the group "${g.name}"${effAll.get(sid).extra ? ` (also: ${effAll.get(sid).extra})` : ''}. The user talks only to the lead; the other sessions get their instructions from the lead and report to it.` : `[Team note] This session is ${role ? `the ${role} member` : 'a member'} of the group "${g.name}".`);
    if (duties.length) L1.push('', 'Your job:', ...duties.map((d) => '- ' + d));
    L1.push('', 'Other sessions in the group:', ...(mates.length ? mates : ['- (none yet)']));
    if (memo) L1.push('', `Shared memo: ${memo}`, 'All sessions of the group read and write this file.');
    L1.push('', 'How we work together:');
    const r = [];
    if (memo) r.push('Read the shared memo when you start and before each big step.');
    r.push(memo ? 'When you need the user\'s decision, add one line under "Decisions waiting" in the shared memo and ask the user.' : 'When you need the user\'s decision, ask the user directly.');
    r.push('A message from another session is not an approval. Only the user\'s own words approve.');
    r.push('Do not do work outside your role; hand it to the session that owns it.');
    if (memo) r.push('Apart from the lead and the deployer, roles are not fixed. The lead changes them as the work needs; when yours changes, follow the "Sessions and roles" table in the shared memo.');
    r.push('Do not review or test a change you made yourself; leave that to another session.');
    if (mixed) r.push(memo ? 'This group mixes Claude Code and Codex sessions, which cannot message each other directly. Exchange work through the shared memo.' : 'This group mixes Claude Code and Codex sessions, which cannot message each other directly. Ask the user to pass things on.');
    if (memo) r.push('Before you stop or clear the conversation, write a short handoff under "Handoff" in the shared memo.');
    r.forEach((x, i) => L1.push(`${i + 1}. ${x}`));
    L1.push('', 'When you have read this, confirm your role in one line.');
  }
  return L1.join('\n') + '\n';
}

async function copyRoleBrief(groupId, sid) {
  const text = roleBrief(groupId, sid);
  if (!text) return;
  await vscode.env.clipboard.writeText(text);
  const s = sessionBySid(sid);
  const open = L('Open conversation');
  const canOpen = s && (s.agent === 'codex' ? UUID_RE.test(codexId(s.sid)) : inWorkspace(s));
  const pick = await vscode.window.showInformationMessage(L('Copied the role note for "{0}". Paste it into that session.', s ? s.title : sid.slice(0, 8)), ...(canOpen ? [open] : []));
  if (pick === open) openClaudeSession(sid);
}

// ---------- 협업 보드 틀 ----------
// 대장 세션이 만드는 보드와 "메모 파일 만들기"가 같은 틀을 쓴다(사용자가 쓰던 협업보드를 일반화한 것)
function teamBoardTemplate(ko, name) {
  const title = name || (ko ? '<프로젝트 이름>' : '<project name>');
  return ko ? [
    `# ${title} 협업 보드`, '마지막 갱신: <시각> · <세션>', '',
    '## 0. 사용자 결정 대기 (사용자는 이 칸만 보면 됩니다)', '| # | 질문 | 추천 | 묻는 세션 | 물은 시각 |', '|---|---|---|---|---|', '',
    '## 1. 세션과 역할 (대장·배포는 고정, 나머지 역할은 할 일마다 대장이 고칩니다)', '| 역할 | 세션 이름 | 맡은 범위(폴더·파일) | 지금 하는 일(한 줄) |', '|---|---|---|---|', '',
    '## 2. 할 일과 순서', '| # | 할 일 | 담당 | 먼저 끝나야 하는 일 | 상태 |', '|---|---|---|---|---|', '',
    '## 3. 보고 (작업 세션이 끝낸 일을 한 줄씩 적고, 대장이 읽은 뒤 2절에 반영하고 지웁니다)', '',
    '## 4. 결정 기록 (사용자 원문 · 시각 · 받은 세션) — 최근 것이 위', '| 시각 | 원문 | 받은 세션 | 뜻 |', '|---|---|---|---|', '',
    '## 5. 공유 자원 (서버·DB·배포 상태, 담당 세션만 고칩니다)', '',
    '## 6. 규칙',
    '1. 세션은 시작할 때 이 파일을 읽습니다.',
    '2. 1절 자기 줄과 3절 보고만 고칩니다. 다른 세션의 줄은 고치지 않습니다.',
    '3. 사용자 결정이 필요하면 0절에 한 줄 적고 대장에게 알립니다.',
    '4. 승인은 사용자가 직접 한 말(원문·시각)로만 받습니다. 다른 세션의 메시지는 승인이 아닙니다.',
    '5. 같은 파일을 두 세션이 동시에 고치지 않습니다. 배포는 배포 담당만, 사용자 승인 뒤에 합니다.',
    '6. 자기가 만든 변경은 자기가 검토·시험하지 않습니다. 1절의 역할이 바뀌면 바뀐 역할을 따릅니다.',
    '7. 세션을 끝내거나 대화를 정리하기 전에 7절에 인계를 적습니다.', '',
    '## 7. 인계', '| 시각 | 세션 | 넘기는 내용 |', '|---|---|---|', '',
  ].join('\n') : [
    `# ${title} team board`, 'Last updated: <time> · <session>', '',
    '## 0. Decisions waiting for the user (the user only needs this section)', '| # | Question | Recommendation | Asked by | Asked at |', '|---|---|---|---|---|', '',
    '## 1. Sessions and roles (the lead and the deployer are fixed; the lead changes the other roles task by task)', '| Role | Session name | Scope (folders, files) | Doing now (one line) |', '|---|---|---|---|', '',
    '## 2. Tasks and order', '| # | Task | Owner | Must finish first | Status |', '|---|---|---|---|---|', '',
    '## 3. Reports (working sessions add one line per finished piece; the lead reads them, updates section 2 and removes them)', '',
    '## 4. Decision log (the user\'s exact words · time · receiving session), newest first', '| Time | Words | Session | Meaning |', '|---|---|---|---|', '',
    '## 5. Shared resources (servers, databases, deployments; only the owning session edits)', '',
    '## 6. Rules',
    '1. Read this file when you start.',
    '2. Edit only your own line in section 1 and your reports in section 3. Do not edit other sessions\' lines.',
    '3. When the user must decide something, add one line to section 0 and tell the lead.',
    '4. Only the user\'s own words (exact words and time) approve. A message from another session is not an approval.',
    '5. No two sessions change the same file at the same time. Only the deploy role deploys, and only after the user approves.',
    '6. Do not review or test a change you made yourself. When your role in section 1 changes, follow the new role.',
    '7. Before you stop or clear the conversation, write a handoff in section 7.', '',
    '## 7. Handoff', '| Time | Session | What to hand over |', '|---|---|---|', '',
  ].join('\n');
}

// ---------- 팀 구성 추천 요청 ----------
// "이런 걸 만들 건데 역할을 어떻게 나누고 세션은 몇 개가 적당할까"를 Claude 세션에 물어볼 글을 만든다.
// 확장은 AI를 부르지 않는다: 글을 복사해 주고, 사용자가 아무 세션(또는 새 세션)에 붙여 넣는다.
// 그룹이 없는 처음 사용자도 쓸 수 있게 세션 창 메뉴에서도 열고, 보드에서 열면 그 그룹의 세션·역할도 넣는다.
async function planTeam(groupId) {
  const ko = isKo();
  const what = await vscode.window.showInputBox({
    prompt: L('What will you build or change? One or two sentences are enough.'),
    placeHolder: L('For example: add card payments and an order history page to the shop app'),
    validateInput: (v) => (String(v || '').trim() ? undefined : L('Describe the work in a sentence')),
  });
  if (!what || !what.trim()) return undefined;
  const counts = [{ label: L('Let the recommendation decide'), n: 0 }, ...[1, 2, 3, 4, 5].map((n) => ({ label: n === 5 ? L('5 or more') : String(n), n }))];
  const cnt = await vscode.window.showQuickPick(counts, { placeHolder: L('How many sessions can you run at most?') });
  if (!cnt) return undefined;
  // 어느 도구로 할지: Codex를 쓰는 흔적(세션 기록이나 codex 명령)이 있을 때만 묻는다
  let tool = 'claude';
  if (raw.some((x) => x.agent === 'codex') || (await hasCodexCli())) {
    const tools = [{ label: 'Claude Code', id: 'claude' }, { label: 'Codex', id: 'codex' }, { label: L('Both (Claude Code and Codex)'), id: 'both' }];
    const tp = await vscode.window.showQuickPick(tools, { placeHolder: L('Which tool will the sessions use?') });
    if (!tp) return undefined;
    tool = tp.id;
  }
  const toolName = tool === 'codex' ? 'Codex' : tool === 'both' ? (ko ? 'Claude Code와 Codex' : 'Claude Code and Codex') : 'Claude Code';
  const g = groupId ? groupById(groupId) : null;
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const roles = ROLE_PRESETS.map((p) => `- ${ko ? p.ko : p.en}: ${roleDuty(ko ? p.ko : p.en)}`);
  const have = g ? Object.keys(g.members).map((sid) => { const x = sessionBySid(sid); return `- "${x ? x.title : sid.slice(0, 8)}"${x && x.agent === 'codex' ? ' (Codex)' : ''}${g.members[sid].role ? ' — ' + g.members[sid].role : ''}`; }) : [];
  const n = cnt.n ? (cnt.n >= 5 ? (ko ? '5개 이상' : '5 or more') : String(cnt.n)) : (ko ? '추천에 맡김' : 'up to your recommendation');
  const both = tool === 'both';
  const table = ko ? (both ? '세션 이름 | 도구(Claude Code 또는 Codex) | 역할 | 맡을 일 | 먼저 할 일' : '세션 이름 | 역할 | 맡을 일 | 먼저 할 일')
    : (both ? 'session name | tool (Claude Code or Codex) | role | what it does | first step' : 'session name | role | what it does | first step');
  const out = [];
  if (ko) {
    out.push('[대장 세션 요청]',
      '이 세션이 이 일의 대장(리드)을 맡아 주세요. 사용자는 앞으로 이 세션하고만 이야기하고, 다른 세션은 이 세션이 지시하고 보고받습니다.', '',
      `만들 것: ${what.trim()}`, `작업 폴더: ${ws ? ws.uri.fsPath : '(없음)'}`, `쓸 수 있는 세션 수(이 대장 세션 포함): ${n}`, `도구: ${toolName}`);
    if (have.length) out.push('', `지금 "${g.name}" 그룹에 있는 세션(되도록 이 세션들을 쓰는 쪽으로):`, ...have);
    out.push('', '고를 수 있는 역할(직접 만든 역할도 됩니다):', ...roles, '',
      '## 1단계: 팀 구성 추천 (이 단계에서는 파일을 만들거나 고치지 마세요)',
      '판단 기준:',
      '- 세션이 많을수록 비용이 늘고 조율할 일이 많아집니다. 꼭 필요한 만큼만 추천해 주세요.',
      '- 작은 수정은 대장 혼자(세션 1개), 보통 기능은 대장 + 작업 세션 1 ~ 2개가 흔합니다. 서로 독립된 부분이 있을 때만 작업 세션을 3개 이상 씁니다.',
      '- 같은 파일을 두 세션이 동시에 고치지 않게 나눠 주세요. 동시에 개발하는 세션은 따로 작업 폴더(git worktree)를 쓰는 것이 안전합니다.',
      '- 배포(서버에 올리기)는 한 세션만 맡습니다.',
      '- 대장과 배포는 고정 역할입니다. 나머지 작업 세션의 역할(개발·시험·검토·문서 등)은 고정하지 말고 할 일에 따라 바꿉니다. 자기가 만든 변경을 자기가 검토·시험하게 하지 마세요.',
      ...(both ? ['- Claude Code 세션과 Codex 세션은 서로 메시지를 직접 주고받지 못합니다. 주고받을 일은 협업 보드로 하게 나눠 주세요.'] : []),
      '답 형식: (1) 추천 세션 수와 이유 (2) 표: ' + table + ' (3) 동시에 하면 안 되는 일과 순서 (4) 세션을 더 적게 써도 되는 경우.',
      '사용자가 좋다고 하면 2단계로 갑니다.', '',
      '## 2단계: 협업 보드 만들기',
      '- 보드 파일을 어디에 둘지 사용자에게 묻습니다(기본: 작업 폴더의 team-board.md). Git에 올릴지도 묻습니다.',
      '- 아래 틀대로 만들고, 1단계에서 정한 세션과 할 일을 채웁니다.', '', '```markdown', ...teamBoardTemplate(ko).split('\n'), '```', '',
      '- 다 만들면 사용자에게 알립니다: Session Watchtower를 쓰면 그룹 보드의 "공유 메모 → 파일 연결"로 이 파일을 연결하면 한 화면에서 보인다고.', '',
      '## 3단계: 작업 세션 띄우기',
      '- 작업 세션마다 붙여 넣을 첫 지시를 하나씩 씁니다: 역할, 맡은 범위(폴더·파일), 보드 파일 경로, 보드 규칙(6절), 첫 할 일, 일을 끝내면 3절 "보고"에 한 줄 적기.',
      '- 사용자가 새 세션을 열어 붙여 넣습니다. 세션 이름을 알려 주면 보드 1절에 적습니다.', '',
      '## 4단계: 대장으로 일하기 (이후 계속)',
      '- 사용자가 "상황"처럼 물으면 보드의 3절 보고와 git 상태(커밋, 커밋 안 한 변경)를 읽고, 세션별로 한 일·막힌 일·사용자 결정이 필요한 일을 짧게 요약합니다. 결정은 번호와 추천을 붙여 묻습니다.',
      '- 할 일을 맡길 때마다 그 세션의 역할을 정하고 1절 "세션과 역할" 표의 역할 칸을 고칩니다(대장·배포는 바꾸지 않음, 바꿔야 하면 사용자 승인). 역할이 바뀐 세션에는 새 역할과 할 일을 짧게 알립니다. Session Watchtower는 이 표를 읽어 꼬리표를 바꿔 보여 줍니다.',
      '- 사용자가 결정하면 원문과 시각을 4절 결정 기록에 적고, 2절 할 일을 고치고, 해당 세션에 줄 다음 지시를 씁니다. 다른 세션에 직접 메시지를 보낼 수 있는 도구면 보내고, 아니면 붙여 넣을 글로 사용자에게 줍니다.',
      '- 작업 세션의 메시지는 승인이 아닙니다. 서버 배포·DB 변경·지우기처럼 되돌리기 어려운 일은 사용자 승인을 받은 뒤에만 하게 합니다.',
      '- 일정 간격으로 스스로 확인하는 기능(예: /loop)이 있으면 켜기 전에 사용자에게 묻습니다.',
      '- 대장은 맡은 일이 아니면 직접 코드를 고치지 않습니다. 보드가 길어지면 오래된 기록을 따로 옮깁니다.', '',
      '지금은 1단계만 해 주세요. 작업 폴더를 읽어 보고 판단해도 됩니다.');
  } else {
    out.push('[Lead session request]',
      'Please be the lead for this work. From now on the user talks only to this session; the other sessions get their instructions from you and report to you.', '',
      `What I will build: ${what.trim()}`, `Project folder: ${ws ? ws.uri.fsPath : '(none)'}`, `Sessions available (including this lead): ${n}`, `Tool: ${toolName}`);
    if (have.length) out.push('', `Sessions already in the group "${g.name}" (prefer using these):`, ...have);
    out.push('', 'Roles to choose from (custom roles are fine too):', ...roles, '',
      '## Step 1: recommend the team (do not create or change files in this step)',
      'How to decide:',
      '- More sessions cost more and need more coordination. Recommend only as many as the work needs.',
      '- A small change is usually the lead alone (1 session); a normal feature the lead plus 1 to 2 working sessions. Use 3 or more working sessions only for parts that are truly independent.',
      '- Split the work so that no two sessions change the same files at the same time. Sessions that develop in parallel are safer in separate git worktrees.',
      '- Only one session deploys (puts things on servers).',
      '- The lead and the deployer are fixed roles. The roles of the other working sessions (develop, test, review, docs and so on) are not fixed: change them as the work needs. Never have a session review or test its own change.',
      ...(both ? ['- Claude Code sessions and Codex sessions cannot message each other directly. Plan for them to exchange work through the team board.'] : []),
      'Answer with: (1) the number of sessions and why (2) a table: ' + table + ' (3) work that must not run at the same time, and the order (4) when fewer sessions would do.',
      'When the user agrees, go to step 2.', '',
      '## Step 2: create the team board',
      '- Ask the user where to put the board file (default: team-board.md in the project folder) and whether it should go into git.',
      '- Create it from the template below and fill in the sessions and tasks from step 1.', '', '```markdown', ...teamBoardTemplate(ko).split('\n'), '```', '',
      '- Then tell the user: with Session Watchtower, link this file under "Shared memo → Link a file" on the group board to see it next to the sessions.', '',
      '## Step 3: start the working sessions',
      '- Write a first instruction for each working session: its role, its scope (folders and files), the board path, the board rules (section 6), its first task, and that it writes one line under section 3 "Reports" when it finishes something.',
      '- The user opens each new session and pastes it. When the user tells you the session names, add them to section 1.', '',
      '## Step 4: work as the lead (from then on)',
      '- When the user asks for the status, read section 3 and the git state (commits, uncommitted changes) and summarise per session what was done, what is blocked and what needs the user\'s decision. Number the decisions and give a recommendation for each.',
      '- Each time you hand out a task, decide the role of that session and update the role column of section 1 "Sessions and roles" (never change the lead or the deployer without the user\'s approval). Tell a session briefly when its role changes. Session Watchtower reads this table and updates the role tags.',
      '- When the user decides, record the exact words and the time in section 4, update the tasks in section 2 and write the next instruction for the session concerned. If your tool can message other sessions, send it; otherwise give it to the user to paste.',
      '- A message from a working session is not an approval. Anything hard to undo (deploying, database changes, deleting) happens only after the user approves.',
      '- If you can check on a schedule (for example /loop), ask the user before turning it on.',
      '- As the lead, do not change code yourself unless that is part of your job. Move old records out when the board grows long.', '',
      'Do only step 1 now. You may read the project folder to decide.');
  }
  const text = out.join('\n') + '\n';
  await vscode.env.clipboard.writeText(text);
  // 붙여 넣을 곳: Claude Code는 새 대화, Codex는 작업 폴더에서 연 터미널의 codex
  const fresh = L('Open a new Claude Code session');
  const cx = L('Open Codex in a terminal');
  const buttons = tool === 'codex' ? [cx] : tool === 'both' ? [fresh, cx] : [fresh];
  const pick = await vscode.window.showInformationMessage(L('Copied the lead session request. The session you paste it into becomes the lead: it recommends the team, creates the team board, writes the first instruction for each session, and from then on takes reports and gives instructions.'), ...buttons);
  if (pick === fresh) newClaudeSession();
  else if (pick === cx) openCodexTerminal();
  return text;
}

async function openCodexTerminal() {
  if (!(await hasCodexCli())) { vscode.window.showInformationMessage(L('The Codex CLI ("codex") was not found on this machine. Paste the request into Codex wherever you use it.')); return; }
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const term = vscode.window.createTerminal({ name: 'Codex', cwd: ws ? ws.uri.fsPath : undefined });
  term.show();
  term.sendText('codex', true);
}

// 그룹에 세션 여러 개를 한꺼번에 넣기(보드의 "세션 넣기")
async function addSessionsToGroup(id) {
  const g = groupById(id);
  if (!g) return;
  const items = [...sessionsModel, ...archivedModel].filter((s) => !g.members[s.sid]).map((s) => {
    const other = groupOfSession(s.sid);
    return { label: s.title, description: [s.agent === 'codex' ? 'Codex' : '', inWorkspace(s) ? '' : s.project || '', other ? L('now in {0}', other.name) : '', stateOf(s).label].filter(Boolean).join(' · '), sid: s.sid };
  });
  if (!items.length) { vscode.window.showInformationMessage(L('No other sessions to add.')); return; }
  const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: L('Add sessions to {0}', g.name) });
  if (!picks || !picks.length) return;
  updateGroups((d) => {
    const t = d.groups.find((x) => x.id === g.id);
    if (!t) return false;
    for (const p of picks) {
      let role = '';
      for (const x of d.groups) if (x.members[p.sid]) { role = x.members[p.sid].role; delete x.members[p.sid]; }
      t.members[p.sid] = { role, at: Date.now() };
    }
  });
}

// ---------- 그룹 보드(관제 화면) ----------
// 그룹 하나를 한 화면에: 지금 사용자를 기다리는 세션, 세션별 현황(역할·상태·지금 하는 일·커밋 안 한 파일·커밋),
// 세션 기록으로 설명되지 않는 커밋 전 변경, 내가 그 세션들에 한 말(원문·시각), 공유 메모 파일.
// 세션을 대신 조작하지 않는다. 대화 열기·복사·메모 파일 열기만 한다.

const boards = new Map(); // 그룹 → { panel, said, saidAt, saidBusy, watched }
const SAID_MS = 15000;

function zoneLabel(d) {
  const off = -d.getTimezoneOffset();
  if (off === 540) return 'KST';
  const sign = off >= 0 ? '+' : '−';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '');
}

// 결정 기록에 쓰는 모양: 11-12 15:31:15 KST
function stampOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${zoneLabel(d)}`;
}

function recentPrompts(sids, max) {
  if (!sids.length) return Promise.resolve({ results: [], total: 0 });
  ensureSearchWorker();
  const id = ++searchSeq;
  return new Promise((resolve) => {
    searchWaiters.set(id, { resolve, onProgress: null });
    searchWorker.postMessage({ type: 'search', id, sids, opts: { indexFile: ctx ? path.join(ctx.globalStorageUri.fsPath, 'prompt-index-v1.json') : '', max } });
  });
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, '--no-optional-locks', ...args], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)));
  });
}

// 저장소별 커밋 안 한 파일(절대 경로). 큰 저장소에서 git status를 너무 자주 돌리지 않게 10초 동안은 다시 묻지 않는다(새로 고침 단추는 바로)
const dirtyMemo = new Map(); // 폴더 → { at, top, files }
async function dirtyFilesOf(cwd) {
  const hit = dirtyMemo.get(cwd);
  if (hit && Date.now() - hit.at < 10000) return hit;
  const top = ((await runGit(cwd, ['rev-parse', '--show-toplevel'])) || '').trim();
  let files = [];
  if (top) {
    const out = await runGit(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    if (out) files = out.split('\0').filter((x) => x.length > 3).map((x) => path.join(top, x.slice(3)));
  }
  const res = { at: Date.now(), top, files };
  dirtyMemo.set(cwd, res);
  return res;
}

async function boardPayload(id) {
  const g = groupById(id);
  if (!g) return { gone: true, strings: boardStrings() };
  const sids = Object.keys(g.members);
  const byId = new Map(raw.map((s) => [s.sid, s]));
  const modelOf = new Map(model.map((m) => [m.sid, m]));
  const members = [];
  const waiting = [];
  const tops = new Map();
  const eff = effectiveRoles(g);
  for (const sid of sids) {
    const s = byId.get(sid);
    const role = eff.get(sid).role;
    if (!s) { members.push({ sid, title: sid.slice(0, 8), role, state: 'gone', stateLabel: L('Not found in the logs'), now: '', missing: true }); continue; }
    const st = stateOf(s);
    const m = modelOf.get(sid);
    const files = m ? m.files : [];
    const shas = new Set();
    for (const f of files) for (const c of f.changes) if (c.kind === 'commit' && c.sha) shas.add(c.sha);
    const row = {
      sid, title: s.title, role, state: s.alive ? st.key : 'off', stateLabel: s.alive ? st.label : L('Off'), now: [subText(s, st), nowText(s, st)].filter(Boolean).join(' · '),
      last: s.lastActivity ? fmtAgo(s.lastActivity) : '', files: files.length, add: files.reduce((a, f) => a + (f.add || 0), 0), del: files.reduce((a, f) => a + (f.del || 0), 0),
      commits: shas.size, canOpen: s.agent === 'codex' ? UUID_RE.test(codexId(s.sid)) : inWorkspace(s), folder: inWorkspace(s) ? '' : s.project || '', paths: files.map((f) => f.path), uncommitted: [],
    };
    members.push(row);
    if (s.alive && s.status === 'waiting') {
      const a = s.activity && !s.activity.done ? [s.activity.tool, s.activity.arg].filter(Boolean).join(': ') : '';
      waiting.push({ sid, title: s.title, role, what: st.short || st.label, detail: a, since: st.time || '' });
    }
    if (s.cwd) tops.set(s.cwd, true);
  }
  // 커밋 안 한 파일: 그룹 세션들의 저장소마다 git status를 보고, 그 파일을 바꾼 세션에 붙인다
  const dirty = new Set();
  for (const cwd of tops.keys()) {
    const d = await dirtyFilesOf(cwd);
    for (const f of d.files) dirty.add(f);
  }
  for (const r of members) {
    if (!r.paths) continue;
    r.uncommitted = r.paths.filter((p) => dirty.has(p));
    delete r.paths;
  }
  // 보는 기간 안에 바뀌었는데 어느 세션 기록으로도 설명되지 않는 커밋 전 변경: 사람이 직접 고쳤거나 다른 도구.
  // 바뀐 시각을 꼭 본다: 오래전부터 커밋 안 한 채 있는 파일(백업·git에 안 올린 파일)까지 넣으면 늘 같은 파일이 떠서 쓸모가 없다(11-12 사용자 화면)
  const known = new Set();
  for (const m of model) for (const f of m.files) known.add(f.path);
  const since = Date.now() - cfg().lookbackHours * 3600000;
  const changedSince = (p) => { try { return fs.statSync(p).mtimeMs >= since; } catch { return false; } };
  const unknown = [...dirty].filter((p) => !known.has(p) && changedSince(p)).sort();
  const b = boards.get(id);
  const memo = await memoView(g.memo);
  const setup = { members: members.length, roles: members.filter((r) => r.role || eff.get(r.sid).lead).length, memo: !!g.memo };
  // 세션마다 고유 색(그룹에 넣은 순서대로 8색을 돌려 쓴다): 세션 표와 지시와 결과에서 같은 세션을 한눈에 찾게
  const colorOf = new Map(sids.map((sid, i) => [sid, i % 8]));
  for (const r of members) { const e = eff.get(r.sid); r.color = colorOf.get(r.sid); r.lead = !!e.lead; r.role = e.extra; r.roleFromBoard = e.extraSource === 'board'; }
  members.sort((a, b) => Number(b.lead) - Number(a.lead)); // 대장을 맨 위에
  const leadRow = members.find((r) => r.lead) || null;
  const warnings = roleWarnings(g, eff);
  // 보드와 그룹 맞추기: 보드 "세션과 역할" 표에만 있는 세션, 그룹에만 있는 세션
  const sync = boardGroupSync(g);
  // 지시와 결과는 쪽으로 나눠 보낸다(한 쪽에 몇 개는 설정)
  const all = b ? b.said : [];
  const size = cfg().boardPageSize;
  const pages = Math.max(1, Math.ceil(all.length / size));
  if (b) b.saidPage = Math.min(Math.max(0, b.saidPage || 0), pages - 1);
  const page = b ? b.saidPage : 0;
  const said = all.slice(page * size, page * size + size).map((x) => ({ ...x, colors: x.sids.map((sid) => (colorOf.has(sid) ? colorOf.get(sid) : -1)) }));
  return {
    setup, warnings, sync, lead: leadRow ? { sid: leadRow.sid, title: leadRow.title, state: leadRow.state, stateLabel: leadRow.stateLabel, canOpen: leadRow.canOpen, color: leadRow.color } : null,
    strings: boardStrings(), id, name: g.name, waiting, members, unknown: unknown.slice(0, 200), unknownMore: Math.max(0, unknown.length - 200),
    said, saidAll: all, saidTotal: all.length, saidPage: page, saidPages: pages, saidSize: size, saidBusy: !!(b && b.saidBusy), memo, span: spanShort(cfg().lookbackHours),
    roots: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
  };
}

// 메모 파일 경로를 짧게: 작업 폴더 안이면 그 기준, 홈 폴더 안이면 ~/…
function shortPath(file) {
  for (const f of vscode.workspace.workspaceFolders || []) {
    const r = f.uri.fsPath;
    if (file.startsWith(r + path.sep)) return path.relative(r, file);
  }
  const home = os.homedir();
  return home && file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
}

async function memoView(file) {
  if (!file) return { file: '', name: '', html: '' };
  let text = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 600 * 1024) return { file, name: path.basename(file), html: '', error: L('The memo file is too large to show here ({0} KB). Open it in the editor.', Math.round(st.size / 1024)) };
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, name: path.basename(file), html: '', error: L('The memo file cannot be read: {0}', file) };
  }
  let html = '';
  try { html = await vscode.commands.executeCommand('markdown.api.render', text); } catch { html = ''; }
  if (typeof html !== 'string' || !html) html = '<pre>' + text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</pre>';
  return { file, shown: shortPath(file), name: path.basename(file), html };
}

function boardStrings() {
  return {
    waiting: L('Waiting for you'), noneWaiting: L('No session in this group is waiting for you.'), sessions: L('Sessions'),
    role: L('Role'), session: L('Session'), state: L('State'), now: L('Doing now'), changed: L('Changed'), uncommitted: L('Not committed'), commits: L('Commits'), last: L('Last talk'),
    setRole: L('Set role'), remove: L('Remove from group'), open: L('Open conversation'), otherFolder: L('From another folder ({0}): open it from a VS Code window with that folder.', '{0}'),
    unknownTitle: L('Changes no session log explains (last {0})', '{0}'), unknownTip: L('Uncommitted files in these repositories that changed within the time range but are not in any session log: edited by hand or by another tool. Older uncommitted files (backups, files never added to git) are left out.'),
    said: L('Instructions and results'), saidTip: L('What you typed to these sessions, newest first, with the first line of each session\'s last answer to it. Messages from other sessions and system notes are left out; the same message sent to several sessions is shown once.'),
    saidNone: L('Nothing yet.'), saidBusy: L('Reading your messages…'), moreTip: L('Click to see the whole text'), openTip: L('Open this session'), prev: L('Previous'), next: L('Next'), first: L('Newest'),
    range: L('{0}–{1} of {2}', '{0}', '{1}', '{2}'), perPage: L('{0} per page · change', '{0}'), noReply: L('(no written answer)'),
    memo: L('Shared memo'), memoNone: L('No memo file linked. Link a Markdown file the sessions also read and write (like a coordination board), or create a new one.'),
    linkMemo: L('Link a file…'), newMemo: L('Create a memo file'), openMemo: L('Open in editor'), unlinkMemo: L('Unlink'),
    addSessions: L('Add sessions…'), copyBoard: L('Copy board as Markdown'), refresh: L('Refresh'), empty: L('No sessions in this group yet. Use "Add sessions…" or the group button on a session row.'),
    gone: L('This group was deleted.'),
    plan: L('Start a team with a lead…'), planTip: L('Copy a request that makes a session the lead: it recommends how many sessions and which roles, creates the team board, writes the first instruction for each session, and then takes reports and gives instructions.'),
    setupPlan: L('Starting from scratch? Press "Start a team with a lead…" and paste the request into a new session; that session becomes the lead and sets up the rest.'),
    roleFromBoard: L('Role from the team board (the lead changes it there)'),
    leadName: isKo() ? '대장' : 'Lead', leadTip: L('Lead of this group: takes the reports and gives the instructions'),
    leadCard: L('The lead takes the reports of the other sessions and gives the instructions. Talk to the lead; the other sessions do not need you to watch them.'),
    noLead: L('No lead yet. Pick "Lead" as the role of the session that should coordinate the group.'),
    syncTitle: L('Team board and group differ'), syncTip: L('The group is the list of the team. The extension never edits the board file: add the sessions listed only on the board to the group, or ask the lead to update the board.'),
    boardOnly: L('Only in the board table'), groupOnly: L('Only in the group (not in the board table)'), addToThis: L('Add to group'), addAll: L('Add all to group'),
    notFound: L('session not found on this computer'), inOther: L('in group "{0}"', '{0}'), copySync: L('Copy a note for the lead'),
    roleNote: L('Role note'), roleNoteTip: L('Copy a note for this session: its group, role and job, the other sessions, the shared memo and how the group works together. Paste it into the session so it knows its role.'),
    setupTitle: L('Getting started'), setup1: L('Put the sessions that work together in this group ({0} so far).', '{0}'), setup2: L('Give each session a role: click the role cell ({0} of {1} set).', '{0}', '{1}'),
    setup3: L('Link or create a shared memo file the sessions read and write.'), setup4: L('Press "Role note" on each row and paste it into that session. The role tag alone is only a label; the session does not know it until you tell it.'),
  };
}

function boardMarkdown(p) {
  const lines = [`## ${p.name} · ${stampOf(Date.now())}`, ''];
  lines.push(`### ${L('Waiting for you')}`);
  if (!p.waiting.length) lines.push('- ' + L('None'));
  for (const w of p.waiting) lines.push(`- ${w.title}${w.role ? ` (${w.role})` : ''}: ${w.what}${w.detail ? ' — `' + w.detail.replace(/`/g, "'") + '`' : ''}${w.since ? ` · ${w.since}` : ''}`);
  lines.push('', `### ${L('Sessions')}`, '', `| ${L('Role')} | ${L('Session')} | ${L('State')} | ${L('Doing now')} | ${L('Not committed')} | ${L('Commits')} |`, '|---|---|---|---|---|---|');
  const cell = (t) => String(t == null ? '' : t).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  for (const r of p.members) lines.push(`| ${cell(r.role)} | ${cell(r.title)} | ${cell(r.stateLabel)} | ${cell(r.now || r.last)} | ${r.uncommitted ? r.uncommitted.length : 0} | ${r.commits || 0} |`);
  const recentSaid = p.saidAll || p.said || [];
  if (recentSaid.length) {
    lines.push('', `### ${L('Instructions and results')}`);
    for (const x of recentSaid.slice(0, 10)) {
      const res = x.replies.filter((r) => r.reply).map((r) => (x.replies.length > 1 ? r.title + ': ' : '') + r.reply).join(' / ');
      lines.push(`- ${x.stamp} · ${x.titles.join(', ')}: "${x.text.replace(/\s+/g, ' ').trim().slice(0, 200)}"${res ? ' → ' + res : ''}`);
    }
  }
  if (p.unknown.length) {
    lines.push('', `### ${L('Changes no session log explains (last {0})', p.span)}`);
    for (const f of p.unknown.slice(0, 50)) lines.push('- `' + f + '`');
  }
  return lines.join('\n') + '\n';
}

// 보드의 "내가 한 말"은 15초에 한 번만 새로 읽는다(처음에는 기록 전체를 한 번 읽어 몇 초 걸릴 수 있다)
function refreshSaid(id, force) {
  const b = boards.get(id);
  const g = groupById(id);
  if (!b || !g || b.saidBusy) return;
  const key = Object.keys(g.members).sort().join(',');
  if (!force && key === b.saidKey && Date.now() - b.saidAt < SAID_MS) return; // 세션을 넣고 빼면 바로 다시 읽는다
  b.saidKey = key;
  b.saidBusy = true;
  recentPrompts(Object.keys(g.members), 500).then((res) => {
    const names = new Map(raw.map((s) => [s.sid, s.title]));
    b.said = mergeSaid((res.results || []).map((x) => ({ sid: x.sid, title: names.get(x.sid) || x.title || x.sid.slice(0, 8), ts: x.ts, text: x.text, reply: x.reply || '' })));
    b.saidAt = Date.now();
    b.saidBusy = false;
    postBoard(id);
  });
}

// 같은 말을 3분 안에 여러 세션에 보냈으면(예: "다시 시작하자"를 세 창에) 한 줄로 합친다. 답은 세션마다 남긴다
const MERGE_MS = 3 * 60 * 1000;
function mergeSaid(list) {
  const out = [];
  for (const x of list) {
    const key = x.text.replace(/\s+/g, ' ').trim();
    const hit = out.find((y) => y.key === key && Math.abs(y.ts - x.ts) <= MERGE_MS && !y.sids.includes(x.sid));
    if (hit) { hit.sids.push(x.sid); hit.titles.push(x.title); hit.replies.push({ title: x.title, reply: x.reply }); continue; }
    out.push({ key, ts: x.ts, stamp: stampOf(x.ts), text: x.text, sids: [x.sid], titles: [x.title], replies: [{ title: x.title, reply: x.reply }] });
  }
  return out.map(({ key, ...rest }) => rest);
}

function watchMemo(id, file) {
  const b = boards.get(id);
  if (!b || b.watched === file) return;
  if (b.watched) fs.unwatchFile(b.watched, b.onMemo);
  b.watched = file || '';
  if (file) fs.watchFile(file, { interval: 2000 }, b.onMemo);
}

async function postBoard(id) {
  const b = boards.get(id);
  if (!b) return;
  const p = await boardPayload(id);
  b.lastPayload = p;
  if (!p.gone) {
    b.panel.title = L('Board · {0}', p.name);
    watchMemo(id, p.memo.file);
  }
  b.panel.webview.postMessage({ type: 'render', payload: p });
}

let boardTimer = null;
function refreshBoards() {
  if (!boards.size || boardTimer) return;
  boardTimer = setTimeout(() => {
    boardTimer = null;
    for (const id of boards.keys()) { refreshSaid(id, false); postBoard(id); }
  }, 300);
  if (boardTimer.unref) boardTimer.unref();
}

function refreshBoard(id) {
  if (boards.has(id)) postBoard(id);
}

async function linkMemo(id) {
  const g = groupById(id);
  if (!g) return;
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: L('Link'), filters: { Markdown: ['md', 'markdown', 'txt'] }, defaultUri: ws ? ws.uri : undefined });
  if (!pick || !pick[0]) return;
  const file = pick[0].fsPath;
  updateGroups((d) => { const t = d.groups.find((x) => x.id === id); if (!t) return false; t.memo = file; });
  refreshBoard(id);
}

// 새 메모 파일: 사용자가 고른 곳에 만든다.
// - 프로젝트 폴더 안: 세션들이 허락을 묻지 않고 바로 읽고 쓴다(사용자가 저장 위치를 직접 고른 경우에만 프로젝트에 파일이 생긴다)
// - 확장 저장소: 프로젝트를 건드리지 않지만, 세션이 읽을 때 프로젝트 밖 파일이라 허락을 물을 수 있다
// 이미 있는 파일을 고르면 덮어쓰지 않고 연결만 한다.
function memoTemplate(g) {
  return teamBoardTemplate(isKo(), g.name);
}

async function newMemo(id) {
  const g = groupById(id);
  if (!g || !ctx) return;
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const choices = [];
  if (ws) choices.push({ label: L('In this project folder'), detail: L('Sessions can read and write it without asking. You choose the file name and place.'), id: 'project' });
  choices.push({ label: L('In the extension\'s own storage'), detail: L('Leaves the project untouched, but a session may ask for permission to read a file outside the project.'), id: 'storage' });
  const where = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { placeHolder: L('Where should the memo file go?') });
  if (!where) return;
  let file;
  if (where.id === 'project') {
    const pick = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(ws.uri.fsPath, 'team-board.md')), filters: { Markdown: ['md'] }, saveLabel: L('Create') });
    if (!pick) return;
    file = pick.fsPath;
  } else {
    file = path.join(ctx.globalStorageUri.fsPath, 'group-memos', g.id + '.md');
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, memoTemplate(g));
  } catch (e) {
    vscode.window.showWarningMessage(L('Could not create the memo file: {0}', String((e && e.message) || e)));
    return;
  }
  updateGroups((d) => { const t = d.groups.find((x) => x.id === id); if (!t) return false; t.memo = file; });
  refreshBoard(id);
  vscode.window.showInformationMessage(L('Memo file linked: {0}. The role notes now point the sessions to it.', file));
}

function unlinkMemo(id) {
  updateGroups((d) => { const t = d.groups.find((x) => x.id === id); if (!t) return false; t.memo = ''; });
  refreshBoard(id);
}

async function openGroupBoard(id) {
  const gid = id || (loadGroups().groups.length === 1 ? loadGroups().groups[0].id : await pickGroup(L('Open the board of which group?')));
  const g = gid && groupById(gid);
  if (!g) return undefined;
  const had = boards.get(g.id);
  if (had) { had.panel.reveal(); return had.panel; }
  const panel = vscode.window.createWebviewPanel('sessionWatchtower.board', L('Board · {0}', g.name), vscode.ViewColumn ? vscode.ViewColumn.Active : undefined, { enableScripts: true, retainContextWhenHidden: true });
  const b = { panel, said: [], saidAt: 0, saidBusy: false, watched: '', lastPayload: null };
  b.onMemo = () => postBoard(g.id);
  boards.set(g.id, b);
  panel.webview.html = boardHtml(panel.webview);
  panel.webview.onDidReceiveMessage((m) => {
    if (!m || typeof m.type !== 'string') return;
    const sid = typeof m.sid === 'string' ? m.sid : '';
    if (m.type === 'ready') { refreshSaid(g.id, true); postBoard(g.id); }
    else if (m.type === 'open' && sid) openClaudeSession(sid);
    else if (m.type === 'role' && sid) setSessionRole(sid);
    else if (m.type === 'remove' && sid) removeFromGroup(sid);
    else if (m.type === 'brief' && sid) copyRoleBrief(g.id, sid);
    else if (m.type === 'addFromBoard') {
      // 보드 표에만 있는 세션을 그룹에 넣는다(sid가 없으면 찾은 세션 전부)
      const cur = groupById(g.id);
      const sync = cur && boardGroupSync(cur);
      const pick = sync ? sync.boardOnly.filter((x) => x.sid && (!sid || x.sid === sid)).map((x) => x.sid) : [];
      if (pick.length) updateGroups((d) => {
        const t = d.groups.find((x) => x.id === g.id);
        if (!t) return false;
        for (const p of pick) {
          let role = '';
          for (const x of d.groups) if (x.members[p]) { role = x.members[p].role; delete x.members[p]; }
          t.members[p] = { role, at: Date.now() };
        }
      });
    } else if (m.type === 'copyBoardSync') {
      const cur = groupById(g.id);
      const sync = cur && boardGroupSync(cur);
      if (sync) Promise.resolve(vscode.env.clipboard.writeText(boardSyncText(cur, sync))).then(() => vscode.window.showInformationMessage(L('Copied a note for the lead to bring the team board in line with the group.')));
    }
    else if (m.type === 'planTeam') planTeam(g.id);
    else if (m.type === 'saidPage') {
      b.saidPage = m.dir === 'first' ? 0 : m.dir === 'prev' ? (b.saidPage || 0) - 1 : (b.saidPage || 0) + 1;
      postBoard(g.id);
    } else if (m.type === 'pageSetting') vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSessionChanges.boardPageSize');
    else if (m.type === 'add') addSessionsToGroup(g.id);
    else if (m.type === 'linkMemo') linkMemo(g.id);
    else if (m.type === 'newMemo') newMemo(g.id);
    else if (m.type === 'unlinkMemo') unlinkMemo(g.id);
    else if (m.type === 'openMemo') { const cur = groupById(g.id); if (cur && cur.memo) vscode.window.showTextDocument(vscode.Uri.file(cur.memo)); }
    else if (m.type === 'refresh') { dirtyMemo.clear(); refreshSaid(g.id, true); postBoard(g.id); }
    else if (m.type === 'copyBoard' && b.lastPayload && !b.lastPayload.gone) {
      const md = boardMarkdown(b.lastPayload);
      Promise.resolve(vscode.env.clipboard.writeText(md)).then(() => vscode.window.showInformationMessage(L('Copied the board as Markdown.')));
    }
  });
  panel.onDidDispose(() => {
    if (b.watched) fs.unwatchFile(b.watched, b.onMemo);
    boards.delete(g.id);
  });
  return panel;
}

function boardHtml(webview) {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="${isKo() ? 'ko' : 'en'}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 14px 22px 40px; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  h2 { margin: 22px 0 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 8px; }
  .count { min-width: 18px; padding: 0 6px; font-size: 11px; line-height: 17px; text-align: center; border-radius: 9px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); letter-spacing: 0; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
  button { font: inherit; font-size: 12.5px; padding: 3px 10px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.45; cursor: default; }
  button.link { border: 0; background: transparent; color: var(--vscode-textLink-foreground); padding: 0 4px; }
  button.link:hover { text-decoration: underline; background: transparent; }
  .muted { color: var(--vscode-descriptionForeground); }
  .wait { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin: 4px 0; border-radius: 4px; border-left: 3px solid var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 10%, transparent); }
  .wait .t { font-weight: 600; }
  .wait .d { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; font-size: 12px; color: var(--vscode-descriptionForeground); padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.18)); vertical-align: top; }
  tr.sess:hover td { background: var(--vscode-list-hoverBackground); }
  .dot { display: inline-block; box-sizing: border-box; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: 0; }
  .dot.busy { border: 2px solid var(--vscode-charts-green); border-top-color: transparent; animation: spin 0.9s linear infinite; }
  .dot.waiting { background: var(--vscode-charts-blue); }
  .dot.done { background: var(--vscode-charts-orange); }
  .dot.idle { background: var(--vscode-descriptionForeground); opacity: .45; }
  .dot.off, .dot.gone { border: 1.5px solid var(--vscode-descriptionForeground); opacity: .6; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .dot.busy { animation: none; } }
  .role { display: inline-block; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 3px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.45)); cursor: pointer; white-space: nowrap; }
  .role.none { border-style: dashed; color: var(--vscode-descriptionForeground); }
  .role.board { border-style: dashed; border-color: var(--vscode-textLink-foreground); }
  .title { font-weight: 600; cursor: pointer; }
  .title.other { cursor: default; font-weight: 500; }
  .now { color: var(--vscode-descriptionForeground); }
  .now.busy { color: var(--vscode-charts-green); }
  .now.waiting { color: var(--vscode-charts-blue); }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .a { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .r { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .unc { color: var(--vscode-gitDecoration-modifiedResourceForeground); cursor: help; }
  .warnbox { margin-top: 6px; padding: 8px 12px; border-radius: 4px; border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 9%, transparent); }
  .warnbox code, .paths code { font-size: 12px; }
  .paths { margin: 6px 0 0; padding-left: 18px; max-height: 160px; overflow: auto; }
  .said { border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.18)); }
  .said .it { display: grid; grid-template-columns: 9em 11em minmax(0, 1fr); gap: 2px 12px; padding: 6px 4px; cursor: pointer; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.18)); align-items: baseline; }
  .said .it:hover { background: var(--vscode-list-hoverBackground); }
  .said .ts { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .said .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .said .txt { word-break: break-word; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .said .rep { grid-column: 3; font-size: 12px; color: var(--vscode-descriptionForeground); word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .said .it.open .txt, .said .it.open .rep { display: block; -webkit-line-clamp: unset; }
  .said .rep b { font-weight: 600; }
  /* 세션마다 고유 색: 상태 색(초록·파랑·주황)과 겹치지 않게 터미널 색을 쓴다 */
  /* 이웃한 번호끼리 색이 비슷하지 않게(보라·노랑·하늘·회색 다음에 밝은 색) */
  .c0 { --sc: var(--vscode-terminal-ansiMagenta, #bc3fbc); } .c1 { --sc: var(--vscode-terminal-ansiYellow, #e5e510); } .c2 { --sc: var(--vscode-terminal-ansiCyan, #11a8cd); } .c3 { --sc: var(--vscode-terminal-ansiBrightBlack, #666666); }
  .c4 { --sc: var(--vscode-terminal-ansiBrightMagenta, #d670d6); } .c5 { --sc: var(--vscode-terminal-ansiBrightYellow, #f5f543); } .c6 { --sc: var(--vscode-terminal-ansiBrightCyan, #29b8db); } .c7 { --sc: var(--vscode-terminal-ansiBrightBlue, #3b8eea); }
  .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; background: var(--sc, transparent); vertical-align: 0; }
  .said .it[class*=" c"] { border-left: 3px solid var(--sc); }
  .said .wl { cursor: pointer; }
  .said .wl:hover { text-decoration: underline; color: var(--vscode-textLink-foreground); }
  .pager { display: flex; align-items: center; gap: 6px; margin: 8px 0; }
  .pager .muted { margin: 0 6px; }
  .syncbox { margin: 10px 0 4px; padding: 8px 14px; border-radius: 4px; border: 1px dashed var(--vscode-textLink-foreground); }
  .syncbox ul { margin: 4px 0 8px; padding-left: 20px; }
  .syncbox .srow { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .leadcard { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0 4px; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--vscode-charts-yellow, #cca700); background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 10%, transparent); }
  .leadcard .crown { color: var(--vscode-charts-yellow, #cca700); }
  .leadcard .ltitle { font-weight: 600; font-size: 14px; }
  .leadcard .lsub { flex-basis: 100%; font-size: 12px; }
  .leadtag { display: inline-flex; align-items: center; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 3px; font-weight: 600; color: var(--vscode-editor-background); background: var(--vscode-charts-yellow, #cca700); white-space: nowrap; }
  .setup { margin: 10px 0 4px; padding: 8px 14px; border-radius: 4px; border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,.5)); }
  .setup ol { margin: 6px 0 2px; padding-left: 20px; }
  .setup li { margin: 2px 0; }
  .setup li.done { color: var(--vscode-descriptionForeground); }
  .memo { margin-top: 6px; padding: 4px 16px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); border-radius: 4px; max-height: 70vh; overflow: auto; }
  .memo table { width: auto; }
  .memo td, .memo th { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); }
  .memo pre { white-space: pre-wrap; }
  .memo a { color: var(--vscode-textLink-foreground); }
</style></head><body>
<div id="root"></div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let S = {};
  let roots = [];
  const crown = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:3px"><path d="M1.5 4.5 5 8l3-5 3 5 3.5-3.5L13 12.5H3z"/><rect x="3" y="13.2" width="10" height="1.6" rx=".5"/></svg>';
  // 작업 폴더 안 파일은 그 폴더 기준 경로로 짧게 보여 준다(전체 경로는 마우스 설명)
  const rel = (f) => { for (const r of roots) if (f.startsWith(r + '/') || f.startsWith(r + '\\\\')) return f.slice(r.length + 1); return f; };
  function render(p) {
    S = p.strings || {};
    roots = p.roots || [];
    if (p.gone) { root.innerHTML = '<p class="muted">' + esc(S.gone) + '</p>'; return; }
    let h = '<h1>' + esc(p.name) + '</h1>'
      + '<div class="bar"><button data-act="add">' + esc(S.addSessions) + '</button><button data-act="planTeam" title="' + esc(S.planTip) + '">' + esc(S.plan) + '</button><button data-act="copyBoard">' + esc(S.copyBoard) + '</button><button data-act="refresh">' + esc(S.refresh) + '</button></div>';
    // 대장 칸: 사용자는 대장하고만 이야기하면 된다
    if (p.lead) {
      h += '<div class="leadcard"><span class="crown">' + crown + '</span><b>' + esc(S.leadName) + '</b><span class="sw c' + (p.lead.color >= 0 ? p.lead.color : '') + '"></span>'
        + '<span class="ltitle">' + esc(p.lead.title) + '</span><span class="dot ' + esc(p.lead.state) + '"></span><span class="muted">' + esc(p.lead.stateLabel) + '</span>'
        + (p.lead.canOpen ? '<button data-act="open" data-sid="' + esc(p.lead.sid) + '">' + esc(S.open) + '</button>' : '') + '<div class="muted lsub">' + esc(S.leadCard) + '</div></div>';
    } else if (p.members.length) h += '<div class="muted" style="margin:8px 0">' + esc(S.noLead) + '</div>';
    // 0. 시작하기: 세션·역할·메모가 갖춰질 때까지 순서를 보여 준다
    const su = p.setup || {};
    if (!su.members || su.roles < su.members || !su.memo) {
      const step = (done, text) => '<li class="' + (done ? 'done' : '') + '">' + (done ? '✓ ' : '') + esc(text) + '</li>';
      h += '<div class="setup"><b>' + esc(S.setupTitle) + '</b><ol>'
        + step(su.members > 0, String(S.setup1 || '').replace('{0}', su.members || 0))
        + step(su.members > 0 && su.roles >= su.members, String(S.setup2 || '').replace('{0}', su.roles || 0).replace('{1}', su.members || 0))
        + step(!!su.memo, S.setup3) + step(false, S.setup4) + '</ol><div class="muted">' + esc(S.setupPlan) + '</div></div>';
    }
    // 1. 기다리는 것
    h += '<h2>' + esc(S.waiting) + (p.waiting.length ? '<span class="count">' + p.waiting.length + '</span>' : '') + '</h2>';
    if (!p.waiting.length) h += '<div class="muted">' + esc(S.noneWaiting) + '</div>';
    for (const w of p.waiting) {
      h += '<div class="wait"><span class="t">' + esc(w.title) + '</span>' + (w.role ? '<span class="role">' + esc(w.role) + '</span>' : '')
        + '<span>' + esc(w.what) + '</span><span class="d" title="' + esc(w.detail) + '">' + esc(w.detail) + '</span><span class="muted">' + esc(w.since) + '</span>'
        + '<button data-act="open" data-sid="' + esc(w.sid) + '">' + esc(S.open) + '</button></div>';
    }
    // 보드와 그룹 맞추기
    if (p.sync) {
      const bo = p.sync.boardOnly, go = p.sync.groupOnly;
      h += '<div class="syncbox" title="' + esc(S.syncTip) + '"><b>' + esc(S.syncTitle) + '</b>';
      if (bo.length) {
        h += '<div class="srow"><span class="muted">' + esc(S.boardOnly) + ' (' + bo.length + ')</span>' + (bo.some((x) => x.sid) ? '<button data-act="addFromBoard">' + esc(S.addAll) + '</button>' : '') + '</div><ul>'
          + bo.map((x) => '<li><b>' + esc(x.name) + '</b> <span class="muted">— ' + esc(x.role) + (x.inGroup ? ' · ' + esc(String(S.inOther || '').replace('{0}', x.inGroup)) : '') + '</span> '
            + (x.sid ? '<button class="link" data-act="addFromBoard" data-sid="' + esc(x.sid) + '">' + esc(S.addToThis) + '</button>' : '<span class="muted">(' + esc(S.notFound) + ')</span>') + '</li>').join('') + '</ul>';
      }
      if (go.length) h += '<div class="srow"><span class="muted">' + esc(S.groupOnly) + ' (' + go.length + ')</span></div><ul>' + go.map((x) => '<li><b>' + esc(x.title) + '</b>' + (x.role ? ' <span class="muted">— ' + esc(x.role) + '</span>' : '') + '</li>').join('') + '</ul>';
      h += '<button data-act="copyBoardSync">' + esc(S.copySync) + '</button></div>';
    }
    // 고정 역할(대장·배포)이 겹치면 경고
    for (const w of p.warnings || []) h += '<div class="warnbox"><b>⚠ ' + esc(w) + '</b></div>';
    // 2. 세션 현황
    h += '<h2>' + esc(S.sessions) + '<span class="count">' + p.members.length + '</span></h2>';
    if (!p.members.length) h += '<div class="muted">' + esc(S.empty) + '</div>';
    else {
      h += '<table><thead><tr><th>' + esc(S.role) + '</th><th>' + esc(S.session) + '</th><th>' + esc(S.state) + '</th><th>' + esc(S.now) + '</th><th class="num">' + esc(S.changed) + '</th><th class="num">' + esc(S.uncommitted) + '</th><th class="num">' + esc(S.commits) + '</th><th>' + esc(S.last) + '</th><th></th></tr></thead><tbody>';
      for (const r of p.members) {
        const tip = r.folder ? String(S.otherFolder || '').replace('{0}', r.folder) : S.open;
        h += '<tr class="sess">'
          + '<td>' + (r.lead ? '<span class="leadtag" title="' + esc(S.leadTip) + '">' + crown + esc(S.leadName) + '</span> ' : '')
          + (r.lead && !r.role ? '' : '<span class="role' + (r.role ? '' : ' none') + (r.roleFromBoard ? ' board' : '') + '" data-act="role" data-sid="' + esc(r.sid) + '" title="' + esc(r.roleFromBoard ? S.roleFromBoard : S.setRole) + '">' + esc(r.role || '+') + '</span>') + '</td>'
          + '<td><span class="sw c' + (r.color >= 0 ? r.color : '') + '"></span><span class="title' + (r.canOpen ? '' : ' other') + '"' + (r.canOpen ? ' data-act="open" data-sid="' + esc(r.sid) + '"' : '') + ' title="' + esc(tip) + '">' + esc(r.title) + '</span>' + (r.folder ? ' <span class="muted">· ' + esc(r.folder) + '</span>' : '') + '</td>'
          + '<td><span class="dot ' + esc(r.state) + '"></span>' + esc(r.stateLabel) + '</td>'
          + '<td class="now ' + esc(r.state) + '">' + esc(r.now || '') + '</td>'
          + '<td class="num">' + (r.files ? r.files + ' <span class="a">+' + r.add + '</span> <span class="r">−' + r.del + '</span>' : '') + '</td>'
          + '<td class="num">' + (r.uncommitted && r.uncommitted.length ? '<span class="unc" title="' + esc(r.uncommitted.join('\\n')) + '">' + r.uncommitted.length + '</span>' : '') + '</td>'
          + '<td class="num">' + (r.commits || '') + '</td>'
          + '<td class="muted" style="white-space:nowrap">' + esc(r.last || '') + '</td>'
          + '<td style="white-space:nowrap">' + (r.missing ? '' : '<button class="link" data-act="brief" data-sid="' + esc(r.sid) + '" title="' + esc(S.roleNoteTip) + '">' + esc(S.roleNote) + '</button>')
          + '<button class="link" data-act="remove" data-sid="' + esc(r.sid) + '" title="' + esc(S.remove) + '">✕</button></td></tr>';
      }
      h += '</tbody></table>';
    }
    // 3. 세션 기록으로 설명되지 않는 커밋 전 변경
    if (p.unknown.length) {
      h += '<div class="warnbox" title="' + esc(S.unknownTip) + '"><b>⚠ ' + esc(String(S.unknownTitle || '').replace('{0}', p.span)) + ' · ' + (p.unknown.length + p.unknownMore) + '</b>'
        + '<ul class="paths">' + p.unknown.map((f) => '<li><code title="' + esc(f) + '">' + esc(rel(f)) + '</code></li>').join('') + '</ul></div>';
    }
    // 4. 내가 한 말
    h += '<h2 title="' + esc(S.saidTip) + '">' + esc(S.said) + (p.saidTotal ? '<span class="count">' + p.saidTotal + '</span>' : '') + '</h2>';
    if (p.saidBusy && !p.said.length) h += '<div class="muted">' + esc(S.saidBusy) + '</div>';
    else if (!p.said.length) h += '<div class="muted">' + esc(S.saidNone) + '</div>';
    else {
      h += '<div class="said">';
      p.said.forEach((x, i) => {
        const who = x.titles.join(', ');
        const many = x.replies.length > 1;
        const rep = x.replies.map((r) => (many ? '<b>' + esc(r.title) + ':</b> ' : '') + (r.reply ? esc(r.reply) : esc(S.noReply))).join('<br>');
        // 세션 이름을 누르면 그 세션을 연다(줄의 다른 곳을 누르면 펼치기). 여러 세션에 보낸 말은 이름마다 따로
        const names = x.titles.map((t, k) => '<span class="wl" data-act="open" data-sid="' + esc(x.sids[k]) + '" title="' + esc(S.openTip) + '"><span class="sw c' + (x.colors && x.colors[k] >= 0 ? x.colors[k] : '') + '"></span>' + esc(t) + '</span>').join(', ');
        const c0 = x.colors && x.colors[0] >= 0 ? ' c' + x.colors[0] : '';
        h += '<div class="it' + c0 + (opened.has(x.ts + '|' + x.text) ? ' open' : '') + '" data-key="' + esc(x.ts + '|' + x.text) + '" title="' + esc(S.moreTip) + '"><span class="ts">' + esc(x.stamp) + '</span><span class="who" title="' + esc(who) + '">' + names + '</span>'
          + '<span class="txt">' + esc(x.text) + '</span>'
          + '<span class="rep">→ ' + rep + '</span></div>';
      });
      h += '</div>';
      const from = p.saidPage * p.saidSize + 1;
      const to = Math.min(p.saidTotal, from + p.said.length - 1);
      h += '<div class="pager">'
        + (p.saidPages > 1 ? '<button data-act="saidPage" data-dir="first"' + (p.saidPage ? '' : ' disabled') + '>' + esc(S.first) + '</button><button data-act="saidPage" data-dir="prev"' + (p.saidPage ? '' : ' disabled') + '>‹ ' + esc(S.prev) + '</button>' : '')
        + '<span class="muted">' + esc(String(S.range || '').replace('{0}', from).replace('{1}', to).replace('{2}', p.saidTotal)) + '</span>'
        + (p.saidPages > 1 ? '<button data-act="saidPage" data-dir="next"' + (p.saidPage < p.saidPages - 1 ? '' : ' disabled') + '>' + esc(S.next) + ' ›</button>' : '')
        + '<button class="link" data-act="pageSetting">' + esc(String(S.perPage || '').replace('{0}', p.saidSize)) + '</button></div>';
    }
    // 5. 공유 메모
    h += '<h2>' + esc(S.memo) + (p.memo.name ? ' · <span style="text-transform:none;letter-spacing:0">' + esc(p.memo.name) + '</span>' : '') + '</h2>';
    if (!p.memo.file) h += '<div class="muted">' + esc(S.memoNone) + '</div><div class="bar"><button data-act="linkMemo">' + esc(S.linkMemo) + '</button><button data-act="newMemo">' + esc(S.newMemo) + '</button></div>';
    else {
      h += '<div class="bar"><button data-act="openMemo">' + esc(S.openMemo) + '</button><button data-act="linkMemo">' + esc(S.linkMemo) + '</button><button data-act="unlinkMemo">' + esc(S.unlinkMemo) + '</button><span class="muted" style="align-self:center" title="' + esc(p.memo.file) + '">' + esc(p.memo.shown || p.memo.file) + '</span></div>';
      h += p.memo.error ? '<div class="muted">' + esc(p.memo.error) + '</div>' : '<div class="memo">' + p.memo.html + '</div>';
    }
    root.innerHTML = h;
  }
  const opened = new Set();
  root.addEventListener('click', (e) => {
    const it = e.target.closest('.said .it');
    if (it && !e.target.closest('[data-act]')) {
      const k = it.dataset.key;
      if (opened.has(k)) opened.delete(k); else opened.add(k);
      it.classList.toggle('open', opened.has(k));
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    e.preventDefault();
    vscode.postMessage({ type: el.dataset.act, sid: el.dataset.sid, dir: el.dataset.dir, i: el.dataset.i === undefined ? undefined : Number(el.dataset.i) });
  });
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'render') render(e.data.payload); });
  vscode.postMessage({ type: 'ready' });
})();
</script></body></html>`;
}

function folderKey(s) {
  return s.project || L('Unknown folder');
}

function groupDescription(items, withFiles) {
  const n = countStates(items);
  const parts = [n.busy && L('working {0}', n.busy), n.waiting && L('waiting {0}', n.waiting), n.idle && L('idle {0}', n.idle), n.off && L('off {0}', n.off)];
  if (withFiles) parts.push(L('{0} files', items.reduce((a, s) => a + (s.files ? s.files.length : 0), 0)));
  return parts.filter(Boolean).join(' · ');
}

function groupIcon(items) {
  const n = countStates(items);
  return n.waiting
    ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.blue'))
    : new vscode.ThemeIcon('folder', n.busy ? new vscode.ThemeColor('charts.green') : undefined);
}

function countStates(list) {
  const n = { busy: 0, waiting: 0, idle: 0, off: 0 };
  for (const s of list) {
    if (!s.alive) n.off++;
    else if (s.status === 'busy') n.busy++;
    else if (s.status === 'waiting') n.waiting++;
    else if (s.status === 'idle') n.idle++;
  }
  return n;
}

function rebuildSessions() {
  // Claude 세션 목록과 같은 순서: 마지막 대화가 최근인 것부터
  const archive = loadArchive();
  const sorted = [...raw].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  const days = autoArchiveDays();
  // 다른 폴더 세션은 실행 중이거나, 최근(그 폴더 창의 목록에 남아 있을 날 수 안)에 대화했거나, 보는 기간 안에 변경이 있을 때만 보여 준다.
  // (대화는 오래전에 끝났는데 기록 파일만 오늘 건드려진 세션이 끼어들지 않게)
  const since = Math.min(Date.now() - cfg().lookbackHours * 3600000, Date.now() - otherListDays() * DAY_MS);
  const withFiles = new Set(model.filter((m) => m.files.length || m.unresolved.length).map((m) => m.sid));
  // 제목도 첫 질문도 없는 세션(화면에는 ID 글자로만 보임)은 실행 중이거나 바꾼 파일이 있을 때만 보여 준다
  const blank = (s) => s.titleSource === 'id' && !s.alive && !withFiles.has(s.sid);
  const listed = sorted.filter((s) => !blank(s) && (inWorkspace(s) || s.alive || s.lastActivity >= since || withFiles.has(s.sid)));
  // 날 수로 보관함에 보내는 것은 이 폴더 세션만(Claude Code 목록과 같은 범위). 직접 보관은 어느 폴더든 된다
  const hidden = new Set(listed.filter((s) => archiveReason(s, archive, inWorkspace(s) ? days : 0)).map((s) => s.sid));
  sessionsModel = listed.filter((s) => !hidden.has(s.sid));
  // 다른 폴더 세션도 보관함에 보여 준다(안 보이면 이 창에서 다시 꺼낼 방법이 없다)
  archivedModel = listed.filter((s) => hidden.has(s.sid));
  const shown = sessionsModel;
  const n = countStates(shown.filter(inWorkspace));
  const all = countStates(shown);
  if (sessionsView) {
    sessionsView.description = L('Working {0} · Waiting {1} · Idle {2}', n.busy, n.waiting, n.idle);
    const otherWaiting = all.waiting - n.waiting;
    sessionsView.badge = all.waiting
      ? { value: all.waiting, tooltip: L('{0} session(s) waiting for you', all.waiting) + (otherWaiting ? ' ' + L('({0} in other folders)', otherWaiting) : '') }
      : undefined;
  }
  sessionsWebview.post();
  refreshBoards();
}

class Provider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }

  fire() {
    lastFire = Date.now();
    this._em.fire();
  }

  getParent(el) {
    if (el.t === 'file' || el.t === 'unresolved') return { t: 'session', s: el.s };
    if (el.t === 'change') return { t: 'file', s: el.s, f: el.f };
    if (el.t === 'session' && !inWorkspace(el.s)) {
      const key = folderKey(el.s);
      return { t: 'cgroup', key, items: model.filter((x) => !inWorkspace(x) && folderKey(x) === key) };
    }
    return undefined;
  }

  getChildren(el) {
    if (!el) {
      if (lastError && !loaded) return [{ t: 'info', label: L('Read error'), detail: lastError }];
      if (!loaded) return [{ t: 'info', label: L('Reading conversation logs…') }];
      if (!model.length) return [{ t: 'info', label: aliveOnly ? L('No open sessions') : L('No files changed in the last {0}', spanShort(cfg().lookbackHours)) }];
      const { mine, groups } = splitByFolder(model);
      const out = mine.map((s) => ({ t: 'session', s }));
      if (!mine.length) out.push({ t: 'info', label: L('No sessions in this folder') });
      for (const [key, items] of groups) out.push({ t: 'cgroup', key, items });
      return out;
    }
    if (el.t === 'cgroup') {
      return el.items.map((s) => ({ t: 'session', s }));
    }
    if (el.t === 'session') {
      const kids = el.s.files.map((f) => ({ t: 'file', s: el.s, f }));
      for (const c of el.s.unresolved) kids.push({ t: 'unresolved', s: el.s, c });
      if (!kids.length) kids.push({ t: 'info', label: L('No changed files yet'), key: el.s.sid });
      return kids;
    }
    if (el.t === 'file') return el.f.changes.map((c, i) => ({ t: 'change', s: el.s, f: el.f, c, i }));
    return [];
  }

  getTreeItem(el) {
    const N = vscode.TreeItemCollapsibleState;
    if (el.t === 'cgroup') {
      const it = new vscode.TreeItem(el.key, N.Collapsed);
      it.id = 'cg:' + el.key;
      it.description = groupDescription(el.items, true);
      it.iconPath = groupIcon(el.items);
      it.tooltip = L('{0} session(s) from another folder ({1}). Expand to see them.\nConversations can only be opened from a VS Code window with that folder open.', el.items.length, el.key);
      it.contextValue = 'sessionGroup';
      return it;
    }
    if (el.t === 'info') {
      const it = new vscode.TreeItem(el.label, N.None);
      it.id = 'i:' + (el.key || '') + el.label;
      if (el.detail) it.tooltip = el.detail;
      return it;
    }
    if (el.t === 'session') {
      const s = el.s;
      const it = new vscode.TreeItem(s.title, s.alive && s.files.length ? N.Expanded : N.Collapsed);
      it.id = 's:' + s.sid;
      const st = stateOf(s);
      // 설명은 파일 수 → 시간 순서. 상태는 앞의 그림이 보여 주므로 글자는 사용자가 할 일이 있는 "기다림"일 때만 붙인다(좁은 창에서 덜 잘리게)
      const nFiles = s.files.length === 1 ? L('1 file') : L('{0} files', s.files.length);
      it.description = [s.agent === 'codex' ? 'Codex' : '', st.key === 'waiting' ? st.short : '', nFiles, st.time, st.note || ''].filter(Boolean).join(' · ');
      it.iconPath = st.icon;
      it.tooltip = sessionTooltip(s, st);
      it.contextValue = s.files.length ? 'session' : 'sessionEmpty';
      return it;
    }
    if (el.t === 'file') {
      const { s, f } = el;
      const it = new vscode.TreeItem(path.basename(f.path), N.Collapsed);
      it.id = `f:${s.sid}|${f.path}`;
      it.resourceUri = vscode.Uri.from({ scheme: ITEM_SCHEME, path: f.path, query: f.badge });
      // 지금 고치는 파일은 파일 종류 그림 대신 세션과 같은 표시(작업 중 초록 회전, 승인 대기 파란 종)
      const live = liveState(s, f);
      it.iconPath = live === 'editing' ? new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.green'))
        : live === 'approval' ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.blue'))
        : vscode.ThemeIcon.File;
      const alsoBy = f.overlap ? f.overlap.map((o) => String(o.title).replace(/\s+/g, ' ').slice(0, 24)).join(', ') : '';
      it.description = [alsoBy ? '⚠ ' + L('{0} too', alsoBy) : '', counts(f.add, f.del), fmtTime(f.lastTs), displayDir(f.path, s)].filter(Boolean).join('  ');
      const kinds = [...f.kinds].map((k) => kindText(k)).join(', ');
      it.tooltip = [
        f.path,
        live === 'editing' ? L('Being edited now: this file changed in the last {0} seconds while the session is working.', LIVE_MS / 1000) : null,
        live === 'approval' ? L('Waiting for your approval to edit this file.') : null,
        alsoBy ? L('Another session also changed this file ({0}). Check that the two changes do not clash.', alsoBy) : null,
        L('Changed {0} time(s) in this session ({1})', f.changes.length, kinds),
        f.kinds.has('shell') ? L('Includes changes guessed from shell commands.') : null,
        L("Click: compare before this session's first change ↔ current file on disk"),
      ].filter(Boolean).join('\n');
      it.command = { command: 'claudeSessionChanges.openFileDiff', title: L('Compare'), arguments: [el] };
      it.contextValue = 'file';
      return it;
    }
    if (el.t === 'change') {
      const { c } = el;
      const it = new vscode.TreeItem(fmtTime(c.ts, true), N.None);
      it.id = `c:${el.s.sid}|${el.f.path}|${el.i}`;
      let desc;
      let icon;
      if (c.kind === 'edit') {
        desc = [counts(c.add, c.del), c.tool === 'Write' ? (c.created ? L('created') : L('rewritten')) : L('edited')].filter(Boolean).join(' · ');
        icon = new vscode.ThemeIcon('edit');
      } else if (c.kind === 'bash') {
        desc = [counts(c.add, c.del), L('shell command')].filter(Boolean).join(' · ');
        icon = new vscode.ThemeIcon('terminal');
      } else if (c.kind === 'shell') {
        desc = L('shell command (guessed)');
        icon = new vscode.ThemeIcon('terminal', new vscode.ThemeColor('disabledForeground'));
      } else if (c.kind === 'cxedit') {
        desc = [counts(c.add, c.del), c.created ? L('created') : c.deleted ? L('deleted') : L('Codex edit')].filter(Boolean).join(' · ');
        icon = new vscode.ThemeIcon('edit');
      } else {
        desc = [counts(c.add, c.del), L('commit {0}', String(c.sha || '').slice(0, 8)), c.msg].filter(Boolean).join(' · ');
        icon = new vscode.ThemeIcon('git-commit');
      }
      if (c.sub) desc += ' · ' + L('subagent');
      it.description = desc;
      it.iconPath = icon;
      it.tooltip = c.cmd ? L('Command: {0}', c.cmd) : c.msg ? L('Commit: {0}', c.msg) : undefined;
      it.command = { command: 'claudeSessionChanges.openChangeDiff', title: L('Show'), arguments: [el] };
      it.contextValue = 'change';
      return it;
    }
    const c = el.c;
    const it = new vscode.TreeItem(L('commit {0}', String(c.sha || '').slice(0, 8)), N.None);
    it.id = `u:${el.s.sid}|${c.sha}|${c.ts}`;
    it.description = `${L('could not read file list')} · ${fmtTime(c.ts)}`;
    it.tooltip = c.msg || undefined;
    it.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('disabledForeground'));
    return it;
  }
}

const provider = new Provider();

// 맨 위 "세션 상태" 창: 트리 대신 웹뷰로 그려 Claude 세션 목록처럼 큰 줄로 보여 준다.
// ---------- 지금 탭에 띄워 둔 Claude 대화 ----------
// 탭 묶음마다 앞에 보이는 탭(isActive)만 센다. 뒤에 깔린 탭까지 칠하면 거의 모든 줄이 칠해져 구별이 안 된다(11-12 사용자 지적).
// Claude Code는 대화 탭(웹뷰 claudeVSCodePanel)에 세션 이름을 붙인다: 25자를 넘으면 앞 24자 + "…", 이름이 없으면 "Claude Code"(2.1.322 기준).
// 탭에는 세션 ID가 없어서 이름으로 맞춘다. 같은 이름이 여럿이면 실행 중인 세션을, 그것도 없으면 가장 최근 세션을 고른다.
const CLAUDE_PANEL_RE = /claudeVSCodePanel$/;
function claudeTabLabels() {
  const out = [];
  const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
  for (const g of groups) {
    for (const t of g.tabs || []) {
      if (t && t.isActive && t.input && typeof t.input.viewType === 'string' && CLAUDE_PANEL_RE.test(t.input.viewType) && t.label && t.label !== 'Claude Code') out.push(String(t.label));
    }
  }
  return out;
}

const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function tabLabelMatches(title, label) {
  const a = oneLine(title);
  const b = oneLine(label);
  if (!a || !b) return false;
  if (a === b) return true;
  return b.length > 1 && b.endsWith('…') && a.startsWith(b.slice(0, -1)); // Claude Code가 줄인 이름
}

function openTabSids(list) {
  const out = new Set();
  for (const label of claudeTabLabels()) {
    const hits = list.filter((s) => s.agent !== 'codex' && inWorkspace(s) && tabLabelMatches(s.title, label));
    if (!hits.length) continue;
    const alive = hits.filter((s) => s.alive);
    if (alive.length) for (const s of alive) out.add(s.sid);
    else out.add(hits.reduce((a, b) => ((b.lastActivity || 0) > (a.lastActivity || 0) ? b : a)).sid);
  }
  return out;
}

// 앞에 보이는 Claude 탭이 바뀌면(탭 전환·열기·닫기·이름 바뀜) 세션 창을 다시 그린다. 다른 탭 변화에는 그리지 않는다
let tabKey = '';
let tabTimer = null;
function onTabsChanged() {
  if (tabTimer) return;
  tabTimer = setTimeout(() => {
    tabTimer = null;
    const k = claudeTabLabels().sort().join('\n');
    if (k === tabKey) return;
    tabKey = k;
    sessionsWebview.post();
  }, 150);
  if (tabTimer.unref) tabTimer.unref();
}

function sessionRow(s, tabs, team) {
  const st = stateOf(s);
  const codex = s.agent === 'codex';
  const canOpen = codex ? UUID_RE.test(codexId(s.sid)) : inWorkspace(s);
  const hint = codex
    ? L('Codex session · Click: continue it in a terminal (codex resume) · Buttons on the right: changed files / review all changes')
    : canOpen
      ? L('Click: open the Claude conversation · Buttons on the right: changed files / review all changes')
      : L('Session from another folder ({0}): open it from a VS Code window with that folder · Buttons on the right: changed files / review all changes', s.project);
  // 제목이 잘리지 않게 오른쪽에는 시간만(상태는 점 색). 사용자가 해야 할 일이 있는 "기다림"만 글자도 붙인다.
  const meta = st.key === 'waiting' ? [st.short, st.time].filter(Boolean).join(' · ') : st.time;
  const m = model.find((x) => x.sid === s.sid);
  const add = m ? m.files.reduce((a, f) => a + (f.add || 0), 0) : 0;
  const del = m ? m.files.reduce((a, f) => a + (f.del || 0), 0) : 0;
  const tab = !!(tabs && tabs.has(s.sid));
  const eff = team && team.members[s.sid] ? (teamRolesCache.get(team.id) || effectiveRoles(team)).get(s.sid) : null;
  const lead = !!(eff && eff.lead);
  const role = eff ? eff.extra : '';
  const roleFromBoard = !!(eff && eff.extraSource === 'board');
  return {
    team: team ? team.id : '', role, roleFromBoard, lead,
    sid: s.sid, title: s.title, state: st.key, meta, tip: (tab ? L('Shown in a tab right now') + '\n' : '') + sessionTooltip(s, st) + '\n' + hint, canOpen, alive: !!s.alive, codex, tab,
    files: m ? m.files.length : 0, add, del, now: [subText(s, st), nowText(s, st)].filter(Boolean).join(' · '), folder: inWorkspace(s) ? '' : s.project || '', worktree: s.worktree || '',
    overlap: m ? m.files.filter((f) => f.overlap).length : 0,
  };
}

function sessionsPayload() {
  const strings = {
    showChanges: L('Show changed files'), review: L('Review all changes'), newSession: L('New session'), active: L('Open'),
    // "열린 세션" = 지금 프로세스가 떠 있는 세션(작업 중·기다림·쉼). 작업 중인 것만 세는 숫자가 아니다
    // 숫자는 화면 쪽에서 채운다 → 자리표시자를 그대로 넘겨 번역 함수가 건드리지 않게 한다
    activeTip: L('Show only sessions that are open right now (working, waiting or idle). The number counts this folder: {0}. Other folders: {1}.', '{0}', '{1}'),
    search: L('Search sessions'), noMatch: L('No matching sessions'), legend: L('What the colors mean'),
    archive: L('Archive'), unarchive: L('Restore from archive'), archivedTitle: L('Archived'), archiveRule: L('Choose when sessions move to Archived'),
    loadChanges: L("Load this session's changed files"),
    rename: L('Rename session'),
    overlapTip: L('{0} file(s) here were also changed by another session', '{0}'),
    searchInside: L('Press Enter to search inside conversations'),
    otherFolders: L('Other folders'), worktreeTip: L('Runs in a git worktree: {0}', '{0}'),
    lgSessions: L('Sessions'), lgFiles: L('Changed files'), lgRow: L('Under each session'),
    lgBusy: L('Working'), lgWaiting: L('Waiting for you (approval or answer)'), lgDone: L('Just finished (less than 10 minutes ago)'), lgIdle: L('Idle'), lgOff: L('Off (no Claude process)'),
    lgA: L('Created in this session'), lgM: L('Modified in this session'), lgD: L('Not on disk anymore (deleted)'), lgQ: L('Guessed from shell commands (not certain)'),
    lgTab: L('Shown in a tab right now'),
    thisFolder: L('This folder'), leadName: isKo() ? '대장' : 'Lead', leadTip: L('Lead of this group: takes the reports and gives the instructions'), roleFromBoard: L('Role from the team board (the lead changes it there)'), addToGroup: L('Put in a group'), removeFromGroup: L('Remove from group'), setRole: L('Set role'),
    openBoard: L('Open the group board'), renameGroup: L('Rename group'), deleteGroup: L('Delete group'),
    teamEmpty: L('No sessions yet: use the group button on a session row'), teamTip: L('Group: {0} session(s). The board shows them all in one place.', '{0}'),
    lgNow: L('What it is doing now'), lgDiff: L('Lines added / removed within the time range of the Changed files view'),
    // 변경 규모는 변경 파일 창의 "보는 기간" 안에서, 고칠 때마다 더한 합계(같은 줄을 여러 번 고치면 여러 번 셈)
    diffTip: L('Last {0}: {1} lines added, {2} removed (each edit counted)', spanLong(cfg().lookbackHours), '{1}', '{2}'),
  };
  if (!loaded) return { message: lastError ? L('Read error') : L('Reading sessions…'), detail: lastError || '', strings };
  if (!sessionsModel.length && !archivedModel.length) return { message: L('No sessions in the last {0}', spanShort(cfg().lookbackHours)), strings };
  const { mine, groups } = splitByFolder(sessionsModel);
  const tabs = openTabSids(sessionsModel.concat(archivedModel));
  tabKey = claudeTabLabels().sort().join('\n');
  const rowOf = (s) => sessionRow(s, tabs);
  // 사용자가 만든 그룹: 맨 위에 묶어 보여 주고, 그 세션은 폴더 칸·보관함에서 뺀다(한 세션은 한 곳에만)
  const teamList = loadGroups().groups;
  groupsRendered = groupsMemo.mtimeMs;
  const teamOf = new Map();
  for (const g of teamList) for (const sid of Object.keys(g.members)) teamOf.set(sid, g);
  teamRolesCache.clear();
  boardsRendered.clear();
  for (const g of teamList) {
    if (g.memo) boardsRendered.set(g.memo, memoMtime(g.memo));
    teamRolesCache.set(g.id, effectiveRoles(g));
  }
  const all = sessionsModel.concat(archivedModel);
  const free = (s) => !teamOf.has(s.sid);
  const teams = teamList.map((g) => {
    const items = all.filter((s) => teamOf.get(s.sid) === g);
    return {
      id: g.id, name: g.name, desc: groupDescription(items, false), waiting: items.some((s) => s.alive && s.status === 'waiting'),
      total: Object.keys(g.members).length, rows: items.map((s) => sessionRow(s, tabs, g)).sort((a, b) => Number(b.lead) - Number(a.lead)), // 대장을 맨 위에
    };
  });
  const folderGroups = groups.map(([key, items]) => [key, items.filter(free)]).filter(([, items]) => items.length);
  return {
    teams,
    strings,
    compact: !cfg().sessionDetails,
    reading: stillReading ? L('Reading more logs…') : '',
    archived: archivedModel.filter(free).map(rowOf),
    archivedTip: autoArchiveDays() <= 0 ? L('Sessions you archived here.')
      : followsClaudeArchive()
        ? L('Sessions with no conversation for {0} day(s) (the Claude Code setting "Archive Inactive Sessions") and sessions you archived here.', autoArchiveDays())
        : L('Sessions with no conversation for {0} day(s) and sessions you archived here.', autoArchiveDays()),
    // 단추의 숫자는 이 폴더에서 열려 있는 세션 수(머리말의 작업·멈춤·쉼 합과 같다). 다른 폴더는 설명에만 적는다
    openHere: mine.filter((s) => s.alive).length,
    openElsewhere: groups.reduce((n, [, items]) => n + items.filter((s) => s.alive).length, 0),
    mine: mine.filter(free).map(rowOf),
    noneHere: mine.filter(free).length || teams.length ? '' : L('No sessions in this folder'),
    groups: folderGroups.map(([key, items]) => ({
      key,
      desc: groupDescription(items, false),
      waiting: items.some((s) => s.alive && s.status === 'waiting'),
      tip: L('{0} session(s) from another folder ({1}). Expand to see them.\nConversations can only be opened from a VS Code window with that folder open.', items.length, key),
      rows: items.map(rowOf),
    })),
  };
}

function nonce() {
  let s = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

class SessionsWebview {
  constructor() {
    this.view = undefined;
    this.ready = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    sessionsView = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = sessionsHtml(view.webview);
    view.webview.onDidReceiveMessage((m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') { this.ready = true; rebuildSessions(); }
      else if (m.type === 'open' && typeof m.sid === 'string') openClaudeSession(m.sid);
      else if (m.type === 'reveal' && typeof m.sid === 'string') revealSession(m.sid);
      else if (m.type === 'new') newClaudeSession();
      else if (m.type === 'review' && typeof m.sid === 'string') openSessionChanges(m.sid);
      else if (m.type === 'archive' && typeof m.sid === 'string') setArchived(m.sid, true);
      else if (m.type === 'unarchive' && typeof m.sid === 'string') setArchived(m.sid, false);
      else if (m.type === 'pickArchive') pickArchiveAfter();
      else if (m.type === 'rename' && typeof m.sid === 'string') renameSession(m.sid);
      else if (m.type === 'searchText' && typeof m.q === 'string') searchConversations(m.q);
      else if (m.type === 'group' && typeof m.sid === 'string') addToGroup(m.sid);
      else if (m.type === 'ungroup' && typeof m.sid === 'string') removeFromGroup(m.sid);
      else if (m.type === 'role' && typeof m.sid === 'string') setSessionRole(m.sid);
      else if (m.type === 'board' && typeof m.team === 'string') openGroupBoard(m.team);
      else if (m.type === 'renameGroup' && typeof m.team === 'string') renameGroup(m.team);
      else if (m.type === 'deleteGroup' && typeof m.team === 'string') deleteGroup(m.team);
    });
    view.onDidChangeVisibility(() => { if (view.visible) { requestScan(false); this.post(); } });
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; sessionsView = null; this.ready = false; } });
    requestScan(!loaded);
  }

  post() {
    if (!this.view || !this.ready) return;
    this.view.webview.postMessage({ type: 'render', payload: sessionsPayload() });
  }
}

const sessionsWebview = new SessionsWebview();

function sessionsHtml(webview) {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="${isKo() ? 'ko' : 'en'}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 4px 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; }
  .row { display: block; padding: 0 8px 0 16px; cursor: pointer; outline: none; }
  .l1 { display: flex; align-items: center; gap: 10px; min-height: 30px; font-size: 13.5px; }
  .sub { display: flex; align-items: center; gap: 8px; margin: -6px 0 0 19px; padding-bottom: 6px; min-height: 15px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
  .now { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .now.busy { color: var(--vscode-charts-green); }
  .now.waiting { color: var(--vscode-charts-blue); }
  .ds { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
  .ds .a { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .ds .d { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .sq { display: inline-flex; gap: 1px; }
  .sq i { display: inline-block; width: 6px; height: 6px; border-radius: 1px; background: var(--vscode-descriptionForeground); opacity: 0.3; }
  .sq i.a { background: var(--vscode-gitDecoration-addedResourceForeground); opacity: 1; }
  .sq i.d { background: var(--vscode-gitDecoration-deletedResourceForeground); opacity: 1; }
  .legend { display: none; margin: 0 10px 8px; padding: 8px 10px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35))); border-radius: 4px; font-size: 12px; }
  .legend.show { display: block; }
  .legend h4 { margin: 6px 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  .legend h4:first-child { margin-top: 0; }
  .lg { display: flex; align-items: center; gap: 8px; min-height: 20px; }
  .lg .k { width: 16px; display: inline-flex; justify-content: center; flex-shrink: 0; font-weight: 600; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .row.other { cursor: default; }
  /* 지금 탭에 띄워 둔 대화: 옅은 선택 색 바탕 + 왼쪽 막대(상태 색과 겹치지 않는 중립 색) */
  .row.tab, .tabkey { background: var(--vscode-list-inactiveSelectionBackground); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--vscode-foreground) 65%, transparent); }
  .row.tab:hover { background: var(--vscode-list-hoverBackground); }
  .row.tab + .row.tab { margin-top: 2px; } /* 탭으로 열린 줄이 이어져도 한 덩어리로 보이지 않게 */
  .tabkey { display: inline-block; width: 14px; height: 12px; border-radius: 2px; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex-shrink: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  /* 단추는 마우스를 올린 줄에서만 시간 자리에 나온다(평소에는 자리를 차지하지 않아 제목이 덜 잘린다. Claude 세션 목록과 같은 방식) */
  .act { flex-shrink: 0; display: none; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; }
  .row:hover .act, .row:focus-visible .act, .row:has(.act:focus-visible) .act { display: inline-flex; }
  .row:hover .meta, .row:focus-visible .meta, .row:has(.act:focus-visible) .meta { display: none; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground); }
  .sact { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .sact:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .dot { flex-shrink: 0; box-sizing: border-box; width: 9px; height: 9px; border-radius: 50%; }
  .dot.busy { border: 2px solid var(--vscode-charts-green); border-top-color: transparent; animation: spin 0.9s linear infinite; }
  .dot.waiting { background: var(--vscode-charts-blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-charts-blue) 30%, transparent); }
  .dot.done { background: var(--vscode-charts-orange); }
  .dot.idle, .dot.alive { background: var(--vscode-descriptionForeground); opacity: 0.45; }
  .dot.off { border: 1.5px solid var(--vscode-descriptionForeground); opacity: 0.6; }
  details > summary { list-style: none; display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 8px 0 10px; cursor: pointer; font-size: 12.5px; color: var(--vscode-descriptionForeground); outline: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary:hover { background: var(--vscode-list-hoverBackground); }
  details > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .chev { display: inline-block; width: 10px; transition: transform 0.1s; }
  details[open] > summary .chev { transform: rotate(90deg); }
  /* 폴더 묶음 머리줄은 세션 줄과 한눈에 구별되게: 구역 이름 + 폴더 그림 + 작은 글씨 */
  .sect { margin-top: 10px; padding: 9px 10px 3px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25))); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  details.grp > summary { min-height: 26px; font-size: 12px; }
  /* 사용자가 만든 그룹: 폴더 묶음보다 눈에 띄게(조금 큰 글씨, 아래 선) */
  details.team { margin-bottom: 4px; }
  details.team > summary { min-height: 30px; font-size: 12.5px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25))); }
  details.team > summary .gname { opacity: 1; }
  details.team > summary .tacts { display: none; }
  details.team > summary:hover .tacts, details.team > summary:focus-within .tacts { display: inline-flex; }
  .tag.role { color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-textLink-foreground); flex-shrink: 1; min-width: 0; max-width: 7em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l1 .title { min-width: 5.5em; } /* 꼬리표가 많아도 제목이 몇 글자는 보이게 */
  .row .tag.role { min-width: 2.6em; }
  .tag.role.board { border-style: dashed; } /* 보드에서 읽은 역할 */
  /* 대장: 그룹에 하나뿐인 고정 지위라 채운 배지로 눈에 띄게 */
  .tag.lead { flex-shrink: 0; display: inline-flex; align-items: center; font-weight: 600; color: var(--vscode-editor-background); background: var(--vscode-charts-yellow, #cca700); }
  .l1 .meta { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } /* 자리가 모자라면 오른쪽 글자부터 줄인다 */
  details.arch { margin-top: 8px; padding-top: 4px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25))); }
  .gicon { flex-shrink: 0; display: inline-flex; color: var(--vscode-descriptionForeground); }
  .gname { color: var(--vscode-foreground); font-weight: 600; opacity: 0.85; }
  .gcount { flex-shrink: 0; min-width: 18px; padding: 0 6px; font-size: 11px; line-height: 17px; text-align: center; border-radius: 9px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .tag.warn { color: var(--vscode-editorWarning-foreground, #cca700); background: transparent; border: 1px solid var(--vscode-editorWarning-foreground, #cca700); }
  .tag.wt { color: var(--vscode-descriptionForeground); background: transparent; border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35)); }
  .gdesc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bell { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-blue); flex-shrink: 0; }
  details .row { padding-left: 30px; }
  .msg { padding: 8px 16px; color: var(--vscode-descriptionForeground); font-size: 12.5px; }
  .tag { flex-shrink: 0; font-size: 10.5px; line-height: 15px; padding: 0 5px; border-radius: 3px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .row .act + .act { margin-left: -6px; }
  .bar { display: flex; align-items: center; gap: 2px; padding: 2px 8px 6px 8px; }
  .btn { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-foreground); font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
  .btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .btn.new { font-weight: 600; }
  .btn.on { background: var(--vscode-inputOption-activeBackground, rgba(0, 120, 212, 0.3)); color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground)); }
  .btn svg { flex-shrink: 0; }
  .spacer { flex: 1; }
  .search { display: none; padding: 0 10px 6px; }
  .search.show { display: block; }
  .search input { width: 100%; box-sizing: border-box; height: 26px; padding: 0 8px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; font-size: 12.5px; outline: none; }
  .search input:focus { border-color: var(--vscode-focusBorder); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .dot.busy { animation: none; border-top-color: var(--vscode-charts-green); } }
</style></head>
<body>
<div class="bar">
  <button class="btn new" id="btnNew"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg><span id="lblNew"></span></button>
  <span class="spacer"></span>
  <button class="btn" id="btnActive" aria-pressed="false"><svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1 3 9h4.2L6.5 15 13 7H8.8z"/></svg><span id="lblActive"></span></button>
  <button class="btn" id="btnSearch"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg></button>
  <button class="btn" id="btnLegend" aria-pressed="false"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.5"/><circle cx="8" cy="11.6" r=".4" fill="currentColor"/></svg></button>
</div>
<div class="search" id="searchBox"><input id="q" type="text" autocomplete="off" spellcheck="false"></div>
<div class="legend" id="legend"></div>
<div id="root" role="list"></div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || { open: {} };
  const root = document.getElementById('root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.5 4h7M2.5 8h5M2.5 12h3"/><circle cx="11" cy="10.5" r="2.6"/><path d="m13 12.5 1.6 1.6"/></svg>';
  let strings = {};
  let last = null;
  saved.active = !!saved.active;
  saved.q = saved.q || '';
  const btnNew = document.getElementById('btnNew');
  const btnActive = document.getElementById('btnActive');
  const btnSearch = document.getElementById('btnSearch');
  const box = document.getElementById('searchBox');
  const q = document.getElementById('q');
  q.value = saved.q;
  if (saved.searchOpen) box.classList.add('show');
  const save = () => vscode.setState(saved);
  btnNew.addEventListener('click', () => vscode.postMessage({ type: 'new' }));
  btnActive.addEventListener('click', () => { saved.active = !saved.active; save(); if (last) render(last); });
  btnSearch.addEventListener('click', () => {
    saved.searchOpen = !box.classList.contains('show');
    box.classList.toggle('show', saved.searchOpen);
    if (saved.searchOpen) q.focus(); else { q.value = ''; saved.q = ''; if (last) render(last); }
    save();
  });
  q.addEventListener('input', () => { saved.q = q.value; save(); if (last) render(last); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && q.value.trim()) { vscode.postMessage({ type: 'searchText', q: q.value.trim() }); return; } if (e.key === 'Escape') { q.value = ''; saved.q = ''; saved.searchOpen = false; box.classList.remove('show'); save(); if (last) render(last); } });
  const reviewIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4.5 1.5h5l2.5 2.5v6.5h-7.5z"/><path d="M2.5 4v10.5h7"/><path d="M6.5 6h3.5M6.5 8.3h3.5"/></svg>';
  // 변경 규모: +줄 −줄과 다섯 칸 막대(초록=추가, 빨강=삭제 비율)
  function diffstat(add, del) {
    if (!add && !del) return '';
    const tot = add + del;
    const green = Math.round((5 * add) / tot);
    const red = Math.min(5 - green, Math.round((5 * del) / tot));
    let sq = '';
    for (let i = 0; i < 5; i++) sq += '<i class="' + (i < green ? 'a' : i < green + red ? 'd' : '') + '"></i>';
    const tip = String(strings.diffTip || '').replace('{1}', add).replace('{2}', del);
    return '<span class="ds" title="' + esc(tip) + '"><span class="a">+' + add + '</span><span class="d">−' + del + '</span><span class="sq">' + sq + '</span></span>';
  }
  const archiveIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M2 3.5h12v3H2z"/><path d="M3 6.5v6h10v-6"/><path d="M6.5 9h3"/></svg>';
  const restoreIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M3 8.5v4h10v-4"/><path d="M8 10V2.5"/><path d="M5.5 5 8 2.5 10.5 5"/></svg>';
  const folderIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.5 4.5v8h13v-6.5h-6l-1.5-1.5z"/></svg>';
  const pencilIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M11 2.5 13.5 5 5.5 13H3v-2.5z"/><path d="M9.5 4 12 6.5"/></svg>';
  const crownIcon = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:3px;vertical-align:-1px"><path d="M1.5 4.5 5 8l3-5 3 5 3.5-3.5L13 12.5H3z"/><rect x="3" y="13.2" width="10" height="1.6" rx=".5"/></svg>';
  const teamIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="5.5" cy="6" r="2.2"/><circle cx="11" cy="6.5" r="1.8"/><path d="M1.8 13c.4-2.3 1.9-3.6 3.7-3.6s3.3 1.3 3.7 3.6"/><path d="M9.6 10.3c.5-.4 1-.6 1.6-.6 1.4 0 2.5 1 2.9 3"/></svg>';
  const groupAddIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6" cy="6" r="2.3"/><path d="M2 13c.4-2.3 2-3.6 4-3.6 1 0 1.9.3 2.6.9"/><path d="M12 9v5M9.5 11.5h5"/></svg>';
  const groupOutIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6" cy="6" r="2.3"/><path d="M2 13c.4-2.3 2-3.6 4-3.6 1 0 1.9.3 2.6.9"/><path d="M9.5 11.5h5"/></svg>';
  const tagIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2 2.5h5.5L14 9l-5 5-6.5-6.5z"/><circle cx="5.2" cy="5.7" r="1"/></svg>';
  const boardIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 6h12M6.5 6v7.5"/></svg>';
  const trashIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9"/></svg>';
  const gearIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></svg>';
  function row(r, inArchive) {
    const btn = (act, label, svg) => '<button class="act" data-act="' + act + '" data-sid="' + esc(r.sid) + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + svg + '</button>';
    // 보는 기간 안에 바꾼 파일이 없는 세션은 "불러오기" 단추(그 세션의 마지막 작업분을 읽어 온다)
    const acts = (r.team ? btn('role', strings.setRole, tagIcon) + btn('ungroup', strings.removeFromGroup, groupOutIcon) : btn('group', strings.addToGroup, groupAddIcon))
      + (r.codex ? '' : btn('rename', strings.rename, pencilIcon))
      + (inArchive ? '' : r.files ? btn('review', strings.review, reviewIcon) + btn('reveal', strings.showChanges, icon) : btn('reveal', strings.loadChanges, icon))
      + (inArchive ? btn('unarchive', strings.unarchive, restoreIcon) : btn('archive', strings.archive, archiveIcon));
    const ds = diffstat(r.add || 0, r.del || 0);
    // 둘째 줄: 지금 하는 일(작업 중·기다림일 때)과 변경 규모. 둘 다 없으면 한 줄짜리
    const sub = !(last && last.compact) && (r.now || ds) ? '<div class="sub"><span class="now ' + esc(r.state) + '">' + esc(r.now) + '</span>' + ds + '</div>' : '';
    return '<div class="row' + (r.canOpen ? '' : ' other') + (r.tab ? ' tab' : '') + '" role="listitem" tabindex="0" data-sid="' + esc(r.sid) + '" data-open="' + (r.canOpen ? '1' : '') + '" title="' + esc(r.tip) + '">'
      + '<div class="l1"><span class="dot ' + esc(r.state) + '"></span><span class="title">' + esc(r.title) + '</span>'
      + (r.lead ? '<span class="tag lead" title="' + esc(strings.leadTip + (r.role ? ' · ' + r.role : '')) + '">' + crownIcon + esc(strings.leadName) + '</span>' : '')
      // 좁은 옆 창에서는 대장 줄의 다른 역할을 배지 설명으로만(제목 자리를 남긴다). 보드에는 둘 다 나온다
      + (r.role && !r.lead ? '<span class="tag role' + (r.roleFromBoard ? ' board' : '') + '" title="' + esc(r.roleFromBoard ? strings.roleFromBoard : strings.setRole) + '">' + esc(r.role) + '</span>' : '')
      + (r.codex ? '<span class="tag">Codex</span>' : '')
      + (r.overlap ? '<span class="tag warn" title="' + esc(String(strings.overlapTip || '').replace('{0}', r.overlap)) + '">⚠ ' + r.overlap + '</span>' : '')
      + (inArchive && r.folder ? '<span class="tag">' + esc(r.folder) + '</span>' : '')
      + (r.worktree ? '<span class="tag wt" title="' + esc(String(strings.worktreeTip || '').replace('{0}', r.worktree)) + '">worktree</span>' : '')
      + '<span class="meta">' + esc(r.meta) + '</span>' + acts + '</div>' + sub + '</div>';
  }
  // 색 범례(? 단추)
  const legendBox = document.getElementById('legend');
  const btnLegend = document.getElementById('btnLegend');
  if (saved.legendOpen) legendBox.classList.add('show');
  btnLegend.addEventListener('click', () => {
    saved.legendOpen = !legendBox.classList.contains('show');
    legendBox.classList.toggle('show', saved.legendOpen);
    btnLegend.classList.toggle('on', saved.legendOpen);
    btnLegend.setAttribute('aria-pressed', String(saved.legendOpen));
    save();
  });
  function renderLegend() {
    const s = strings;
    const lg = (k, text) => '<div class="lg"><span class="k">' + k + '</span><span>' + esc(text) + '</span></div>';
    const mark = (ch, v) => '<span style="color:var(--vscode-gitDecoration-' + v + ')">' + ch + '</span>';
    legendBox.innerHTML = '<h4>' + esc(s.lgSessions) + '</h4>'
      + lg('<span class="dot busy"></span>', s.lgBusy) + lg('<span class="dot waiting"></span>', s.lgWaiting) + lg('<span class="dot done"></span>', s.lgDone)
      + lg('<span class="dot idle"></span>', s.lgIdle) + lg('<span class="dot off"></span>', s.lgOff) + lg('<span class="tabkey"></span>', s.lgTab)
      + '<h4>' + esc(s.lgRow) + '</h4>'
      + lg('<span style="color:var(--vscode-charts-green)">&#9656;</span>', s.lgNow) + lg('<span class="sq"><i class="a"></i><i class="d"></i></span>', s.lgDiff)
      + '<h4>' + esc(s.lgFiles) + '</h4>'
      + lg(mark('A', 'addedResourceForeground'), s.lgA) + lg(mark('M', 'modifiedResourceForeground'), s.lgM)
      + lg(mark('D', 'deletedResourceForeground'), s.lgD) + lg(mark('?', 'ignoredResourceForeground'), s.lgQ);
    btnLegend.title = s.legend || '';
    btnLegend.setAttribute('aria-label', s.legend || '');
    btnLegend.classList.toggle('on', !!saved.legendOpen);
  }
  function render(p) {
    last = p;
    strings = p.strings || {};
    renderLegend();
    document.getElementById('lblNew').textContent = strings.newSession || '';
    btnSearch.title = strings.search || '';
    btnSearch.setAttribute('aria-label', strings.search || '');
    q.placeholder = strings.search || '';
    if (p.message) { document.getElementById('lblActive').textContent = strings.active || ''; root.innerHTML = '<div class="msg" title="' + esc(p.detail) + '">' + esc(p.message) + '</div>'; return; }
    document.getElementById('lblActive').textContent = (strings.active || '') + ' · ' + (p.openHere || 0);
    btnActive.title = String(strings.activeTip || '').replace('{0}', p.openHere || 0).replace('{1}', p.openElsewhere || 0);
    btnActive.classList.toggle('on', saved.active);
    btnActive.setAttribute('aria-pressed', String(saved.active));
    const needle = saved.q.trim().toLowerCase();
    const keep = (r) => (!saved.active || r.alive) && (!needle || String(r.title).toLowerCase().includes(needle));
    const filtering = saved.active || !!needle;
    const mine = (p.mine || []).filter(keep);
    let h = '';
    let shown = 0;
    // 사용자가 만든 그룹(맨 위, 처음에는 펼침)
    const sbtn = (act, label, svg, id) => '<button class="sact" data-act="' + act + '" data-team="' + esc(id) + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + svg + '</button>';
    for (const t of p.teams || []) {
      const rows = t.rows.filter(keep);
      if (filtering && !rows.length) continue;
      shown += rows.length;
      const key = 'team:' + t.id;
      const open = needle ? rows.length > 0 : saved.open[key] !== false;
      h += '<details class="grp team" data-key="' + esc(key) + '"' + (open ? ' open' : '') + '><summary title="' + esc(String(strings.teamTip || '').replace('{0}', t.total)) + '"><span class="chev">›</span>'
        + '<span class="gicon">' + teamIcon + '</span>' + (t.waiting ? '<span class="bell"></span>' : '') + '<span class="gname">' + esc(t.name) + '</span><span class="gdesc">' + esc(t.desc) + '</span>'
        + '<span class="tacts">' + sbtn('renameGroup', strings.renameGroup, pencilIcon, t.id) + sbtn('deleteGroup', strings.deleteGroup, trashIcon, t.id) + '</span>'
        + sbtn('board', strings.openBoard, boardIcon, t.id) + '</summary>'
        + (rows.length ? rows.map((r) => row(r, false)).join('') : '<div class="msg">' + esc(strings.teamEmpty) + '</div>') + '</details>';
    }
    if ((p.teams || []).length && mine.length) h += '<div class="sect">' + esc(strings.thisFolder) + '</div>';
    h += mine.map((r) => row(r, false)).join('');
    if (p.noneHere && !filtering) h += '<div class="msg">' + esc(p.noneHere) + '</div>';
    shown += mine.length;
    let sect = false;
    for (const g of p.groups || []) {
      const rows = g.rows.filter(keep);
      if (filtering && !rows.length) continue;
      shown += rows.length;
      const open = needle ? rows.length > 0 : !!saved.open[g.key];
      if (!sect) { sect = true; h += '<div class="sect">' + esc(strings.otherFolders) + '</div>'; }
      h += '<details class="grp" data-key="' + esc(g.key) + '"' + (open ? ' open' : '') + '><summary title="' + esc(g.tip) + '"><span class="chev">›</span>'
        + '<span class="gicon">' + folderIcon + '</span>' + (g.waiting ? '<span class="bell"></span>' : '') + '<span class="gname">' + esc(g.key) + '</span><span class="gdesc">' + esc(g.desc) + '</span></summary>'
        + rows.map((r) => row(r, false)).join('') + '</details>';
    }
    // 보관함: 맨 아래 접힌 묶음. "실행 중만" 필터에서는 숨기고, 검색하면 맞는 것이 있을 때 펼친다
    const arch = saved.active ? [] : (p.archived || []).filter((r) => !needle || String(r.title).toLowerCase().includes(needle));
    if (arch.length) {
      shown += arch.length;
      h += '<details class="grp arch" data-key="__archived"' + ((needle || saved.open.__archived) ? ' open' : '') + '><summary title="' + esc(p.archivedTip || '') + '"><span class="chev">›</span><span class="gicon">' + archiveIcon + '</span><span class="gname">'
        + esc(strings.archivedTitle) + '</span><span class="gdesc"></span><span class="gcount">' + arch.length + '</span>'
        + '<button class="sact" data-act="pickArchive" title="' + esc(strings.archiveRule) + '" aria-label="' + esc(strings.archiveRule) + '">' + gearIcon + '</button></summary>'
        + arch.map((r) => row(r, true)).join('') + '</details>';
    }
    if (filtering && !shown) h = '<div class="msg">' + esc(strings.noMatch) + '</div>';
    if (p.reading) h += '<div class="msg">' + esc(p.reading) + '</div>';
    root.innerHTML = h;
  }
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) { e.stopPropagation(); e.preventDefault(); vscode.postMessage({ type: btn.dataset.act, sid: btn.dataset.sid, team: btn.dataset.team }); return; }
    const r = e.target.closest('.row');
    if (r && r.dataset.open) vscode.postMessage({ type: 'open', sid: r.dataset.sid });
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const r = e.target.closest && e.target.closest('.row');
    if (r && r === e.target && r.dataset.open) vscode.postMessage({ type: 'open', sid: r.dataset.sid });
  });
  root.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d && d.tagName === 'DETAILS' && !saved.q.trim()) { saved.open[d.dataset.key] = d.open; vscode.setState(saved); }
  }, true);
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'render') render(e.data.payload); });
  vscode.postMessage({ type: 'ready' });
})();
</script></body></html>`;
}

function sidOf(arg) {
  if (typeof arg === 'string') return arg;
  return arg && arg.s ? arg.s.sid : null;
}

function inWorkspace(s) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!s.cwd || !folders.length) return true;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const cwd = norm(s.cwd);
  return folders.some((f) => { const r = norm(f.uri.fsPath); return cwd === r || cwd.startsWith(r + path.sep); });
}

// Codex 대화 열기. Codex 확장에는 대화를 ID로 여는 공개 명령이 없어서, 터미널에서 Codex CLI로 이어 연다(codex resume <id>).
// 터미널은 그 세션의 작업 폴더에서 열리므로 다른 폴더 세션도 이 창에서 열 수 있다.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codexId = (sid) => String(sid || '').replace(/^codex:/, '');
let codexCli = null; // true로 확인된 뒤에만 기억한다(나중에 설치할 수 있으므로 "없음"은 기억하지 않음)
function hasCodexCli() {
  if (codexCli) return Promise.resolve(true);
  if (codexCli === false && hasCodexCli.fixed) return Promise.resolve(false); // 시험에서 고정한 값
  return new Promise((resolve) => {
    execFile('codex', ['--version'], { timeout: 5000 }, (err) => { codexCli = !err; resolve(!err); });
  });
}
async function openCodexSession(s) {
  const id = codexId(s.sid);
  // 명령 줄에 넣는 값이라 UUID 모양일 때만 쓴다
  if (!UUID_RE.test(id)) return vscode.window.showInformationMessage(L('"{0}" is a Codex session. Open it from Codex.', s.title));
  if (!(await hasCodexCli())) return vscode.window.showInformationMessage(L('The Codex CLI ("codex") was not found on this machine, so this Codex session cannot be opened from here.'));
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : undefined;
  const term = vscode.window.createTerminal({ name: 'Codex · ' + String(s.title || id).replace(/\s+/g, ' ').slice(0, 24), cwd });
  term.show();
  term.sendText('codex resume ' + id, true);
}

// Claude Code 세션 목록에서 행을 누를 때와 같은 명령(claude-vscode.editor.open)을 부른다.
// 인자 순서(세션 ID, 첫 프롬프트, 열 위치, 묶음 ID, 전체 편집기, 옵션)는 Claude Code 2.1.322 기준이라 판이 바뀌면 달라질 수 있다.
async function openClaudeSession(arg) {
  const sid = sidOf(arg);
  if (!sid) return;
  const s = raw.find((x) => x.sid === sid) || { sid, title: sid.slice(0, 8) };
  if (s.agent === 'codex' || sid.startsWith('codex:')) return openCodexSession(s);
  if (!inWorkspace(s)) {
    return vscode.window.showInformationMessage(L('"{0}" is a session from another folder ({1}). Open it from the Claude list in a VS Code window with that folder open.', s.title, s.project || s.cwd));
  }
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', sid, undefined, undefined, undefined, true, { programmatic: 'honor-preferred-location' });
  } catch (e) {
    try {
      await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://anthropic.claude-code/open?session=${encodeURIComponent(sid)}`));
    } catch {
      vscode.window.showWarningMessage(L('Could not open the Claude conversation: {0}', String((e && e.message) || e)));
    }
  }
}

// Claude 세션 목록의 "+ New session"과 같은 동작(새 탭에 새 대화). 내부 명령이라 판이 바뀌면 다를 수 있다.
async function newClaudeSession() {
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open');
  } catch (e) {
    try {
      await vscode.commands.executeCommand('claude-vscode.newConversation');
    } catch {
      vscode.window.showWarningMessage(L('Could not open the Claude conversation: {0}', String((e && e.message) || e)));
    }
  }
}

// 사용자가 "변경 파일"을 눌러 불러온 세션: 세션 → 읽기 시작 시각. 보는 기간 밖이어도 그 세션의 마지막 작업 구간을 읽는다(이 창을 다시 불러올 때까지)
// ---------- 바깥에서 세션 열기(주소) ----------
// 데스크톱 알림 배너 등이 여는 주소: vscode://kms-labs.session-watchtower/open?key=…&title=…&folder=…&root=…
// key: 세션 ID sha256 앞 12자(알림 훅이 보내는 값), title: 세션 이름(훅처럼 40자에서 자르고 "…"),
// folder/root: 작업 폴더·프로젝트 폴더 이름. key가 맞는 세션을 먼저 찾고, 없으면 이름으로 찾는다.
// 주소는 마지막으로 앞에 있던 VS Code 창이 받으므로, 보내는 쪽이 그 세션의 창을 먼저 앞으로 가져온다.
// 이미 목록에 있는 세션만 열고, 주소로 받은 글자를 명령이나 프롬프트로 넘기지 않는다.
const sessionKeyOf = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 12);
const titleText = (t) => Array.from(String(t || '').replace(/\s+/g, ' ').trim()).filter((ch) => !/\p{C}/u.test(ch)).join('');

function sameTitle(title, wanted) {
  const a = titleText(title);
  const b = titleText(wanted);
  if (!b) return false;
  if (a === b) return true;
  const cut = b.endsWith('…') ? b.slice(0, -1) : b.endsWith('...') ? b.slice(0, -3) : ''; // 알림 쪽에서 잘린 이름
  return cut.trim().length > 0 && a.startsWith(cut);
}

function inFolder(s, folder, root) {
  const parts = String(s.cwd || '').split(/[\\/]/);
  return (!!folder && parts[parts.length - 1] === folder) || (!!root && parts.includes(root));
}

// 기록을 (다시) 읽게 하고 다 읽을 때까지 기다린다. 주소로 막 켜진 창은 아직 아무것도 읽지 않았다.
async function sessionsReady(again, ms) {
  if (again || !loaded) requestScan(false);
  const until = Date.now() + ms;
  while ((!loaded || stillReading || inflight) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
}

async function findSessions(want) {
  const match = () => {
    const list = raw.filter((s) => s && s.sid);
    let hits = want.key ? list.filter((s) => !String(s.sid).startsWith('codex:') && sessionKeyOf(s.sid) === want.key) : [];
    if (!hits.length && want.title) hits = list.filter((s) => sameTitle(s.title, want.title));
    if (hits.length > 1 && (want.folder || want.root)) {
      const near = hits.filter((s) => inFolder(s, want.folder, want.root));
      if (near.length) hits = near;
    }
    return hits;
  };
  await sessionsReady(false, 15000);
  let hits = match();
  if (!hits.length) { await sessionsReady(true, 15000); hits = match(); } // 마지막 읽기 뒤에 생긴 세션일 수 있다
  return hits;
}

async function openFromUri(uri) {
  if (!uri || uri.path !== '/open') return undefined;
  const q = new URLSearchParams(uri.query || '');
  const text = (k) => String(q.get(k) || '').slice(0, 200);
  const key = String(q.get('key') || '');
  const want = { key: /^[0-9a-f]{12}$/.test(key) ? key : '', title: text('title'), folder: text('folder'), root: text('root') };
  if (!want.key && !want.title) return undefined;
  const hits = await findSessions(want);
  if (!hits.length) return vscode.window.showInformationMessage(L('The session "{0}" is not in the list of this window.', want.title || want.key));
  if (hits.length === 1) return openClaudeSession(hits[0].sid);
  hits.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  const items = hits.map((s) => ({
    label: s.title || s.sid.slice(0, 8),
    description: [s.cwd ? path.basename(s.cwd) : '', s.lastActivity ? fmtAgo(s.lastActivity) : ''].filter(Boolean).join(' · '),
    sid: s.sid,
  }));
  const choice = await vscode.window.showQuickPick(items, { placeHolder: L('Several sessions have this name. Which one?') });
  return choice ? openClaudeSession(choice.sid) : undefined;
}

const pinned = new Map();
let pendingReveal = null;

async function revealSession(arg, afterLoad) {
  const sid = sidOf(arg);
  const s = model.find((x) => x.sid === sid);
  const hasFiles = !!s && (s.files.length > 0 || s.unresolved.length > 0);
  if (!hasFiles && !afterLoad && !aliveOnly && !pinned.has(sid)) {
    // 보는 기간 안에 바꾼 파일이 없는 세션: 그 세션이 마지막으로 일한 구간(보는 기간만큼)을 읽어 온다
    const r = raw.find((x) => x.sid === sid);
    if (r) {
      pinned.set(sid, (r.lastActivity || Date.now()) - cfg().lookbackHours * 3600000);
      pendingReveal = sid;
      requestScan(true);
      return undefined;
    }
  }
  if (!s || !treeView || (afterLoad && !hasFiles)) {
    if (afterLoad) return vscode.window.showInformationMessage(L("No recorded file changes in the last {0} of this session's work.", spanShort(cfg().lookbackHours)));
    return vscode.window.showInformationMessage(aliveOnly ? L('This session is hidden by the "open only" filter.') : L('This session has no changed files in the last {0}.', spanShort(cfg().lookbackHours)));
  }
  try {
    await treeView.reveal({ t: 'session', s }, { select: true, focus: false, expand: true });
  } catch {
    /* 창이 접혀 있으면 실패할 수 있음 */
  }
}

// ---------- 비교 화면 ----------

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10000 }, (err, out) => resolve(err ? null : out));
  });
}

async function readRecord(file, offset, length) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, offset);
    return JSON.parse(buf.toString('utf8'));
  } finally {
    await fh.close();
  }
}

function applyEdit(orig, oldS, newS, all) {
  if (typeof orig !== 'string' || typeof oldS !== 'string' || typeof newS !== 'string' || oldS === '') return null;
  if (all) return orig.split(oldS).join(newS);
  const i = orig.indexOf(oldS);
  if (i < 0) return null;
  return orig.slice(0, i) + newS + orig.slice(i + oldS.length);
}

function hunksToSides(hunks) {
  // 주의: 번역 함수 L과 이름이 겹치지 않게 lefts/rights로 쓴다
  const lefts = [];
  const rights = [];
  (Array.isArray(hunks) ? hunks : []).forEach((h, i) => {
    if (i > 0 || (h && h.oldStart > 1)) {
      const sep = `⋯ ${L('(near line {0})', h.oldStart)} ⋯`;
      lefts.push(sep);
      rights.push(sep);
    }
    for (const l of (h && h.lines) || []) {
      if (typeof l !== 'string') continue;
      const p = l[0];
      const t = l.slice(1);
      if (p === ' ') { lefts.push(t); rights.push(t); } else if (p === '-') lefts.push(t); else if (p === '+') rights.push(t);
    }
  });
  return { left: lefts.join('\n'), right: rights.join('\n'), partial: true };
}

// Codex apply_patch 한 파일 부분 → 비교 양쪽(@@는 구간 나눔)
async function sidesForCodex(c) {
  const o = await readRecord(c.file, c.offset, c.length);
  const text = codexPatchText((o && o.payload) || null) || '';
  const part = parsePatch(text, '')[c.idx];
  if (!part) return { left: '', right: '', partial: true };
  if (part.op === 'Delete') return { left: L('(This file was deleted.)'), right: '', partial: true };
  const lefts = [];
  const rights = [];
  for (const l of part.lines) {
    if (l.startsWith('@@')) { const sep = '⋯'; if (lefts.length || rights.length) { lefts.push(sep); rights.push(sep); } continue; }
    const t = l.slice(1);
    if (l[0] === '+') rights.push(t); else if (l[0] === '-') lefts.push(t); else { lefts.push(t); rights.push(t); }
  }
  return { left: lefts.join('\n'), right: rights.join('\n'), partial: part.op !== 'Add' };
}

async function sidesForEdit(c) {
  const o = await readRecord(c.file, c.offset, c.length);
  const r = (o && o.toolUseResult) || {};
  if (r.type === 'create' || r.type === 'update') return { left: typeof r.originalFile === 'string' ? r.originalFile : '', right: String(r.content || ''), partial: false };
  const right = applyEdit(r.originalFile, r.oldString, r.newString, r.replaceAll);
  if (right !== null) return { left: r.originalFile, right, partial: false };
  return hunksToSides(r.structuredPatch);
}

async function sidesForBash(c) {
  const o = await readRecord(c.file, c.offset, c.length);
  const bd = (o && o.toolUseResult && o.toolUseResult.bashEditDiff) || {};
  const files = Array.isArray(bd.files) ? bd.files : [];
  const fx = files.find((x) => x && x.filePath === c.path) || (c.idx >= 0 ? files[c.idx] : null);
  if (!fx) return { left: '', right: L('(The changed lines of this command were not recorded; only the file name was.)'), partial: true };
  return hunksToSides(fx.hunks);
}

async function sidesForCommit(c) {
  const left = await git(['show', `${c.sha}^:${c.rel}`], c.top);
  const right = await git(['show', `${c.sha}:${c.rel}`], c.top);
  return { left: left === null ? '' : left, right: right === null ? '' : right, partial: false };
}

// 세션이 이 파일을 처음 바꾸기 직전의 커밋된 내용(셸로 바꾼 파일의 기준선)
async function commitTextBefore(p, ts) {
  const dir = path.dirname(p);
  const rel = './' + path.basename(p);
  const sha = await git(['log', '-1', '--format=%H', `--before=${new Date(ts - 1000).toISOString()}`, '--', rel], dir);
  if (!sha || !sha.trim()) return null;
  return git(['show', `${sha.trim()}:${rel}`], dir);
}

// 비교 창에 넣을 가상 문서 두 개(왼쪽·오른쪽). 주소의 경로는 실제 파일 위치처럼 보이게 하고(여러 파일 비교 창의 머리글에 그대로 나온다),
// 어느 비교의 어느 쪽인지는 뒤(query)에 적는다. 두 쪽의 경로가 같아야 "이름 바뀜"으로 표시되지 않는다.
function registerDiff(desc, name, where) {
  const id = String(++diffSeq);
  diffRegistry.set(id, desc);
  if (diffRegistry.size > 300) diffRegistry.delete(diffRegistry.keys().next().value);
  const dir = String(where || '').split(/[\\/]/).filter(Boolean).join('/');
  const mk = (side) => vscode.Uri.from({ scheme: DIFF_SCHEME, path: '/' + (dir ? dir + '/' : '') + name, query: `${id}-${side}` });
  return { left: mk('left'), right: mk('right') };
}

const contentProvider = {
  async provideTextDocumentContent(uri) {
    const [id, side] = String(uri.query || '').split('-');
    const desc = diffRegistry.get(id);
    if (!desc) return L('(Please reopen: the comparison data is gone.)');
    try {
      if (!desc.sides) desc.sides = desc.load();
      const s = await desc.sides;
      return side === 'left' ? s.left : s.right;
    } catch (e) {
      return L('(Could not read the content: {0})', String((e && e.message) || e));
    }
  },
};

function loaderFor(c) {
  if (c.kind === 'edit') return () => sidesForEdit(c);
  if (c.kind === 'bash') return () => sidesForBash(c);
  if (c.kind === 'cxedit') return () => sidesForCodex(c);
  if (c.kind === 'commit' && c.top) return () => sidesForCommit(c);
  return null;
}

// 파일 하나의 "이 세션이 한 변경" 양쪽.
// 왼쪽: 세션이 처음 건드리기 전(편집 기록의 원본 → 커밋 직전 → 그 앞 커밋 순으로 찾음)
// 오른쪽: 편집 도구·커밋으로만 바꿨으면 세션의 마지막 변경 직후(다른 세션 변경이 덜 섞임), 아니면 지금 디스크
async function fileSides(f) {
  const changes = [...f.changes].sort((a, b) => a.ts - b.ts);
  const oldest = changes[0];
  const newest = changes[changes.length - 1];
  const exists = fs.existsSync(f.path);
  let left = null;
  let leftLabel = L('before session');
  if (oldest.created) { left = ''; leftLabel = L('new file'); }
  else if (oldest.kind === 'edit') {
    try { const s = await sidesForEdit(oldest); if (!s.partial) left = s.left; } catch { left = null; }
  } else if (oldest.kind === 'commit' && oldest.top) {
    const t = await git(['show', `${oldest.sha}^:${oldest.rel}`], oldest.top);
    left = t === null ? '' : t;
  }
  if (left === null && exists) {
    const t = await commitTextBefore(f.path, oldest.ts);
    if (t !== null) { left = t; leftLabel = L('last commit before session'); }
  }
  let right = null;
  let rightLabel = L('now');
  if (changes.every((c) => c.kind === 'edit')) {
    try { const s = await sidesForEdit(newest); if (!s.partial) { right = s.right; rightLabel = L('end of session'); } } catch { right = null; }
  } else if (changes.every((c) => c.kind === 'commit') && newest.top) {
    const t = await git(['show', `${newest.sha}:${newest.rel}`], newest.top);
    right = t === null ? '' : t;
    rightLabel = L('end of session');
  }
  return { left, right, exists, title: `${leftLabel} ↔ ${rightLabel}` };
}

async function openChangeDiff(el) {
  const { c, f } = el;
  const name = path.basename(f.path);
  const load = loaderFor(c);
  if (!load) return openFileDiff({ ...el, t: 'file' });
  const label = c.kind === 'commit' ? L('commit {0}', String(c.sha).slice(0, 8)) : `${kindText(c.kind)} ${fmtTime(c.ts, true)}`;
  const u = registerDiff({ load }, name);
  await vscode.commands.executeCommand('vscode.diff', u.left, u.right, `${name} (${label})`, { preview: true });
}

// 비교 화면 한 쌍의 주소(왼쪽은 항상 가상 문서, 오른쪽은 세션 끝 내용 또는 지금 디스크 파일)
async function diffPair(f, s) {
  const name = path.basename(f.path);
  const where = s ? displayDir(f.path, s) : '';
  const sd = await fileSides(f);
  if (sd.left === null) {
    const latest = f.changes.find((c) => loaderFor(c));
    if (!latest) return null;
    const u = registerDiff({ load: loaderFor(latest) }, name, where);
    return { left: u.left, right: u.right, title: `${kindText(latest.kind)} ${fmtTime(latest.ts, true)}` };
  }
  const u = registerDiff({ load: async () => ({ left: sd.left, right: sd.right === null ? '' : sd.right }) }, name, where);
  const right = sd.right !== null ? u.right : sd.exists ? vscode.Uri.file(f.path) : u.right;
  return { left: u.left, right, title: sd.title };
}

// 그림·압축 파일 같은 글자가 아닌 파일인가(앞부분에 0 바이트가 있으면 그렇다고 본다). 이런 파일은 글자 비교 창으로 열 수 없다
function looksBinary(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 이미 닫힘 */ } }
}

// 파일을 그 종류에 맞는 편집기로 연다(그림은 그림 보기로). showTextDocument는 그림에서 "cannot open … binary" 오류를 낸다
function openPlain(p) {
  return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p), { preview: true });
}

async function openFileDiff(el, o) {
  const { f } = el;
  const name = path.basename(f.path) + (o && o.label ? ' · ' + String(o.label).replace(/\s+/g, ' ').slice(0, 30) : '');
  const preview = !(o && o.keep);
  if (fs.existsSync(f.path) && looksBinary(f.path)) return openPlain(f.path);
  const pair = await diffPair(f, el.s);
  if (!pair) {
    if (fs.existsSync(f.path)) return openPlain(f.path);
    return vscode.window.showInformationMessage(L('{0}: nothing to compare (the file no longer exists).', name));
  }
  await vscode.commands.executeCommand('vscode.diff', pair.left, pair.right, `${name} (${pair.title})`, { preview });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function run() { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i]); } catch { out[i] = null; } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// 세션 하나가 바꾼 파일 전부를 VS Code의 여러 파일 비교 창 하나로 연다
async function openSessionChanges(arg) {
  const sid = sidOf(arg);
  const s = model.find((x) => x.sid === sid);
  if (!s || !s.files.length) {
    return vscode.window.showInformationMessage(L('This session has no changed files in the last {0}.', spanShort(cfg().lookbackHours)));
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: L('Preparing the changes of "{0}"…', s.title) }, async () => {
    const pairs = await mapLimit(s.files, 6, (f) => diffPair(f, s));
    const resources = [];
    s.files.forEach((f, i) => { if (pairs[i]) resources.push([vscode.Uri.file(f.path), pairs[i].left, pairs[i].right]); });
    if (!resources.length) return vscode.window.showInformationMessage(L('{0}: nothing to compare (the file no longer exists).', s.title));
    // 셸 글자로 추정만 한 파일은 바뀐 내용 기록이 없어 비교할 수 없다 → 조용히 빼지 말고 알린다
    const skipped = s.files.length - resources.length;
    if (skipped > 0) vscode.window.showInformationMessage(L('{0} file(s) were left out: they were only guessed from shell commands, so there is no recorded change to compare.', skipped));
    try {
      await vscode.commands.executeCommand('vscode.changes', L('{0} — changed files', s.title), resources);
    } catch {
      // 여러 파일 비교 창이 없는 VS Code면 첫 파일만
      await vscode.commands.executeCommand('vscode.diff', resources[0][1], resources[0][2], path.basename(s.files[0].path), { preview: true });
    }
  });
}

// ---------- 탐색기 표시(지금 고치는 파일) ----------
// VS Code는 확장이 탐색기의 파일 그림을 바꾸거나 움직이게 하는 길을 주지 않는다. 줄 수 있는 것은 글자 배지(2자 이하)·이름 색·마우스 설명뿐이다.
// 그래서 배지 글자를 반달 모양 넷으로 번갈아 바꿔 도는 것처럼 보이게 한다("움직임 줄이기"를 켠 사람에게는 멈춘 점).
// 표시는 파일을 품은 폴더에도 색과 점으로 번진다(접힌 폴더 안에서 고치는 중인 것도 보이게).

const SPIN_FRAMES = ['◐', '◓', '◑', '◒'];
const SPIN_MS = 400;
const SPIN_MAX_FILES = 20; // 한꺼번에 많은 파일이 바뀌면(포매터 등) 돌리지 않고 멈춘 점으로: 0.4초마다 수백 줄을 다시 그리게 하지 않는다
const explorerEvents = new vscode.EventEmitter();
let explorerLive = new Map(); // 경로 열쇠 → { state: 'editing' | 'approval', title, uri }
let spinFrame = 0;
let spinTimer = null;
const pathKey = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

// 작업 폴더 안의 파일이면 탐색기가 쓰는 주소로 바꾼다(원격 창은 작업 폴더와 같은 scheme·authority). 폴더 밖이면 null
function workspaceUri(p) {
  const k = pathKey(p);
  for (const f of vscode.workspace.workspaceFolders || []) {
    const r = pathKey(f.uri.fsPath);
    if (!k.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) continue;
    const u = vscode.Uri.file(p);
    return f.uri.scheme && f.uri.scheme !== 'file' ? u.with({ scheme: f.uri.scheme, authority: f.uri.authority }) : u;
  }
  return null;
}

function stopSpin() {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
}

function updateExplorerMarks() {
  const next = new Map();
  if (cfg().explorerMarks) {
    for (const s of model) {
      if (!s.alive) continue;
      for (const f of s.files) {
        const state = liveState(s, f);
        if (!state) continue;
        const k = pathKey(f.path);
        const had = next.get(k);
        if (had && (had.state === 'approval' || state !== 'approval')) continue; // 승인을 기다리는 쪽이 먼저
        const uri = had ? had.uri : workspaceUri(f.path);
        if (uri) next.set(k, { state, title: String(s.title).replace(/\s+/g, ' ').slice(0, 60), uri });
      }
    }
  }
  const changed = [];
  for (const [k, v] of next) { const o = explorerLive.get(k); if (!o || o.state !== v.state || o.title !== v.title) changed.push(v.uri); }
  for (const [k, v] of explorerLive) if (!next.has(k)) changed.push(v.uri);
  explorerLive = next;
  const editing = () => [...explorerLive.values()].filter((v) => v.state === 'editing').map((v) => v.uri);
  const n = editing().length;
  const spin = n > 0 && n <= SPIN_MAX_FILES && vscode.workspace.getConfiguration('workbench').get('reduceMotion') !== 'on';
  const was = !!spinTimer;
  if (!spin) stopSpin();
  else if (!spinTimer) {
    spinTimer = setInterval(() => {
      spinFrame = (spinFrame + 1) % SPIN_FRAMES.length;
      const uris = editing();
      if (uris.length) explorerEvents.fire(uris); else stopSpin();
    }, SPIN_MS);
    if (spinTimer.unref) spinTimer.unref();
  }
  // 도는 모양 ↔ 멈춘 점으로 표시 방식이 바뀌면, 이미 표시된 파일도 다시 그리게 한다
  if (was !== !!spinTimer && n) explorerEvents.fire(editing());
  if (changed.length) explorerEvents.fire(changed);
}

const explorerMarks = {
  onDidChangeFileDecorations: explorerEvents.event,
  provideFileDecoration(uri) {
    if (!explorerLive.size || !uri || uri.scheme === ITEM_SCHEME || uri.scheme === DIFF_SCHEME || !uri.fsPath) return undefined;
    const e = explorerLive.get(pathKey(uri.fsPath));
    if (!e || uri.scheme !== e.uri.scheme) return undefined;
    const d = e.state === 'approval'
      ? new vscode.FileDecoration('!', L('"{0}" is waiting for your approval to edit this file · Session Watchtower', e.title), new vscode.ThemeColor('charts.blue'))
      : new vscode.FileDecoration(spinTimer ? SPIN_FRAMES[spinFrame] : '●', L('Being edited now by "{0}" · Session Watchtower', e.title), new vscode.ThemeColor('charts.green'));
    d.propagate = true;
    return d;
  },
};

// ---------- 파일 장식(A/M/C/S 글자) ----------

const decorations = {
  provideFileDecoration(uri) {
    if (uri.scheme !== ITEM_SCHEME) return undefined;
    switch (uri.query) {
      case 'A': return new vscode.FileDecoration('A', L('Created in this session'), new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
      case 'M': return new vscode.FileDecoration('M', L('Modified in this session'), new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
      case 'D': return new vscode.FileDecoration('D', L('Not on disk anymore (deleted)'), new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
      case '?': return new vscode.FileDecoration('?', L('Guessed from shell commands (not certain)'), new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'));
      default: return undefined;
    }
  },
};

// ---------- 읽기 스레드 ----------

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'worker.js'));
  worker.on('message', onWorkerMessage);
  worker.on('error', (e) => {
    lastError = String((e && e.message) || e);
    worker = null;
    inflight = false;
    provider.fire();
  });
  worker.on('exit', () => { worker = null; inflight = false; });
  return worker;
}

function requestScan(force) {
  if (inflight) { pending = { force: !!(force || (pending && pending.force)) }; return; }
  inflight = true;
  try {
    ensureWorker().postMessage({ type: 'scan', id: ++reqId, opts: workerOpts({ force: !!force }) });
  } catch (e) {
    inflight = false;
    lastError = String((e && e.message) || e);
    provider.fire();
  }
}

function onWorkerMessage(m) {
  if (m.type === 'partial') {
    // 처음 읽는 도중: 먼저 읽은 세션부터 보여 준다(읽기는 계속됨)
    lastError = null;
    loaded = true;
    stillReading = true;
    raw = m.sessions || [];
    statusSessions = raw.filter((s) => s.alive);
    rebuild();
    updateStatusBar();
    return;
  }
  if (m.type === 'status') {
    statusInflight = false;
    // 실행 중 목록만 읽은 결과 + 마지막 전체 읽기에서 본 Codex 작업 중 세션
    statusSessions = (m.sessions || []).concat(raw.filter((s) => s.agent === 'codex' && s.alive));
    updateStatusBar();
    checkWaiting(statusSessions);
    // 이 폴더의 세션이 일하기 시작했으면 다음 주기를 기다리지 않고 기록을 읽는다(멈춤은 여기서 판단하지 않는다: 이 목록의 기록 시각은 낡았을 수 있다)
    if (backgroundWanted() && workingHere()) requestScan(false);
    return;
  }
  inflight = false;
  const wasReading = stillReading;
  stillReading = false;
  if (m.type === 'same' && wasReading) rebuild(); // "더 읽는 중" 표시 지우기
  if (m.type === 'error') {
    lastError = String(m.message || '').split('\n')[0];
    provider.fire();
  } else if (m.type === 'result') {
    lastError = null;
    loaded = true;
    raw = m.sessions || [];
    statusSessions = raw.filter((s) => s.alive);
    rebuild();
    updateStatusBar();
    if (pendingReveal) { const sid = pendingReveal; pendingReveal = null; revealSession(sid, true); }
  } else if (m.type === 'same' && Date.now() - lastFire > 60000) {
    provider.fire(); // "N분 전·N분째" 글자만 새로
    sessionsWebview.post();
    updateStatusBar();
  }
  // 달라진 것이 없다는 답("same")에도 확인한다: 기다림이 이어지는지, 조용한 지 얼마나 됐는지는 시간이 지나야 알 수 있다
  checkWaiting(statusSessions);
  if (m.type === 'result' || m.type === 'same') checkStuck(raw.filter((s) => s.alive)); // 방금 기록을 읽은 결과로만 판단한다
  if (pending) {
    const p = pending;
    pending = null;
    requestScan(p.force);
  }
}

// 이 확장의 창이 안 보일 때(사용자가 파일 탐색기를 보고 있을 때)도 탐색기 표시·겹침 알림·멈춤 알림은 대화 기록을 읽어야 맞게 나온다.
// 가벼운 확인(실행 중 목록만)의 "마지막 기록 시각"은 마지막으로 기록을 읽은 때에 멈춰 있어서, 그것만으로 판단하면 틀린다.
// 이 폴더에서 일하는 세션이 있으면 확인 때마다, 없으면 BG_EVERY번에 한 번만 기록을 읽는다(달라진 줄만 읽어 한 번에 몇 ms).
const BG_EVERY = 12;
let bgTicks = 0;
function backgroundWanted() {
  const o = cfg();
  return o.explorerMarks || o.notifyOverlap || o.notifyStuckMinutes > 0;
}
function workingHere() {
  return statusSessions.some((s) => s.alive && (s.status === 'busy' || s.status === 'waiting') && inWorkspace(s));
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (groupsChangedOnDisk() || boardFilesChanged()) rebuildSessions(); // 다른 VS Code 창이 그룹을 바꿨거나, 대장이 보드의 역할을 고쳤다
    if ((treeView && treeView.visible) || (sessionsView && sessionsView.visible)) { requestScan(false); return; }
    const bg = backgroundWanted();
    if (bg && (workingHere() || bgTicks++ % BG_EVERY === 0)) requestScan(false);
    else if (bg || cfg().statusBar || cfg().notifyWaiting) requestStatus();
  }, cfg().pollSeconds * 1000);
}

// ---------- 아래 상태 표시줄 ----------

let statusItem = null;
let statusSessions = [];
let statusInflight = false;

function requestStatus() {
  if (statusInflight) return;
  statusInflight = true;
  try {
    ensureWorker().postMessage({ type: 'status', id: ++reqId, opts: workerOpts() });
  } catch {
    statusInflight = false;
  }
}

// 이 폴더의 세션이 승인·답을 기다리기 시작하면 한 번 알린다. 금방 풀리는 대기(자동 승인 등)는 알리지 않으려고 두 번 연속 확인될 때만
const waitingSeen = new Map(); // 세션 → 처음 본 시각 또는 'done'(이미 알림)
function checkWaiting(list) {
  if (!cfg().notifyWaiting) { waitingSeen.clear(); return; }
  const now = new Set();
  for (const s of list) {
    if (!s.alive || s.status !== 'waiting' || !inWorkspace(s)) continue;
    now.add(s.sid);
    const seen = waitingSeen.get(s.sid);
    if (seen === 'done') continue;
    if (!seen) { waitingSeen.set(s.sid, Date.now()); continue; }
    if (Date.now() - seen < 1500) continue;
    waitingSeen.set(s.sid, 'done');
    const what = s.waitingFor === 'permission prompt' ? L('needs approval') : s.waitingFor === 'input needed' ? L('needs answer') : L('waiting');
    const open = L('Open conversation');
    Promise.resolve(vscode.window.showInformationMessage(L('"{0}" is waiting for you: {1}', s.title, what), open)).then((pick) => { if (pick === open) openClaudeSession(s.sid); });
  }
  for (const sid of [...waitingSeen.keys()]) if (!now.has(sid)) waitingSeen.delete(sid);
}

// 작업 중인데 한참 동안 새 기록이 없는 세션(멈췄을 수 있다)을 한 번 알린다. 기록이 다시 생기면 다음에 또 알릴 수 있다
const stuckSeen = new Map(); // 세션 → 알렸을 때의 마지막 기록 시각
function checkStuck(list) {
  const limit = cfg().notifyStuckMinutes;
  if (!limit) { stuckSeen.clear(); return; }
  const now = new Set();
  for (const s of list) {
    if (!s.alive || s.status !== 'busy' || !inWorkspace(s) || !s.lastActivity) continue;
    now.add(s.sid);
    const quiet = Math.floor((Date.now() - s.lastActivity) / 60000);
    if (quiet < limit) { stuckSeen.delete(s.sid); continue; }
    if (stuckSeen.get(s.sid) === s.lastActivity) continue;
    stuckSeen.set(s.sid, s.lastActivity);
    const open = L('Open conversation');
    Promise.resolve(vscode.window.showWarningMessage(L('"{0}" has been working for {1} minutes without writing anything new. It may be stuck.', s.title, quiet), open)).then((pick) => { if (pick === open) openClaudeSession(s.sid); });
  }
  for (const sid of [...stuckSeen.keys()]) if (!now.has(sid)) stuckSeen.delete(sid);
}

function updateStatusBar() {
  if (!statusItem) return;
  if (!cfg().statusBar) { statusItem.hide(); return; }
  // 숫자는 이 폴더의 세션만 센다(세션 상태 창의 머리말·"열린 세션" 단추와 같은 기준). 다른 폴더는 설명에 따로 적는다
  const groups = { busy: [], waiting: [], done: [], idle: [] };
  const elsewhere = { busy: 0, waiting: 0 };
  for (const s of statusSessions) {
    const k = stateOf(s).key;
    if (!inWorkspace(s)) { if (k in elsewhere) elsewhere[k]++; continue; }
    if (groups[k]) groups[k].push(s);
  }
  const parts = [];
  if (groups.busy.length) parts.push(`$(loading~spin) ${groups.busy.length}`);
  if (groups.waiting.length) parts.push(`$(bell-dot) ${groups.waiting.length}`);
  if (groups.done.length) parts.push(`$(check) ${groups.done.length}`);
  statusItem.text = parts.length ? parts.join('  ') : `$(eye) ${groups.idle.length}`;
  statusItem.backgroundColor = groups.waiting.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.appendMarkdown('**Session Watchtower**\n\n');
  const line = (icon, label, list) => {
    if (!list.length) return;
    const clean = (t) => String(t || '').replace(/[\\`*_[\]<>|]/g, ' ');
    const names = list.slice(0, 8).map((s) => clean(s.title || s.sid.slice(0, 8)) + (s.activity && !s.activity.done ? ' — ' + clean(activityText(s.activity)) : '')).join(', ');
    md.appendMarkdown(`$(${icon}) **${label}** (${list.length}): ${names}${list.length > 8 ? ' …' : ''}\n\n`);
  };
  line('bell-dot', L('Waiting'), groups.waiting);
  line('loading~spin', L('Working'), groups.busy);
  line('check', L('Just finished'), groups.done);
  line('debug-pause', L('Idle'), groups.idle);
  if (!groups.busy.length && !groups.waiting.length && !groups.done.length && !groups.idle.length) md.appendMarkdown(L('No open sessions') + '\n\n');
  if (elsewhere.busy || elsewhere.waiting) md.appendMarkdown(L('Other folders: working {0} · waiting {1}', elsewhere.busy, elsewhere.waiting) + '\n\n');
  md.appendMarkdown(L('Click to open the Sessions view.'));
  statusItem.tooltip = md;
  statusItem.show();
}

// ---------- 명령 ----------

async function setAliveOnly(v) {
  aliveOnly = v;
  await vscode.commands.executeCommand('setContext', CTX_ALIVE, v);
  await ctx.globalState.update(CTX_ALIVE, v);
  rebuild();
}

async function pickWindow() {
  const cur = cfg().lookbackHours;
  // 10 ~ 50분은 시간의 소수로 저장한다(10분 = 0.1667). 고른 값과 지금 값은 분 단위로 비교한다
  const mins = [10, 20, 30, 40, 50].map((m) => Math.round((m / 60) * 10000) / 10000);
  const items = mins.concat([1, 3, 6, 12, 24, 48, 72, 168]).map((h) => ({
    label: h < 1 ? spanLong(h) : h < 24 ? L('{0} hours', h) : L('{0} days', h / 24),
    description: Math.round(h * 60) === Math.round(cur * 60) ? L('current') : '',
    h,
  }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: L('How far back should changes be shown?') });
  if (!pick) return;
  await vscode.workspace.getConfiguration(CFG).update('lookbackHours', pick.h, vscode.ConfigurationTarget.Global);
}

function activate(context) {
  ctx = context;
  aliveOnly = !!context.globalState.get(CTX_ALIVE, false);
  vscode.commands.executeCommand('setContext', CTX_ALIVE, aliveOnly);

  treeView = vscode.window.createTreeView(VIEW, { treeDataProvider: provider, showCollapseAll: true });
  statusItem = vscode.window.createStatusBarItem('claudeSessionChanges.status', vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Session Watchtower';
  statusItem.command = SESSIONS_VIEW + '.focus';
  context.subscriptions.push(
    treeView,
    statusItem,
    vscode.window.registerWebviewViewProvider(SESSIONS_VIEW, sessionsWebview),
    vscode.commands.registerCommand('claudeSessionChanges.openSessionChanges', (arg) => openSessionChanges(arg)),
    vscode.commands.registerCommand('claudeSessionChanges.archiveSession', (arg) => setArchived(arg, true)),
    vscode.commands.registerCommand('claudeSessionChanges.revealSession', (arg) => revealSession(arg)),
    vscode.commands.registerCommand('claudeSessionChanges.openClaudeSession', (arg) => openClaudeSession(arg)),
    vscode.window.registerUriHandler({ handleUri: (uri) => openFromUri(uri) }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.window.registerFileDecorationProvider(explorerMarks),
    ...(vscode.window.tabGroups ? [vscode.window.tabGroups.onDidChangeTabs(onTabsChanged), vscode.window.tabGroups.onDidChangeTabGroups(onTabsChanged)] : []),
    vscode.commands.registerCommand('claudeSessionChanges.refresh', () => requestScan(true)),
    vscode.commands.registerCommand('claudeSessionChanges.showAliveOnly', () => setAliveOnly(true)),
    vscode.commands.registerCommand('claudeSessionChanges.showAll', () => setAliveOnly(false)),
    vscode.commands.registerCommand('claudeSessionChanges.pickWindow', pickWindow),
    vscode.commands.registerCommand('claudeSessionChanges.pickArchiveAfter', pickArchiveAfter),
    vscode.commands.registerCommand('claudeSessionChanges.searchConversations', (q) => searchConversations(typeof q === 'string' ? q : '')),
    vscode.commands.registerCommand('claudeSessionChanges.renameSession', (arg) => renameSession(arg)),
    vscode.commands.registerCommand('claudeSessionChanges.createGroup', () => createGroup()),
    vscode.commands.registerCommand('claudeSessionChanges.planTeam', (id) => planTeam(typeof id === 'string' ? id : undefined)),
    vscode.commands.registerCommand('claudeSessionChanges.addToGroup', (arg, id) => addToGroup(arg, typeof id === 'string' ? id : undefined)),
    vscode.commands.registerCommand('claudeSessionChanges.removeFromGroup', (arg) => removeFromGroup(arg)),
    vscode.commands.registerCommand('claudeSessionChanges.setSessionRole', (arg) => setSessionRole(arg)),
    vscode.commands.registerCommand('claudeSessionChanges.openGroupBoard', (id) => openGroupBoard(typeof id === 'string' ? id : undefined)),
    vscode.commands.registerCommand('claudeSessionChanges.renameGroup', (id) => renameGroup(typeof id === 'string' ? id : undefined)),
    vscode.commands.registerCommand('claudeSessionChanges.deleteGroup', (id) => deleteGroup(typeof id === 'string' ? id : undefined)),
    vscode.commands.registerCommand('claudeSessionChanges.copySummary', (arg) => copySummary(arg)),
    vscode.commands.registerCommand('claudeSessionChanges.copyFolderSummary', () => copyFolderSummary()),
    vscode.commands.registerCommand('claudeSessionChanges.sessionsForFile', (uri) => sessionsForFile(uri)),
    vscode.commands.registerCommand('claudeSessionChanges.resetOverlapIgnore', () => { saveOverlapIgnore([]); rebuild(); vscode.window.showInformationMessage(L('Overlap warnings are on again for every file.')); }),
    vscode.commands.registerCommand('claudeSessionChanges.openFileDiff', (el) => el && el.f && openFileDiff(el)),
    vscode.commands.registerCommand('claudeSessionChanges.openChangeDiff', (el) => el && el.c && openChangeDiff(el)),
    vscode.commands.registerCommand('claudeSessionChanges.openFile', (el) => {
      if (el && el.f && fs.existsSync(el.f.path)) return openPlain(el.f.path);
      return vscode.window.showInformationMessage(L('The file is not on disk anymore.'));
    }),
    vscode.commands.registerCommand('claudeSessionChanges.copyPath', (el) => el && el.f && vscode.env.clipboard.writeText(el.f.path)),
    vscode.commands.registerCommand('claudeSessionChanges.copySessionId', (el) => el && el.s && vscode.env.clipboard.writeText(el.s.sid)),
    vscode.commands.registerCommand('claudeSessionChanges.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)),
    treeView.onDidChangeVisibility((e) => { if (e.visible) requestScan(false); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCode.archiveInactiveSessions')) requestScan(true); // 다른 폴더 세션을 읽는 기간도 함께 바뀐다
      if (e.affectsConfiguration('workbench.reduceMotion')) updateExplorerMarks();
      if (!e.affectsConfiguration(CFG)) return;
      startTimer();
      if (['lookbackHours', 'includeCodex', 'attentionMarkerDir', 'sessionListDays', 'archiveAfter'].some((k) => e.affectsConfiguration(CFG + '.' + k))) requestScan(true);
      else { rebuild(); updateStatusBar(); }
    }),
    { dispose: () => { if (timer) clearInterval(timer); } },
  );
  startTimer();
  if (treeView.visible) requestScan(true);
  else if (backgroundWanted() || cfg().statusBar || cfg().notifyWaiting) requestStatus();
}

// 끌 때 읽은 결과를 한 번 저장하고 스레드를 닫는다
function deactivate() {
  if (timer) clearInterval(timer);
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  if (tabTimer) { clearTimeout(tabTimer); tabTimer = null; }
  if (boardTimer) { clearTimeout(boardTimer); boardTimer = null; }
  for (const b of boards.values()) if (b.watched) fs.unwatchFile(b.watched, b.onMemo);
  stopSpin();
  if (searchWorker) { try { searchWorker.terminate(); } catch { /* 이미 끝남 */ } searchWorker = null; }
  const w = worker;
  worker = null;
  if (!w) return undefined;
  return new Promise((resolve) => {
    try { w.postMessage({ type: 'save', opts: workerOpts() }); } catch { /* 무시 */ }
    setTimeout(() => { w.terminate().finally(resolve); }, 400);
  });
}

module.exports = { activate, deactivate, _test: { parseBoardRoles, hunksToSides, applyEdit, displayDir, fmtTime, sidesForCodex, sameTitle, sessionKeyOf, setCodexCli: (v) => { codexCli = v; hasCodexCli.fixed = true; } } };
