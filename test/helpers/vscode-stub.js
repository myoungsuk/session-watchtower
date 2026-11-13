'use strict';
// VS Code 없이 extension.js 를 돌려 보기 위한 가짜 vscode 모듈.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

function install({ extDir, language = 'en', workspace, config = {}, workspaceScheme = 'file', workspaceAuthority = '' }) {
  const calls = [];
  const commands = new Map();
  const trees = {};
  const webviewProviders = {};
  const statusItems = [];
  const reveals = [];
  const state = { contentProvider: null, decoProvider: null, decoProviders: [], config: { ...config } };
  const bundle = language === 'ko' ? JSON.parse(fs.readFileSync(path.join(extDir, 'l10n', 'bundle.l10n.ko.json'), 'utf8')) : {};

  class EventEmitter { constructor() { this.ls = []; this.event = (f) => { this.ls.push(f); return { dispose() {} }; }; } fire(v) { this.ls.forEach((f) => f(v)); } }
  class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  ThemeIcon.File = new ThemeIcon('file');
  class ThemeColor { constructor(id) { this.id = id; } }
  class FileDecoration { constructor(badge, tooltip, color) { this.badge = badge; this.tooltip = tooltip; this.color = color; } }
  class MarkdownString { constructor(v) { this.value = v || ''; } appendMarkdown(s) { this.value += s; return this; } }
  // scheme·authority만 바꾼 사본을 만들 수 있는 가짜 주소(원격 창에서는 탐색기가 vscode-remote 주소로 파일을 가리킨다)
  const mkUri = (scheme, authority, p) => ({ scheme, authority, path: p, fsPath: p, with(c) { return mkUri(c.scheme || scheme, c.authority === undefined ? authority : c.authority, c.path || p); }, toString() { return `${scheme}://${authority}${p}`; } });
  const Uri = {
    from: (o) => ({ ...o, toString() { return `${o.scheme}:${o.path}${o.query ? '?' + o.query : ''}`; } }),
    file: (p) => mkUri('file', '', p),
    parse: (s) => ({ scheme: String(s).split(':')[0], path: s, toString() { return s; } }),
  };
  const disposable = () => ({ dispose() {} });
  const tabEvents = new EventEmitter();
  const tabGroupEvents = new EventEmitter();

  const vscode = {
    EventEmitter, TreeItem, ThemeIcon, ThemeColor, FileDecoration, MarkdownString, Uri,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    ConfigurationTarget: { Global: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    l10n: { t: (msg, ...args) => (bundle[msg] || msg).replace(/\{(\d+)\}/g, (m, i) => String(args[+i])) },
    env: { language, uriScheme: 'vscode', clipboard: { writeText: async (t) => { state.clipboard = t; } }, openExternal: async (u) => { calls.push(['openExternal', String(u)]); } },
    window: {
      createTreeView: (id, o) => {
        const view = {
          id, provider: o.treeDataProvider, visible: true, onDidChangeVisibility: disposable, dispose() {},
          reveal: async (el, opt) => { reveals.push([id, o.treeDataProvider.getTreeItem(el).id, opt]); let x = el; while (x) { o.treeDataProvider.getTreeItem(x); x = o.treeDataProvider.getParent ? o.treeDataProvider.getParent(x) : undefined; } },
        };
        trees[id] = view;
        return view;
      },
      registerFileDecorationProvider: (p) => { state.decoProviders.push(p); if (!state.decoProvider) state.decoProvider = p; return disposable(); },
      registerWebviewViewProvider: (id, p) => { webviewProviders[id] = p; return disposable(); },
      createStatusBarItem: (id) => { const it = { id, text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }; statusItems.push(it); return it; },
      showTextDocument: async (u) => { calls.push(['show', String(u)]); },
      // state.answer(글, 단추들)로 알림 단추를 누른 것처럼 답할 수 있다
      showInformationMessage: async (m, ...b) => { calls.push(['info', m, b]); return state.answer ? state.answer(m, b) : undefined; },
      showInputBox: async (o) => { calls.push(['input', o]); return state.input === undefined ? undefined : typeof state.input === 'function' ? state.input(o) : state.input; },
      createTerminal: (o) => { const t = { opts: o, sent: [], shown: false, show() { this.shown = true; }, sendText(x) { this.sent.push(x); } }; calls.push(['terminal', t]); return t; },
      showWarningMessage: async (m, ...b) => { calls.push(['warn', m, b]); return state.answer ? state.answer(m, b) : undefined; },
      showQuickPick: async (items, o) => { calls.push(['pick', items, o]); return state.pick ? state.pick(items) : undefined; },
      // 입력 상자가 달린 고르기 창: 시험이 값을 넣고(type) 고를 수 있게 한다
      createQuickPick: () => {
        const ev = () => { const ls = []; const f = (cb) => { ls.push(cb); return disposable(); }; f.fire = (v) => ls.forEach((cb) => cb(v)); return f; };
        const qp = { value: '', items: [], busy: false, title: undefined, placeholder: '', selectedItems: [], activeItems: [], shown: false,
          onDidChangeValue: ev(), onDidAccept: ev(), onDidHide: ev(), onDidChangeSelection: ev(),
          show() { this.shown = true; }, hide() { this.shown = false; this.onDidHide.fire(); }, dispose() {},
          type(v) { this.value = v; this.onDidChangeValue.fire(v); }, accept(item) { this.selectedItems = [item]; this.onDidAccept.fire(); } };
        state.quickPick = qp;
        return qp;
      },
      withProgress: async (o, fn) => fn({ report() {} }),
      registerUriHandler: (h) => { state.uriHandler = h; return disposable(); },
      // 편집기 영역의 웹뷰(그룹 보드): 만든 화면을 state.panels에 모은다
      createWebviewPanel: (viewType, title) => {
        const posted = [];
        let onMessage = null;
        const disposeLs = [];
        const panel = {
          viewType, title, revealed: 0, disposed: false,
          webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage: (cb) => { onMessage = cb; return disposable(); }, postMessage: async (m) => { posted.push(m); return true; } },
          reveal() { this.revealed++; }, onDidDispose: (cb) => { disposeLs.push(cb); return disposable(); },
          dispose() { if (this.disposed) return; this.disposed = true; disposeLs.forEach((cb) => cb()); },
          posted, send: (m) => onMessage(m), lastPayload: () => { for (let i = posted.length - 1; i >= 0; i--) if (posted[i].type === 'render') return posted[i].payload; return null; },
        };
        (state.panels = state.panels || []).push(panel);
        return panel;
      },
      showOpenDialog: async (o) => { calls.push(['openDialog', o]); return state.openDialog ? [Uri.file(state.openDialog)] : undefined; },
      showSaveDialog: async (o) => { calls.push(['saveDialog', o]); return state.saveDialog ? Uri.file(state.saveDialog) : undefined; },
      // 편집기 탭: 시험이 setTabs로 바꾸고 알린다
      tabGroups: { all: [], onDidChangeTabs: tabEvents.event, onDidChangeTabGroups: tabGroupEvents.event },
    },
    workspace: {
      workspaceFolders: workspace ? [{ uri: mkUri(workspaceScheme, workspaceAuthority, workspace) }] : [],
      getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d), update: async (k, v) => { state.config[k] = v; } }),
      registerTextDocumentContentProvider: (scheme, p) => { state.contentProvider = p; return disposable(); },
      onDidChangeConfiguration: (cb) => { state.onConfig = cb; return disposable(); },
    },
    commands: {
      registerCommand: (id, f) => { commands.set(id, f); return disposable(); },
      executeCommand: async (id, ...a) => { calls.push([id, ...a]); },
    },
  };

  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? 'vscode' : orig.call(this, request, ...rest); };
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

  const context = {
    subscriptions: [],
    // 확장이 기억해 두는 값(접어 둔 칸 등): 같은 시험 파일 안에서는 남는다
    globalState: { store: {}, get(k, d) { return k in this.store ? this.store[k] : d; }, async update(k, v) { this.store[k] = v; } },
    globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'swt-storage-')) },
    extension: { id: 'kms-labs.session-watchtower' },
  };

  // 세션 상태 웹뷰를 열어 주고, 확장이 그려 달라고 보낸 내용을 모은다
  function openWebview(id) {
    const posted = [];
    let onMessage = null;
    const view = {
      visible: true, description: '', badge: undefined, onDidChangeVisibility: disposable, onDidDispose: disposable,
      webview: { options: {}, html: '', cspSource: 'vscode-resource:', onDidReceiveMessage: (cb) => { onMessage = cb; return disposable(); }, postMessage: async (m) => { posted.push(m); return true; } },
    };
    webviewProviders[id].resolveWebviewView(view);
    return { view, posted, send: (m) => onMessage(m), lastPayload: () => (posted.length ? posted[posted.length - 1].payload : null) };
  }

  // 설정을 바꾸고 확장에 알린다
  function changeConfig(key, value) {
    state.config[key] = value;
    if (state.onConfig) state.onConfig({ affectsConfiguration: (k) => k === 'claudeSessionChanges' || k === 'claudeSessionChanges.' + key });
  }

  // 편집기 탭을 바꾸고 알린다. groups: [[{ label, viewType, active }]] — 탭 묶음마다 탭 목록(viewType이 없으면 글 편집기 탭, active는 그 묶음에서 앞에 보이는 탭)
  function setTabs(groups) {
    vscode.window.tabGroups.all = groups.map((tabs, gi) => ({ isActive: gi === 0, tabs: tabs.map((t) => ({ label: t.label, isActive: !!t.active, input: t.viewType ? { viewType: t.viewType } : { uri: Uri.file('/x/' + t.label) } })) }));
    tabEvents.fire({ opened: [], closed: [], changed: [] });
  }

  // 다른 묶음의 설정(예: workbench.reduceMotion)을 바꾸고 알린다
  function changeSetting(fullKey, value) {
    state.config[fullKey.split('.').pop()] = value;
    if (state.onConfig) state.onConfig({ affectsConfiguration: (k) => k === fullKey || fullKey.startsWith(k + '.') });
  }

  return { vscode, context, calls, commands, trees, statusItems, reveals, state, openWebview, changeConfig, changeSetting, setTabs, mkUri };
}

module.exports = { install };
