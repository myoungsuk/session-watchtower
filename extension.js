'use strict';
// Session Watchtower: Claude Code 세션마다 상태와 바뀐 파일을 옆 창에 보여 준다. 읽기 전용(되돌리기 없음).
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');

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
let lastError = null;
let lastFire = 0;
let aliveOnly = false;
let timer = null;
let treeView = null;
let sessionsView = null;
let sessionsModel = [];
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
  if (s.status === 'idle' && s.statusSince && Date.now() - s.statusSince < DONE_MS) {
    return { key: 'done', label: L('Just finished'), short: L('Just finished'), time: sinceShort, text: `${L('Just finished')}${since}`, icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.orange')) };
  }
  if (s.status === 'idle') {
    return { key: 'idle', label: L('Idle'), short: L('Idle'), time: sinceShort, text: `${L('Idle')}${since}`, icon: new vscode.ThemeIcon('debug-pause') };
  }
  return { key: 'alive', label: L('Running'), short: L('Running'), time: '', text: L('Running'), icon: new vscode.ThemeIcon('circle-filled') };
}


function sessionTooltip(s, st) {
  return [
    s.title,
    L('Status: {0}', st.label) + (s.statusSince ? ' ' + L('(since {0})', fmtTime(s.statusSince, true)) : ''),
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

const kindText = (k) => ({ edit: L('edit tool'), bash: L('shell command'), shell: L('shell command (guessed)'), commit: L('commit') })[k] || k;

// ---------- 모델 → 화면 묶음 ----------

let model = [];

function rebuild() {
  const o = cfg();
  const out = [];
  for (const s of raw) {
    if (aliveOnly && !s.alive) continue;
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
      const exact = f.changes.filter((c) => c.kind === 'edit' || c.kind === 'bash');
      const src = exact.length ? exact : f.changes.filter((c) => c.kind === 'commit');
      for (const c of src) { f.add += c.add || 0; f.del += c.del || 0; }
      const oldest = f.changes[f.changes.length - 1];
      f.created = !!(oldest && oldest.created);
      f.badge = f.created ? 'A' : (f.kinds.has('edit') || f.kinds.has('bash')) ? 'M' : f.kinds.has('commit') ? 'C' : 'S';
    }
    list.sort((a, b) => b.lastTs - a.lastTs);
    if (!list.length && !unresolved.length && !s.alive) continue;
    out.push({ ...s, files: list, unresolved });
  }
  out.sort((a, b) => Number(inWorkspace(b)) - Number(inWorkspace(a)));
  model = out;
  if (treeView) treeView.description = L('Last {0}h', o.lookbackHours) + (aliveOnly ? ' · ' + L('running only') : '');
  rebuildSessions();
  provider.fire();
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
  const recent = (items) => Math.max(...items.map((s) => Math.max(s.lastActivity || 0, s.statusSince || 0)));
  const alive = (items) => items.some((s) => s.alive);
  const sorted = [...groups.entries()].sort((a, b) => Number(alive(b[1])) - Number(alive(a[1])) || recent(b[1]) - recent(a[1]));
  return { mine, groups: sorted };
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
  const recent = (s) => Math.max(s.lastActivity || 0, s.statusSince || 0);
  sessionsModel = [...raw].sort((a, b) => (a.alive === b.alive ? 0 : a.alive ? -1 : 1) || recent(b) - recent(a));
  const n = countStates(raw.filter(inWorkspace));
  const all = countStates(raw);
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
      if (!model.length) return [{ t: 'info', label: aliveOnly ? L('No running sessions') : L('No files changed in the last {0}h', cfg().lookbackHours) }];
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
      it.description = [st.text, L('{0} files', s.files.length)].join(' · ');
      it.iconPath = st.icon;
      it.tooltip = sessionTooltip(s, st);
      it.contextValue = 'session';
      return it;
    }
    if (el.t === 'file') {
      const { s, f } = el;
      const it = new vscode.TreeItem(path.basename(f.path), N.Collapsed);
      it.id = `f:${s.sid}|${f.path}`;
      it.resourceUri = vscode.Uri.from({ scheme: ITEM_SCHEME, path: f.path, query: f.badge });
      it.iconPath = vscode.ThemeIcon.File;
      it.description = [counts(f.add, f.del), fmtTime(f.lastTs), displayDir(f.path, s)].filter(Boolean).join('  ');
      const kinds = [...f.kinds].map((k) => kindText(k)).join(', ');
      it.tooltip = [
        f.path,
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
        icon = new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.yellow'));
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
  const canOpen = inWorkspace(s);
  const hint = canOpen
    ? L('Click: open the Claude conversation · Button on the right: show changed files')
    : L('Session from another folder ({0}): open it from a VS Code window with that folder · Button on the right: show changed files', s.project);
  // 제목이 잘리지 않게 오른쪽에는 시간만(상태는 점 색). 사용자가 해야 할 일이 있는 "기다림"만 글자도 붙인다.
  const meta = st.key === 'waiting' ? [st.short, st.time].filter(Boolean).join(' · ') : st.time;
  return { sid: s.sid, title: s.title, state: st.key, meta, tip: sessionTooltip(s, st) + '\n' + hint, canOpen, alive: !!s.alive };
}

function sessionsPayload() {
  const strings = { showChanges: L('Show changed files'), newSession: L('New session'), active: L('Active'), search: L('Search sessions'), noMatch: L('No matching sessions') };
  if (!loaded) return { message: lastError ? L('Read error') : L('Reading sessions…'), detail: lastError || '', strings };
  if (!sessionsModel.length) return { message: L('No sessions in the last {0}h', cfg().lookbackHours), strings };
  const { mine, groups } = splitByFolder(sessionsModel);
  return {
    strings,
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
  .row { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 0 8px 0 16px; cursor: pointer; font-size: 13.5px; outline: none; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .row.other { cursor: default; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex-shrink: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .act { flex-shrink: 0; display: inline-flex; visibility: hidden; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; }
  .row:hover .act, .act:focus-visible { visibility: visible; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground); }
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
  .gname { color: var(--vscode-foreground); font-weight: 600; }
  .gdesc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bell { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-blue); flex-shrink: 0; }
  details .row { padding-left: 30px; }
  .msg { padding: 8px 16px; color: var(--vscode-descriptionForeground); font-size: 12.5px; }
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
</div>
<div class="search" id="searchBox"><input id="q" type="text" autocomplete="off" spellcheck="false"></div>
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
  function row(r) {
    return '<div class="row' + (r.canOpen ? '' : ' other') + '" role="listitem" tabindex="0" data-sid="' + esc(r.sid) + '" data-open="' + (r.canOpen ? '1' : '') + '" title="' + esc(r.tip) + '">'
      + '<span class="dot ' + esc(r.state) + '"></span><span class="title">' + esc(r.title) + '</span><span class="meta">' + esc(r.meta) + '</span>'
      + '<button class="act" data-act="reveal" data-sid="' + esc(r.sid) + '" title="' + esc(strings.showChanges) + '" aria-label="' + esc(strings.showChanges) + '">' + icon + '</button></div>';
  }
  function render(p) {
    last = p;
    strings = p.strings || {};
    document.getElementById('lblNew').textContent = strings.newSession || '';
    btnSearch.title = strings.search || '';
    btnSearch.setAttribute('aria-label', strings.search || '');
    q.placeholder = strings.search || '';
    if (p.message) { document.getElementById('lblActive').textContent = strings.active || ''; root.innerHTML = '<div class="msg" title="' + esc(p.detail) + '">' + esc(p.message) + '</div>'; return; }
    const all = (p.mine || []).concat(...(p.groups || []).map((g) => g.rows));
    document.getElementById('lblActive').textContent = (strings.active || '') + ' · ' + all.filter((r) => r.alive).length;
    btnActive.classList.toggle('on', saved.active);
    btnActive.setAttribute('aria-pressed', String(saved.active));
    const needle = saved.q.trim().toLowerCase();
    const keep = (r) => (!saved.active || r.alive) && (!needle || String(r.title).toLowerCase().includes(needle));
    const filtering = saved.active || !!needle;
    const mine = (p.mine || []).filter(keep);
    let h = mine.map(row).join('');
    if (p.noneHere && !filtering) h += '<div class="msg">' + esc(p.noneHere) + '</div>';
    let shown = mine.length;
    for (const g of p.groups || []) {
      const rows = g.rows.filter(keep);
      if (filtering && !rows.length) continue;
      shown += rows.length;
      const open = needle ? rows.length > 0 : !!saved.open[g.key];
      h += '<details data-key="' + esc(g.key) + '"' + (open ? ' open' : '') + '><summary title="' + esc(g.tip) + '"><span class="chev">›</span>'
        + (g.waiting ? '<span class="bell"></span>' : '') + '<span class="gname">' + esc(g.key) + '</span><span class="gdesc">' + esc(g.desc) + '</span></summary>'
        + rows.map(row).join('') + '</details>';
    }
    if (filtering && !shown) h = '<div class="msg">' + esc(strings.noMatch) + '</div>';
    root.innerHTML = h;
  }
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) { e.stopPropagation(); vscode.postMessage({ type: btn.dataset.act, sid: btn.dataset.sid }); return; }
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
    return vscode.window.showInformationMessage(aliveOnly ? L('This session is hidden by the "running only" filter.') : L('This session has no changed files in the last {0}h.', cfg().lookbackHours));
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
  const L = [];
  const R = [];
  (Array.isArray(hunks) ? hunks : []).forEach((h, i) => {
    if (i > 0 || (h && h.oldStart > 1)) {
      const sep = `⋯ ${L('(near line {0})', h.oldStart)} ⋯`;
      L.push(sep);
      R.push(sep);
    }
    for (const l of (h && h.lines) || []) {
      if (typeof l !== 'string') continue;
      const p = l[0];
      const t = l.slice(1);
      if (p === ' ') { L.push(t); R.push(t); } else if (p === '-') L.push(t); else if (p === '+') R.push(t);
    }
  });
  return { left: L.join('\n'), right: R.join('\n'), partial: true };
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
  if (c.kind === 'commit' && c.top) return () => sidesForCommit(c);
  return null;
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

async function openFileDiff(el) {
  const { f } = el;
  const name = path.basename(f.path);
  const exists = fs.existsSync(f.path);
  const oldest = f.changes[f.changes.length - 1];
  let left = null;
  let title = L("before session's first change ↔ now");
  if (oldest.created) {
    left = '';
    title = L('new file ↔ now');
  } else if (oldest.kind === 'edit') {
    try {
      const s = await sidesForEdit(oldest);
      if (!s.partial) left = s.left;
    } catch { left = null; }
  } else if (oldest.kind === 'commit' && oldest.top) {
    const t = await git(['show', `${oldest.sha}^:${oldest.rel}`], oldest.top);
    left = t === null ? '' : t;
  }
  if (left === null && exists) {
    const t = await commitTextBefore(f.path, oldest.ts);
    if (t !== null) { left = t; title = L("last commit before session's first change ↔ now"); }
  }
  if (left === null) {
    const latest = f.changes.find((c) => loaderFor(c));
    if (latest) return openChangeDiff({ ...el, t: 'change', c: latest });
    if (exists) return vscode.window.showTextDocument(vscode.Uri.file(f.path), { preview: true });
    return vscode.window.showInformationMessage(L('{0}: nothing to compare (the file no longer exists).', name));
  }
  const leftText = left;
  const u = registerDiff({ load: async () => ({ left: leftText, right: '' }) }, name);
  const right = exists ? vscode.Uri.file(f.path) : u.right;
  await vscode.commands.executeCommand('vscode.diff', u.left, right, `${name} (${title})`, { preview: true });
}

// ---------- 파일 장식(A/M/C/S 글자) ----------

const decorations = {
  provideFileDecoration(uri) {
    if (uri.scheme !== ITEM_SCHEME) return undefined;
    switch (uri.query) {
      case 'A': return new vscode.FileDecoration('A', L('Created in this session'), new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
      case 'M': return new vscode.FileDecoration('M', L('Modified in this session'), new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
      case 'C': return new vscode.FileDecoration('C', L("Only seen in this session's commits"), new vscode.ThemeColor('charts.purple'));
      case 'S': return new vscode.FileDecoration('S', L('Guessed from shell commands'), new vscode.ThemeColor('charts.yellow'));
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
    ensureWorker().postMessage({ type: 'scan', id: ++reqId, opts: { lookbackHours: cfg().lookbackHours, force: !!force } });
  } catch (e) {
    inflight = false;
    lastError = String((e && e.message) || e);
    provider.fire();
  }
}

function onWorkerMessage(m) {
  inflight = false;
  if (m.type === 'error') {
    lastError = String(m.message || '').split('\n')[0];
    provider.fire();
  } else if (m.type === 'result') {
    lastError = null;
    loaded = true;
    raw = m.sessions || [];
    rebuild();
  } else if (m.type === 'same' && Date.now() - lastFire > 60000) {
    provider.fire(); // "N분 전·N분째" 글자만 새로
    sessionsWebview.post();
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
  }, cfg().pollSeconds * 1000);
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
  context.subscriptions.push(
    treeView,
    vscode.window.registerWebviewViewProvider(SESSIONS_VIEW, sessionsWebview),
    vscode.commands.registerCommand('claudeSessionChanges.revealSession', (arg) => revealSession(arg)),
    vscode.commands.registerCommand('claudeSessionChanges.openClaudeSession', (arg) => openClaudeSession(arg)),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand('claudeSessionChanges.refresh', () => requestScan(true)),
    vscode.commands.registerCommand('claudeSessionChanges.showAliveOnly', () => setAliveOnly(true)),
    vscode.commands.registerCommand('claudeSessionChanges.showAll', () => setAliveOnly(false)),
    vscode.commands.registerCommand('claudeSessionChanges.pickWindow', pickWindow),
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
      if (!e.affectsConfiguration(CFG)) return;
      startTimer();
      if (e.affectsConfiguration(CFG + '.lookbackHours')) requestScan(true);
      else rebuild();
    }),
    { dispose: () => { if (timer) clearInterval(timer); if (worker) worker.terminate(); worker = null; } },
  );
  startTimer();
  if (treeView.visible) requestScan(true);
}

function deactivate() {
  if (timer) clearInterval(timer);
  if (worker) worker.terminate();
  worker = null;
}

module.exports = { activate, deactivate, _test: { hunksToSides, applyEdit, displayDir, fmtTime } };
