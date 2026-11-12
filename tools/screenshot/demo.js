// Demo data for screenshots: writes made-up session logs and a registry of open sessions into a throwaway home.
// Usage: node demo.js <extension folder> <fake home> <workspace root> <pid,pid,...>
const [,, extDir, home, wsRoot, pidList] = process.argv;
const fs = require('fs'); const path = require('path');
const fx = require(path.join(extDir, 'test/helpers/fixture'));
const { rec } = fx;
const pids = pidList.split(',').map(Number);
const web = path.join(wsRoot, 'web-app'); const mob = path.join(wsRoot, 'mobile-app');
const now = Date.now(); const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const mk = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text || 'x\n'); const t = new Date(now - 20 * MIN); fs.utimesSync(f, t, t); };
const lines = (n, p) => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n') + '\n';
// an edit result with a added and d removed lines
const edit = (file, a, d) => ({ filePath: file, oldString: 'old', newString: 'new', originalFile: lines(40, 'line'), replaceAll: false, userModified: false,
  structuredPatch: [{ oldStart: 3, oldLines: d + 2, newStart: 3, newLines: a + 2, lines: [' ctx'].concat(Array.from({ length: d }, (_, i) => '-old ' + i), Array.from({ length: a }, (_, i) => '+new ' + i), [' ctx']) }] });
const sid = (n) => `d3300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let n = 0;
function session(cwd, title, recs, reg, mtimeAgo) {
  const id = sid(++n);
  const f = fx.claudeSession(home, cwd, id, [rec.user(cwd, now - 3 * HOUR, title), rec.aiTitle(id, title)].concat(recs));
  if (mtimeAgo) { const t = new Date(now - mtimeAgo); fs.utimesSync(f, t, t); }
  if (reg) fx.registerSession(home, reg.pid, id, { cwd, name: 'demo', nameSource: 'derived', ...reg.fields });
  return id;
}
const F = {
  auth: path.join(web, 'src/middleware/auth.ts'), store: path.join(web, 'src/lib/session-store.ts'), test: path.join(web, 'test/auth.test.ts'),
  legacy: path.join(web, 'src/middleware/legacy-auth.js'), pkg: path.join(web, 'package.json'),
  hook: path.join(web, 'src/api/webhooks.ts'), e2e1: path.join(web, 'e2e/checkout.spec.ts'), e2e2: path.join(web, 'e2e/helpers.ts'), e2e3: path.join(web, 'playwright.config.ts'),
  doc1: path.join(web, 'docs/api.md'), doc2: path.join(web, 'docs/errors.md'), build: path.join(web, 'scripts/build.mjs'), lint: path.join(web, 'scripts/lint.mjs'),
  sync: path.join(mob, 'app/src/main/kotlin/SyncQueue.kt'), draft: path.join(mob, 'app/src/main/kotlin/DraftStore.kt'), crash: path.join(mob, 'app/src/main/kotlin/App.kt'),
};
for (const [k, f] of Object.entries(F)) if (k !== 'legacy') mk(f, lines(30, k));
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
// a file guessed from the shell command text (?): make it look changed while the command ran
{ const t = new Date(now - 9 * MIN + 300); fs.utimesSync(F.pkg, t, t); }

// this folder (web-app)
session(web, 'Refactor auth middleware', [
  rec.toolUse(web, now - 16 * MIN, 't1', 'Write', { file_path: F.store, content: lines(87, 'store') }), rec.toolResult(now - 16 * MIN + 400, 't1', rec.writeResult(F.store, lines(87, 'store'))),
  rec.toolUse(web, now - 14 * MIN, 't2', 'Edit', { file_path: F.legacy, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 14 * MIN + 400, 't2', edit(F.legacy, 0, 12)),
  rec.toolUse(web, now - 12 * MIN, 't3', 'Edit', { file_path: F.test, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 12 * MIN + 400, 't3', edit(F.test, 31, 4)),
  rec.toolUse(web, now - 9 * MIN, 't4', 'Bash', { command: `cd ${web} && npm pkg set scripts.test="vitest" > package.json`, description: 'Update the test script' }), rec.toolResult(now - 9 * MIN + 600, 't4', rec.bashResult({})),
  rec.toolUse(web, now - 6 * MIN, 't5', 'Edit', { file_path: F.auth, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 6 * MIN + 400, 't5', edit(F.auth, 42, 18)),
  rec.toolUse(web, now - 20000, 't6', 'Bash', { command: 'npm test -- auth', description: 'npm test -- auth' }),
], { pid: pids[0], fields: { status: 'busy', statusUpdatedAt: now - 3 * MIN } });
session(web, 'Add payment webhooks', [
  rec.toolUse(web, now - 5 * MIN, 'w1', 'Edit', { file_path: F.hook, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 5 * MIN + 400, 'w1', edit(F.hook, 60, 4)),
  rec.toolUse(web, now - 70000, 'w2', 'Bash', { command: 'rm -rf build/ && npm run build', description: 'rm -rf build/ && npm run build' }),
], { pid: pids[1], fields: { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: now - 65000 } });
session(web, 'Fix flaky e2e tests', [
  rec.toolUse(web, now - 9 * MIN, 'e1', 'Edit', { file_path: F.e2e1, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 9 * MIN + 400, 'e1', edit(F.e2e1, 12, 21)),
  rec.toolUse(web, now - 7 * MIN, 'e2', 'Edit', { file_path: F.e2e2, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 7 * MIN + 400, 'e2', edit(F.e2e2, 6, 8)),
  rec.toolUse(web, now - 3 * MIN, 'e3', 'Edit', { file_path: F.e2e3, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 3 * MIN + 400, 'e3', edit(F.e2e3, 3, 1)),
  rec.user(web, now - 2 * MIN - 20000, 'thanks'),
], { pid: pids[2], fields: { status: 'idle', statusUpdatedAt: now - 2 * MIN } });
session(web, 'Update API docs', [
  rec.toolUse(web, now - 40 * MIN, 'd1', 'Edit', { file_path: F.doc1, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 40 * MIN + 400, 'd1', edit(F.doc1, 9, 7)),
  rec.toolUse(web, now - 30 * MIN, 'd2', 'Edit', { file_path: F.doc2, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 30 * MIN + 400, 'd2', edit(F.doc2, 3, 2)),
  rec.user(web, now - 25 * MIN, 'ok'),
], { pid: pids[3], fields: { status: 'idle', statusUpdatedAt: now - 25 * MIN } });
session(web, 'Spike: response cache layer', [rec.user(web, now - 2 * HOUR, 'park this')], null, 2 * HOUR);
// Codex in this folder (working: its log just changed)
const CX = 'c0de0000-9999-4999-8999-000000000009';
const js = (s) => JSON.stringify(s);
fx.codexSession(home, CX, [
  { timestamp: fx.iso(now - 4 * MIN), type: 'session_meta', payload: { id: CX, session_id: CX, cwd: web, originator: 'codex_vscode', source: 'vscode' } },
  { timestamp: fx.iso(now - 4 * MIN), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tidy up build scripts' }] } },
  { timestamp: fx.iso(now - 3 * MIN), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: `text(await tools.apply_patch(${js(`*** Begin Patch\n*** Update File: ${F.lint}\n@@\n${Array.from({ length: 5 }, (_, i) => '-old ' + i).join('\n')}\n${Array.from({ length: 9 }, (_, i) => '+new ' + i).join('\n')}\n*** End Patch`)}));` } },
  { timestamp: fx.iso(now - 3 * MIN + 500), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }] } },
  { timestamp: fx.iso(now - 20000), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: `text(await tools.apply_patch(${js(`*** Begin Patch\n*** Update File: ${F.build}\n@@\n${Array.from({ length: 7 }, (_, i) => '-old ' + i).join('\n')}\n${Array.from({ length: 26 }, (_, i) => '+new ' + i).join('\n')}\n*** End Patch`)}));` } },
], now);
// another folder (mobile-app)
session(mob, 'Offline sync for drafts', [
  rec.toolUse(mob, now - 20 * MIN, 'm1', 'Edit', { file_path: F.sync, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 20 * MIN + 400, 'm1', edit(F.sync, 150, 30)),
  rec.toolUse(mob, now - 10 * MIN, 'm2', 'Edit', { file_path: F.draft, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 10 * MIN + 400, 'm2', edit(F.draft, 60, 14)),
  rec.toolUse(mob, now - 30000, 'm3', 'Edit', { file_path: F.sync, old_string: 'a', new_string: 'b' }),
], { pid: pids[4], fields: { status: 'busy', statusUpdatedAt: now - 8 * MIN } });
session(mob, 'Crash on cold start', [
  rec.toolUse(mob, now - 70 * MIN, 'k1', 'Edit', { file_path: F.crash, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 70 * MIN + 400, 'k1', edit(F.crash, 9, 3)), rec.user(mob, now - 62 * MIN, 'ok'),
], { pid: pids[5], fields: { status: 'idle', statusUpdatedAt: now - 60 * MIN } });
session(mob, 'Bump Gradle plugin', [rec.user(mob, now - 3 * HOUR, 'later')], null, 3 * HOUR);
// twelve old sessions for the Archived section
const old = ['Set up CI cache', 'Migrate to pnpm', 'Dark mode toggle', 'Rate limit login', 'Fix date parsing', 'Profile page layout', 'Upgrade React Router', 'Audit npm packages', 'Add health check', 'Split vendor chunk', 'Retry failed uploads', 'Rename env vars'];
old.forEach((t, i) => { const ago = (16 + i * 2) * DAY; const id = sid(++n); const f = fx.claudeSession(home, web, id, [rec.user(web, now - ago - MIN, t), rec.aiTitle(id, t), rec.user(web, now - ago, 'done')]); fs.utimesSync(f, new Date(now - ago), new Date(now - ago)); });
console.log('demo sessions', n + 1, 'auth=' + F.auth);
