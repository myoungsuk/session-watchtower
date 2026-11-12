// Screenshot helper: opens the Session Watchtower side bar.
const vscode = require('vscode');
exports.activate = async () => {
  const run = (c, ...a) => vscode.commands.executeCommand(c, ...a).then(() => true, () => false);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  await run('workbench.action.closeAuxiliaryBar');
  await run('workbench.action.closePanel');
  await run('claudeSessionChanges.tree.focus');
  await sleep(500);
  await run('claudeSessionChanges.sessions.focus');
  await sleep(300);
  await run('workbench.action.focusActiveEditorGroup');
};
