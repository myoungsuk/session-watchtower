'use strict';
// Session Watchtower: Claude Code 세션마다 상태와 바뀐 파일을 옆 창에 보여 준다. 읽기 전용(되돌리기 없음).
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

function cfg() {
  const c = vscode.workspace.getConfiguration(CFG);
  return {
    lookbackHours: Math.max(1, Number(c.get('lookbackHours', 24)) || 24),
    showShellGuesses: c.get('showShellGuesses', true) !== false,
    hideScratchpadFiles: c.get('hideScratchpadFiles', true) !== false,
    includeSubagents: c.get('includeSubagents', true) !== false,
    pollSeconds: Math.max(2, Number(c.get('pollSeconds', 5)) || 5),
    sessionDetails: c.get('sessionDetails', true) !== false,
    sessionListDays: Math.max(0, Math.min(365, Number(c.get('sessionListDays', 90)) || 0)),
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
    return { key: 'busy', label: L('Working'), short: L('Working'), time: sinceShort, text: `${L('Working')}${since}${quiet}`, icon: new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.green')) };
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
  liveTimer = setTimeout(() => { liveTimer = null; provider.fire(); scheduleLiveExpiry(); }, next + 200);
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
    out.push({ ...s, files: list, unresolved });
  }
  out.sort((a, b) => Number(inWorkspace(b)) - Number(inWorkspace(a)));
  model = out;
  if (treeView) {
    treeView.description = L('Last {0}h', o.lookbackHours) + (aliveOnly ? ' · ' + L('open only') : '');
    treeView.message = stillReading ? L('Reading more logs…') : undefined;
  }
  rebuildSessions();
  provider.fire();
  scheduleLiveExpiry();
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
      if (!model.length) return [{ t: 'info', label: aliveOnly ? L('No open sessions') : L('No files changed in the last {0}h', cfg().lookbackHours) }];
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
      it.description = [s.agent === 'codex' ? 'Codex' : '', st.text, L('{0} files', s.files.length)].filter(Boolean).join(' · ');
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
      it.description = [counts(f.add, f.del), fmtTime(f.lastTs), displayDir(f.path, s)].filter(Boolean).join('  ');
      const kinds = [...f.kinds].map((k) => kindText(k)).join(', ');
      it.tooltip = [
        f.path,
        live === 'editing' ? L('Being edited now: this file changed in the last {0} seconds while the session is working.', LIVE_MS / 1000) : null,
        live === 'approval' ? L('Waiting for your approval to edit this file.') : null,
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
function sessionRow(s) {
  const st = stateOf(s);
  const codex = s.agent === 'codex';
  const canOpen = !codex && inWorkspace(s);
  const hint = codex
    ? L('Codex session: open it from Codex · Buttons on the right: changed files / review all changes')
    : canOpen
      ? L('Click: open the Claude conversation · Buttons on the right: changed files / review all changes')
      : L('Session from another folder ({0}): open it from a VS Code window with that folder · Buttons on the right: changed files / review all changes', s.project);
  // 제목이 잘리지 않게 오른쪽에는 시간만(상태는 점 색). 사용자가 해야 할 일이 있는 "기다림"만 글자도 붙인다.
  const meta = st.key === 'waiting' ? [st.short, st.time].filter(Boolean).join(' · ') : st.time;
  const m = model.find((x) => x.sid === s.sid);
  const add = m ? m.files.reduce((a, f) => a + (f.add || 0), 0) : 0;
  const del = m ? m.files.reduce((a, f) => a + (f.del || 0), 0) : 0;
  return {
    sid: s.sid, title: s.title, state: st.key, meta, tip: sessionTooltip(s, st) + '\n' + hint, canOpen, alive: !!s.alive, codex,
    files: m ? m.files.length : 0, add, del, now: nowText(s, st), folder: inWorkspace(s) ? '' : s.project || '', worktree: s.worktree || '',
  };
}

function sessionsPayload() {
  const strings = {
    showChanges: L('Show changed files'), review: L('Review all changes'), newSession: L('New session'), active: L('Open'),
    // "열린 세션" = 지금 프로세스가 떠 있는 세션(작업 중·기다림·쉼). 작업 중인 것만 세는 숫자가 아니다
    activeTip: L('Show only sessions that are open right now (working, waiting or idle). The number counts this folder: {0}. Other folders: {1}.'),
    search: L('Search sessions'), noMatch: L('No matching sessions'), legend: L('What the colors mean'),
    archive: L('Archive'), unarchive: L('Restore from archive'), archivedTitle: L('Archived'), archiveRule: L('Choose when sessions move to Archived'),
    otherFolders: L('Other folders'), worktreeTip: L('Runs in a git worktree: {0}'),
    lgSessions: L('Sessions'), lgFiles: L('Changed files'), lgRow: L('Under each session'),
    lgBusy: L('Working'), lgWaiting: L('Waiting for you (approval or answer)'), lgDone: L('Just finished (less than 10 minutes ago)'), lgIdle: L('Idle'), lgOff: L('Off (no Claude process)'),
    lgA: L('Created in this session'), lgM: L('Modified in this session'), lgD: L('Not on disk anymore (deleted)'), lgQ: L('Guessed from shell commands (not certain)'),
    lgNow: L('What it is doing now'), lgDiff: L('Lines added / removed within the time range of the Changed files view'),
    // 변경 규모는 변경 파일 창의 "보는 기간" 안에서, 고칠 때마다 더한 합계(같은 줄을 여러 번 고치면 여러 번 셈)
    diffTip: L('Last {0} hours: {1} lines added, {2} removed (each edit counted)', cfg().lookbackHours, '{1}', '{2}'),
  };
  if (!loaded) return { message: lastError ? L('Read error') : L('Reading sessions…'), detail: lastError || '', strings };
  if (!sessionsModel.length && !archivedModel.length) return { message: L('No sessions in the last {0}h', cfg().lookbackHours), strings };
  const { mine, groups } = splitByFolder(sessionsModel);
  return {
    strings,
    compact: !cfg().sessionDetails,
    reading: stillReading ? L('Reading more logs…') : '',
    archived: archivedModel.map(sessionRow),
    archivedTip: autoArchiveDays() <= 0 ? L('Sessions you archived here.')
      : followsClaudeArchive()
        ? L('Sessions with no conversation for {0} day(s) (the Claude Code setting "Archive Inactive Sessions") and sessions you archived here.', autoArchiveDays())
        : L('Sessions with no conversation for {0} day(s) and sessions you archived here.', autoArchiveDays()),
    // 단추의 숫자는 이 폴더에서 열려 있는 세션 수(머리말의 작업·멈춤·쉼 합과 같다). 다른 폴더는 설명에만 적는다
    openHere: mine.filter((s) => s.alive).length,
    openElsewhere: groups.reduce((n, [, items]) => n + items.filter((s) => s.alive).length, 0),
    mine: mine.map(sessionRow),
    noneHere: mine.length ? '' : L('No sessions in this folder'),
    groups: groups.map(([key, items]) => ({
      key,
      desc: groupDescription(items, false),
      waiting: items.some((s) => s.alive && s.status === 'waiting'),
      tip: L('{0} session(s) from another folder ({1}). Expand to see them.\nConversations can only be opened from a VS Code window with that folder open.', items.length, key),
      rows: items.map(sessionRow),
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
  details.arch { margin-top: 8px; padding-top: 4px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25))); }
  .gicon { flex-shrink: 0; display: inline-flex; color: var(--vscode-descriptionForeground); }
  .gname { color: var(--vscode-foreground); font-weight: 600; opacity: 0.85; }
  .gcount { flex-shrink: 0; min-width: 18px; padding: 0 6px; font-size: 11px; line-height: 17px; text-align: center; border-radius: 9px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
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
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; saved.q = ''; saved.searchOpen = false; box.classList.remove('show'); save(); if (last) render(last); } });
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
  const gearIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></svg>';
  function row(r, inArchive) {
    const btn = (act, label, svg) => '<button class="act" data-act="' + act + '" data-sid="' + esc(r.sid) + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + svg + '</button>';
    const acts = (r.files && !inArchive ? btn('review', strings.review, reviewIcon) + btn('reveal', strings.showChanges, icon) : '')
      + (inArchive ? btn('unarchive', strings.unarchive, restoreIcon) : btn('archive', strings.archive, archiveIcon));
    const ds = diffstat(r.add || 0, r.del || 0);
    // 둘째 줄: 지금 하는 일(작업 중·기다림일 때)과 변경 규모. 둘 다 없으면 한 줄짜리
    const sub = !(last && last.compact) && (r.now || ds) ? '<div class="sub"><span class="now ' + esc(r.state) + '">' + esc(r.now) + '</span>' + ds + '</div>' : '';
    return '<div class="row' + (r.canOpen ? '' : ' other') + '" role="listitem" tabindex="0" data-sid="' + esc(r.sid) + '" data-open="' + (r.canOpen ? '1' : '') + '" title="' + esc(r.tip) + '">'
      + '<div class="l1"><span class="dot ' + esc(r.state) + '"></span><span class="title">' + esc(r.title) + '</span>'
      + (r.codex ? '<span class="tag">Codex</span>' : '')
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
      + lg('<span class="dot idle"></span>', s.lgIdle) + lg('<span class="dot off"></span>', s.lgOff)
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
    let h = mine.map((r) => row(r, false)).join('');
    if (p.noneHere && !filtering) h += '<div class="msg">' + esc(p.noneHere) + '</div>';
    let shown = mine.length;
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
    if (btn) { e.stopPropagation(); e.preventDefault(); vscode.postMessage({ type: btn.dataset.act, sid: btn.dataset.sid }); return; }
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

// Claude Code 세션 목록에서 행을 누를 때와 같은 명령(claude-vscode.editor.open)을 부른다.
// 인자 순서(세션 ID, 첫 프롬프트, 열 위치, 묶음 ID, 전체 편집기, 옵션)는 Claude Code 2.1.322 기준이라 판이 바뀌면 달라질 수 있다.
async function openClaudeSession(arg) {
  const sid = sidOf(arg);
  if (!sid) return;
  const s = raw.find((x) => x.sid === sid) || { sid, title: sid.slice(0, 8) };
  if (s.agent === 'codex' || sid.startsWith('codex:')) {
    return vscode.window.showInformationMessage(L('"{0}" is a Codex session. Open it from Codex.', s.title));
  }
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

async function revealSession(arg) {
  const sid = sidOf(arg);
  const s = model.find((x) => x.sid === sid);
  if (!s || !treeView) {
    return vscode.window.showInformationMessage(aliveOnly ? L('This session is hidden by the "open only" filter.') : L('This session has no changed files in the last {0}h.', cfg().lookbackHours));
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

function registerDiff(desc, name) {
  const id = String(++diffSeq);
  diffRegistry.set(id, desc);
  if (diffRegistry.size > 300) diffRegistry.delete(diffRegistry.keys().next().value);
  const mk = (side) => vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${id}/${side}/${name}` });
  return { left: mk('left'), right: mk('right') };
}

const contentProvider = {
  async provideTextDocumentContent(uri) {
    const parts = uri.path.split('/');
    const desc = diffRegistry.get(parts[1]);
    const side = parts[2];
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
async function diffPair(f) {
  const name = path.basename(f.path);
  const sd = await fileSides(f);
  if (sd.left === null) {
    const latest = f.changes.find((c) => loaderFor(c));
    if (!latest) return null;
    const u = registerDiff({ load: loaderFor(latest) }, name);
    return { left: u.left, right: u.right, title: `${kindText(latest.kind)} ${fmtTime(latest.ts, true)}` };
  }
  const u = registerDiff({ load: async () => ({ left: sd.left, right: sd.right === null ? '' : sd.right }) }, name);
  const right = sd.right !== null ? u.right : sd.exists ? vscode.Uri.file(f.path) : u.right;
  return { left: u.left, right, title: sd.title };
}

async function openFileDiff(el) {
  const { f } = el;
  const name = path.basename(f.path);
  const pair = await diffPair(f);
  if (!pair) {
    if (fs.existsSync(f.path)) return vscode.window.showTextDocument(vscode.Uri.file(f.path), { preview: true });
    return vscode.window.showInformationMessage(L('{0}: nothing to compare (the file no longer exists).', name));
  }
  await vscode.commands.executeCommand('vscode.diff', pair.left, pair.right, `${name} (${pair.title})`, { preview: true });
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
    return vscode.window.showInformationMessage(L('This session has no changed files in the last {0}h.', cfg().lookbackHours));
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: L('Preparing the changes of "{0}"…', s.title) }, async () => {
    const pairs = await mapLimit(s.files, 6, (f) => diffPair(f));
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
  } else if (m.type === 'same' && Date.now() - lastFire > 60000) {
    provider.fire(); // "N분 전·N분째" 글자만 새로
    sessionsWebview.post();
    updateStatusBar();
  }
  if (pending) {
    const p = pending;
    pending = null;
    requestScan(p.force);
  }
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if ((treeView && treeView.visible) || (sessionsView && sessionsView.visible)) requestScan(false);
    else if (cfg().statusBar) requestStatus();
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

function updateStatusBar() {
  if (!statusItem) return;
  if (!cfg().statusBar) { statusItem.hide(); return; }
  const groups = { busy: [], waiting: [], done: [], idle: [] };
  for (const s of statusSessions) {
    const k = stateOf(s).key;
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
  if (!statusSessions.length) md.appendMarkdown(L('No open sessions') + '\n\n');
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
  const items = [1, 3, 6, 12, 24, 48, 72, 168].map((h) => ({ label: h < 24 ? L('{0} hours', h) : L('{0} days', h / 24), description: h === cur ? L('current') : '', h }));
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
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand('claudeSessionChanges.refresh', () => requestScan(true)),
    vscode.commands.registerCommand('claudeSessionChanges.showAliveOnly', () => setAliveOnly(true)),
    vscode.commands.registerCommand('claudeSessionChanges.showAll', () => setAliveOnly(false)),
    vscode.commands.registerCommand('claudeSessionChanges.pickWindow', pickWindow),
    vscode.commands.registerCommand('claudeSessionChanges.pickArchiveAfter', pickArchiveAfter),
    vscode.commands.registerCommand('claudeSessionChanges.openFileDiff', (el) => el && el.f && openFileDiff(el)),
    vscode.commands.registerCommand('claudeSessionChanges.openChangeDiff', (el) => el && el.c && openChangeDiff(el)),
    vscode.commands.registerCommand('claudeSessionChanges.openFile', (el) => {
      if (el && el.f && fs.existsSync(el.f.path)) return vscode.window.showTextDocument(vscode.Uri.file(el.f.path), { preview: true });
      return vscode.window.showInformationMessage(L('The file is not on disk anymore.'));
    }),
    vscode.commands.registerCommand('claudeSessionChanges.copyPath', (el) => el && el.f && vscode.env.clipboard.writeText(el.f.path)),
    vscode.commands.registerCommand('claudeSessionChanges.copySessionId', (el) => el && el.s && vscode.env.clipboard.writeText(el.s.sid)),
    vscode.commands.registerCommand('claudeSessionChanges.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)),
    treeView.onDidChangeVisibility((e) => { if (e.visible) requestScan(false); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCode.archiveInactiveSessions')) requestScan(true); // 다른 폴더 세션을 읽는 기간도 함께 바뀐다
      if (!e.affectsConfiguration(CFG)) return;
      startTimer();
      if (['lookbackHours', 'includeCodex', 'attentionMarkerDir', 'sessionListDays', 'archiveAfter'].some((k) => e.affectsConfiguration(CFG + '.' + k))) requestScan(true);
      else { rebuild(); updateStatusBar(); }
    }),
    { dispose: () => { if (timer) clearInterval(timer); } },
  );
  startTimer();
  if (treeView.visible) requestScan(true);
  else if (cfg().statusBar) requestStatus();
}

// 끌 때 읽은 결과를 한 번 저장하고 스레드를 닫는다
function deactivate() {
  if (timer) clearInterval(timer);
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  const w = worker;
  worker = null;
  if (!w) return undefined;
  return new Promise((resolve) => {
    try { w.postMessage({ type: 'save', opts: workerOpts() }); } catch { /* 무시 */ }
    setTimeout(() => { w.terminate().finally(resolve); }, 400);
  });
}

module.exports = { activate, deactivate, _test: { hunksToSides, applyEdit, displayDir, fmtTime, sidesForCodex } };
