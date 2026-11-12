// Screenshot helper: opens the Session Watchtower side bar and, for some scenes, runs one of its commands.
const vscode = require('vscode');
const fs = require('fs');
exports.activate = async () => {
  const run = (c, ...a) => vscode.commands.executeCommand(c, ...a).then((v) => v, () => undefined);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scene = process.env.SWT_SCENE || 'side';
  let demo = {};
  try { demo = JSON.parse(fs.readFileSync(process.env.SWT_DEMO, 'utf8')); } catch { demo = { files: {}, sids: {} }; }
  await sleep(1500);
  await run('workbench.action.closeAuxiliaryBar');
  await run('workbench.action.closePanel');
  await run('claudeSessionChanges.tree.focus');
  await sleep(500);
  await run('claudeSessionChanges.sessions.focus');
  await sleep(300);
  await run('workbench.action.focusActiveEditorGroup');
  if (scene === 'tabs') {
    // stand-ins for Claude Code conversation tabs: webview panels with Claude Code's view type and the names it gives them (24 characters + "…")
    const label = (t) => (t.length > 25 ? t.substring(0, 24) + '…' : t);
    for (const t of ['Refactor auth middleware', 'Spike: response cache layer', 'Update API docs']) {
      const p = vscode.window.createWebviewPanel('claudeVSCodePanel', label(t), { viewColumn: vscode.ViewColumn.One, preserveFocus: true }, {});
      p.webview.html = '<body style="font-family:sans-serif;padding:20px">Stand-in for the Claude Code conversation "' + t + '"</body>';
    }
    return;
  }
  if (scene === 'side' || scene === 'toasts') return;
  if (scene === 'explorer') {
    // the built-in file Explorer, with one edited file visible and another inside a collapsed folder; the edited file is also open in a tab
    await sleep(6000);
    await run('workbench.view.explorer');
    await vscode.window.showTextDocument(vscode.Uri.file(demo.files.auth), { preview: false });
    await run('revealInExplorer', vscode.Uri.file(demo.files.auth));
    await run('workbench.action.focusActiveEditorGroup');
    return;
  }
  await sleep(9000); // let the extension read the demo sessions first
  if (scene === 'search') await run('claudeSessionChanges.searchConversations', 'token refresh');
  if (scene === 'file') run('claudeSessionChanges.sessionsForFile', vscode.Uri.file(demo.files.doc1));
  if (scene === 'review') await run('claudeSessionChanges.openSessionChanges', demo.sids['Refactor auth middleware']);
  if (scene === 'summary') {
    const md = await run('claudeSessionChanges.copyFolderSummary');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: String(md || '') });
    await vscode.window.showTextDocument(doc);
    await run('markdown.showPreview');
    await run('notifications.clearAll');
  }
};
