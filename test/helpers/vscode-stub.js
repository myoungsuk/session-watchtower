'use strict';
// VS Code 없이 extension.js 를 돌려 보기 위한 가짜 vscode 모듈.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

function install({ extDir, language = 'en', workspace, config = {} }) {
  const calls = [];
  const commands = new Map();
  const trees = {};
  const webviewProviders = {};
  const statusItems = [];
  const reveals = [];
  const state = { contentProvider: null, decoProvider: null, config: { ...config } };
  const bundle = language === 'ko' ? JSON.parse(fs.readFileSync(path.join(extDir, 'l10n', 'bundle.l10n.ko.json'), 'utf8')) : {};

  class EventEmitter { constructor() { this.ls = []; this.event = (f) => { this.ls.push(f); return { dispose() {} }; }; } fire(v) { this.ls.forEach((f) => f(v)); } }
  class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  ThemeIcon.File = new ThemeIcon('file');
  class ThemeColor { constructor(id) { this.id = id; } }
  class FileDecoration { constructor(badge, tooltip, color) { this.badge = badge; this.tooltip = tooltip; this.color = color; } }
  class MarkdownString { constructor(v) { this.value = v || ''; } appendMarkdown(s) { this.value += s; return this; } }
  const Uri = {
    from: (o) => ({ ...o, toString() { return `${o.scheme}:${o.path}${o.query ? '?' + o.query : ''}`; } }),
    file: (p) => ({ scheme: 'file', path: p, fsPath: p, toString() { return 'file://' + p; } }),
    parse: (s) => ({ scheme: String(s).split(':')[0], path: s, toString() { return s; } }),
  };
  const disposable = () => ({ dispose() {} });

  const vscode = {
    EventEmitter, TreeItem, ThemeIcon, ThemeColor, FileDecoration, MarkdownString, Uri,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Global: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    l10n: { t: (msg, ...args) => (bundle[msg] || msg).replace(/\{(\d+)\}/g, (m, i) => String(args[+i])) },
    env: { language, uriScheme: 'vscode', clipboard: { writeText: async () => {} }, openExternal: async (u) => { calls.push(['openExternal', String(u)]); } },
    window: {
      createTreeView: (id, o) => {
        const view = {
          id, provider: o.treeDataProvider, visible: true, onDidChangeVisibility: disposable, dispose() {},
          reveal: async (el, opt) => { reveals.push([id, o.treeDataProvider.getTreeItem(el).id, opt]); let x = el; while (x) { o.treeDataProvider.getTreeItem(x); x = o.treeDataProvider.getParent ? o.treeDataProvider.getParent(x) : undefined; } },
        };
        trees[id] = view;
        return view;
      },
      registerFileDecorationProvider: (p) => { state.decoProvider = p; return disposable(); },
      registerWebviewViewProvider: (id, p) => { webviewProviders[id] = p; return disposable(); },
      createStatusBarItem: (id) => { const it = { id, text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }; statusItems.push(it); return it; },
      showTextDocument: async (u) => { calls.push(['show', String(u)]); },
      showInformationMessage: async (m) => { calls.push(['info', m]); },
      createTerminal: (o) => { const t = { opts: o, sent: [], shown: false, show() { this.shown = true; }, sendText(x) { this.sent.push(x); } }; calls.push(['terminal', t]); return t; },
      showWarningMessage: async (m) => { calls.push(['warn', m]); },
      showQuickPick: async () => undefined,
      withProgress: async (o, fn) => fn({ report() {} }),
    },
    workspace: {
      workspaceFolders: workspace ? [{ uri: { fsPath: workspace } }] : [],
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
    globalState: { get: (k, d) => d, update: async () => {} },
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

  return { vscode, context, calls, commands, trees, statusItems, reveals, state, openWebview, changeConfig };
}

module.exports = { install };
