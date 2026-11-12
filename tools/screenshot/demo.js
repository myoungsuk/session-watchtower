// Demo data for screenshots: writes made-up session logs and a registry of open sessions into a throwaway home.
// Usage: node demo.js <extension folder> <fake home> <workspace root> <pid,pid,...>   → also writes <fake home>/demo.json
const [,, extDir, home, wsRoot, pidList] = process.argv;
const fs = require('fs'); const path = require('path');
const fx = require(path.join(extDir, 'test/helpers/fixture'));
const { rec } = fx;
const pids = pidList.split(',').map(Number);
const web = path.join(wsRoot, 'web-app'); const mob = path.join(wsRoot, 'mobile-app');
const now = Date.now(); const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const mk = (f, text, agoMs) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text || 'x\n'); const t = new Date(now - (agoMs || 20 * MIN)); fs.utimesSync(f, t, t); };
const lines = (n, p) => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n') + '\n';
// an edit result with a added and d removed lines (made-up content)
const edit = (file, a, d) => ({ filePath: file, oldString: 'old', newString: 'new', originalFile: lines(40, 'line'), replaceAll: false, userModified: false,
  structuredPatch: [{ oldStart: 3, oldLines: d + 2, newStart: 3, newLines: a + 2, lines: [' ctx'].concat(Array.from({ length: d }, (_, i) => '-old ' + i), Array.from({ length: a }, (_, i) => '+new ' + i), [' ctx']) }] });
// an edit result with real text, so the diff views show something readable
const realEdit = (file, original, oldStr, newStr) => {
  const o = oldStr.split('\n'); const n = newStr.split('\n');
  return { filePath: file, oldString: oldStr, newString: newStr, originalFile: original, replaceAll: false, userModified: false,
    structuredPatch: [{ oldStart: 1, oldLines: o.length, newStart: 1, newLines: n.length, lines: o.map((l) => '-' + l).concat(n.map((l) => '+' + l)) }] };
};
const sid = (n) => `d3300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let n = 0;
const out = { web, sids: {}, logs: {}, pids: {}, files: {} };
function session(cwd, title, recs, reg, mtimeAgo, firstPrompt) {
  const id = sid(++n);
  const f = fx.claudeSession(home, cwd, id, [rec.user(cwd, now - 3 * HOUR, firstPrompt || title), rec.aiTitle(id, title)].concat(recs));
  if (mtimeAgo) { const t = new Date(now - mtimeAgo); fs.utimesSync(f, t, t); }
  if (reg) fx.registerSession(home, reg.pid, id, { cwd, name: 'demo', nameSource: 'derived', ...reg.fields });
  out.sids[title] = id; out.logs[title] = f; if (reg) out.pids[title] = reg.pid;
  return id;
}
const F = {
  auth: path.join(web, 'src/middleware/auth.ts'), store: path.join(web, 'src/lib/session-store.ts'), test: path.join(web, 'test/auth.test.ts'),
  legacy: path.join(web, 'src/middleware/legacy-auth.js'), pkg: path.join(web, 'package.json'),
  hook: path.join(web, 'src/api/webhooks.ts'), e2e1: path.join(web, 'e2e/checkout.spec.ts'), e2e2: path.join(web, 'e2e/helpers.ts'), e2e3: path.join(web, 'playwright.config.ts'),
  doc1: path.join(web, 'docs/api.md'), doc2: path.join(web, 'docs/errors.md'), build: path.join(web, 'scripts/build.mjs'), lint: path.join(web, 'scripts/lint.mjs'),
  dates: path.join(web, 'src/lib/dates.ts'),
  sync: path.join(mob, 'app/src/main/kotlin/SyncQueue.kt'), draft: path.join(mob, 'app/src/main/kotlin/DraftStore.kt'), crash: path.join(mob, 'app/src/main/kotlin/App.kt'),
};
out.files = F;
for (const [k, f] of Object.entries(F)) if (k !== 'legacy') mk(f, lines(30, k));
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
// a file guessed from the shell command text (?): make it look changed while the command ran
{ const t = new Date(now - 9 * MIN + 300); fs.utimesSync(F.pkg, t, t); }

// readable content for the session whose changes are opened in the "review all changes" picture
const AUTH_OLD = `import { verify } from './jwt';

export async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'missing token' });
  }
  try {
    req.user = verify(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'bad token' });
  }
}
`;
const AUTH_FROM = `  try {
    req.user = verify(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'bad token' });
  }`;
const AUTH_TO = `  const session = await getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'session expired' });
  }
  if (session.needsRefresh()) {
    res.setHeader('x-refreshed-token', await session.refresh());
  }
  req.user = session.user;
  next();`;
const AUTH_IMPORT_FROM = "import { verify } from './jwt';";
const AUTH_IMPORT_TO = "import { getSession } from '../lib/session-store';";
const STORE = `import { verify, sign } from '../middleware/jwt';

const REFRESH_BEFORE_MS = 5 * 60 * 1000;

export class Session {
  constructor(public user: User, private expiresAt: number) {}

  needsRefresh(): boolean {
    return this.expiresAt - Date.now() < REFRESH_BEFORE_MS;
  }

  async refresh(): Promise<string> {
    this.expiresAt = Date.now() + 60 * 60 * 1000;
    return sign({ sub: this.user.id, exp: this.expiresAt });
  }
}

export async function getSession(token: string): Promise<Session | null> {
  try {
    const claims = verify(token);
    return new Session(await loadUser(claims.sub), claims.exp);
  } catch {
    return null;
  }
}
`;
const TEST_OLD = `import { auth } from '../src/middleware/auth';

test('rejects a bad token', async () => {
  const res = await call(auth, { authorization: 'Bearer nope' });
  expect(res.status).toBe(401);
});
`;
const TEST_FROM = `  expect(res.status).toBe(401);
});`;
const TEST_TO = `  expect(res.status).toBe(401);
  expect(res.body.error).toBe('session expired');
});

test('refreshes a token that is about to expire', async () => {
  const res = await call(auth, { authorization: 'Bearer ' + expiringSoon() });
  expect(res.headers['x-refreshed-token']).toBeDefined();
});`;
const authStep1 = AUTH_OLD.replace(AUTH_IMPORT_FROM, AUTH_IMPORT_TO);
fs.writeFileSync(F.auth, authStep1.replace(AUTH_FROM, AUTH_TO));
fs.writeFileSync(F.store, STORE);
fs.writeFileSync(F.test, TEST_OLD.replace(TEST_FROM, TEST_TO));
for (const f of [F.auth, F.store, F.test]) { const t = new Date(now - 6 * MIN); fs.utimesSync(f, t, t); }

// this folder (web-app)
session(web, 'Refactor auth middleware', [
  rec.toolUse(web, now - 16 * MIN, 't1', 'Write', { file_path: F.store, content: STORE }), rec.toolResult(now - 16 * MIN + 400, 't1', rec.writeResult(F.store, STORE)),
  rec.toolUse(web, now - 14 * MIN, 't2', 'Edit', { file_path: F.legacy, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 14 * MIN + 400, 't2', edit(F.legacy, 0, 12)),
  rec.toolUse(web, now - 12 * MIN, 't3', 'Edit', { file_path: F.test, old_string: TEST_FROM, new_string: TEST_TO }), rec.toolResult(now - 12 * MIN + 400, 't3', realEdit(F.test, TEST_OLD, TEST_FROM, TEST_TO)),
  rec.toolUse(web, now - 9 * MIN, 't4', 'Bash', { command: `cd ${web} && npm pkg set scripts.test="vitest" > package.json`, description: 'Update the test script' }), rec.toolResult(now - 9 * MIN + 600, 't4', rec.bashResult({})),
  rec.toolUse(web, now - 7 * MIN, 't5', 'Edit', { file_path: F.auth, old_string: AUTH_IMPORT_FROM, new_string: AUTH_IMPORT_TO }), rec.toolResult(now - 7 * MIN + 400, 't5', realEdit(F.auth, AUTH_OLD, AUTH_IMPORT_FROM, AUTH_IMPORT_TO)),
  rec.toolUse(web, now - 6 * MIN, 't6', 'Edit', { file_path: F.auth, old_string: AUTH_FROM, new_string: AUTH_TO }), rec.toolResult(now - 6 * MIN + 400, 't6', realEdit(F.auth, authStep1, AUTH_FROM, AUTH_TO)),
  rec.user(web, now - 5 * MIN, 'Good. Now make the tests cover the token refresh path and run them.'),
  rec.toolUse(web, now - 20000, 't7', 'Bash', { command: 'npm test -- auth', description: 'npm test -- auth' }),
], { pid: pids[0], fields: { status: 'busy', statusUpdatedAt: now - 3 * MIN } }, 0, 'Refactor the auth middleware so that token refresh happens in one place.');
// two subagents of that session are still writing to their logs
for (const name of ['agent-tests', 'agent-callers']) fx.subagentSession(home, web, sid(n), name, [rec.toolUse(web, now - 5000, 'sa-' + name, 'Bash', { command: 'rg getSession src', description: 'Find callers' })]);
session(web, 'Add payment webhooks', [
  rec.toolUse(web, now - 5 * MIN, 'w1', 'Edit', { file_path: F.hook, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 5 * MIN + 400, 'w1', edit(F.hook, 60, 4)),
  rec.toolUse(web, now - 4 * MIN, 'w0', 'Edit', { file_path: F.doc1, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 4 * MIN + 400, 'w0', edit(F.doc1, 14, 0)),
  rec.toolUse(web, now - 70000, 'w2', 'Bash', { command: 'rm -rf build/ && npm run build', description: 'rm -rf build/ && npm run build' }),
], { pid: pids[1], fields: { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: now - 65000 } }, 0, 'Add a webhook endpoint for payment events and verify the signature.');
session(web, 'Fix flaky e2e tests', [
  rec.toolUse(web, now - 9 * MIN, 'e1', 'Edit', { file_path: F.e2e1, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 9 * MIN + 400, 'e1', edit(F.e2e1, 12, 21)),
  rec.toolUse(web, now - 7 * MIN, 'e2', 'Edit', { file_path: F.e2e2, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 7 * MIN + 400, 'e2', edit(F.e2e2, 6, 8)),
  rec.toolUse(web, now - 3 * MIN, 'e3', 'Edit', { file_path: F.e2e3, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 3 * MIN + 400, 'e3', edit(F.e2e3, 3, 1)),
  rec.user(web, now - 2 * MIN - 20000, 'thanks'),
], { pid: pids[2], fields: { status: 'idle', statusUpdatedAt: now - 2 * MIN } }, 0, 'The checkout e2e test fails one run in five. Find out why and fix it.');
// a working session that has not written anything for a while (the "may be stuck" warning)
session(web, 'Migrate date helpers', [
  rec.toolUse(web, now - 15 * MIN, 'g1', 'Edit', { file_path: F.dates, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 15 * MIN + 400, 'g1', edit(F.dates, 22, 30)),
  rec.toolUse(web, now - 12 * MIN, 'g2', 'Bash', { command: 'npm run migrate:dates', description: 'npm run migrate:dates' }),
], { pid: pids[6], fields: { status: 'busy', statusUpdatedAt: now - 16 * MIN } }, 0, 'Move the date helpers to the new date library and update every caller.');
session(web, 'Update API docs', [
  rec.toolUse(web, now - 40 * MIN, 'd1', 'Edit', { file_path: F.doc1, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 40 * MIN + 400, 'd1', edit(F.doc1, 9, 7)),
  rec.toolUse(web, now - 30 * MIN, 'd2', 'Edit', { file_path: F.doc2, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 30 * MIN + 400, 'd2', edit(F.doc2, 3, 2)),
  rec.user(web, now - 25 * MIN, 'ok'),
], { pid: pids[3], fields: { status: 'idle', statusUpdatedAt: now - 25 * MIN } }, 0, 'Bring docs/api.md up to date with the token refresh header.');
session(web, 'Spike: response cache layer', [rec.user(web, now - 2 * HOUR, 'park this')], null, 2 * HOUR, 'Could a response cache in front of the token check make the API faster?');
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
], { pid: pids[4], fields: { status: 'busy', statusUpdatedAt: now - 8 * MIN } }, 0, 'Queue draft edits while offline and sync them when the token is valid again.');
session(mob, 'Crash on cold start', [
  rec.toolUse(mob, now - 70 * MIN, 'k1', 'Edit', { file_path: F.crash, old_string: 'a', new_string: 'b' }), rec.toolResult(now - 70 * MIN + 400, 'k1', edit(F.crash, 9, 3)), rec.user(mob, now - 62 * MIN, 'ok'),
], { pid: pids[5], fields: { status: 'idle', statusUpdatedAt: now - 60 * MIN } });
session(mob, 'Bump Gradle plugin', [rec.user(mob, now - 3 * HOUR, 'later')], null, 3 * HOUR);
// twelve old sessions for the Archived section
const old = ['Set up CI cache', 'Migrate to pnpm', 'Dark mode toggle', 'Rate limit login', 'Fix date parsing', 'Profile page layout', 'Upgrade React Router', 'Audit npm packages', 'Add health check', 'Split vendor chunk', 'Retry failed uploads', 'Rename env vars'];
old.forEach((t, i) => { const ago = (16 + i * 2) * DAY; const id = sid(++n); const f = fx.claudeSession(home, web, id, [rec.user(web, now - ago - MIN, t), rec.aiTitle(id, t), rec.user(web, now - ago, 'done')]); fs.utimesSync(f, new Date(now - ago), new Date(now - ago)); });
// Each demo workspace is its own clean git repository. Otherwise the extension looks at the repository the demo happens to sit in
// and lists that repository's uncommitted files as "changed while a command ran".
const { execFileSync } = require('child_process');
for (const dir of [web, mob]) {
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });
  try { git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'demo'); } catch { /* no git: the pictures still work */ }
}
fs.writeFileSync(path.join(home, 'demo.json'), JSON.stringify(out));
console.log('demo sessions', n + 1);
