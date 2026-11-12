// Things that happen while the screenshot window is open. Usage: node demo-live.js <extension folder> <fake home> [step]
// Steps: overlap (default) · edit-auth · approve · finish — used one after another for the animated picture.
const [,, extDir, home, step = 'overlap'] = process.argv;
const fs = require('fs'); const path = require('path');
const fx = require(path.join(extDir, 'test/helpers/fixture'));
const { rec } = fx;
const demo = JSON.parse(fs.readFileSync(path.join(home, 'demo.json'), 'utf8'));
const now = Date.now();
const add = (title, recs) => fs.appendFileSync(demo.logs[title], recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
const patch = (file, a, d) => ({ filePath: file, oldString: 'old', newString: 'new', originalFile: 'x\n', replaceAll: false, userModified: false,
  structuredPatch: [{ oldStart: 1, oldLines: d, newStart: 1, newLines: a, lines: Array.from({ length: d }, (_, i) => '-o' + i).concat(Array.from({ length: a }, (_, i) => '+n' + i)) }] });
const touch = (f) => { const t = new Date(); fs.utimesSync(f, t, t); };
const reg = (title, fields) => fx.registerSession(home, demo.pids[title], demo.sids[title], { cwd: demo.web, name: 'demo', nameSource: 'derived', ...fields });
const A = 'Refactor auth middleware';

if (step === 'overlap') {
  // a working session edits a file that another open session already changed → overlap mark and notification
  add(A, [rec.toolUse(demo.web, now - 800, 'live1', 'Edit', { file_path: demo.files.hook, old_string: 'old', new_string: 'new' }), rec.toolResult(now, 'live1', patch(demo.files.hook, 8, 3)),
    rec.toolUse(demo.web, now + 200, 'live2', 'Bash', { command: 'npm test -- auth', description: 'npm test -- auth' })]);
  touch(demo.files.auth);
} else if (step === 'edit-auth') {
  add(A, [rec.toolResult(now - 900, 't7', rec.bashResult({})), rec.toolUse(demo.web, now - 800, 'liveA', 'Edit', { file_path: demo.files.auth, old_string: 'old', new_string: 'new' }),
    rec.toolResult(now, 'liveA', patch(demo.files.auth, 12, 2)), rec.toolUse(demo.web, now + 200, 'liveB', 'Edit', { file_path: demo.files.test, old_string: 'old', new_string: 'new' })]);
  touch(demo.files.auth);
} else if (step === 'approve') {
  // the approval is given: the waiting session goes back to work
  reg('Add payment webhooks', { status: 'busy', statusUpdatedAt: now });
  add('Add payment webhooks', [rec.toolResult(now, 'w2', rec.bashResult({})), rec.toolUse(demo.web, now + 300, 'liveC', 'Bash', { command: 'npm run build', description: 'npm run build' })]);
} else if (step === 'finish') {
  // the quiet session finishes
  reg('Migrate date helpers', { status: 'idle', statusUpdatedAt: now });
  add('Migrate date helpers', [rec.toolResult(now - 500, 'g2', rec.bashResult({})), rec.user(demo.web, now, 'done')]);
}
