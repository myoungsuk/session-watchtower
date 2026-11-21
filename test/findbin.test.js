'use strict';
// programExists: finds a program on PATH (with PATHEXT on Windows, where npm installs CLIs as .cmd) or by its path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { programExists } = require('../findbin');
const { fakeBin } = require('./helpers/fake-bin');

test('programExists: on PATH, by path, and not there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-findbin-'));
  const bin = fakeBin(dir, 'mytool', 'process.exit(0);\n');
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.strictEqual(programExists('mytool', env), true, 'bare name on PATH (mytool.cmd on Windows)');
  assert.strictEqual(programExists(bin, env), true, 'full path');
  assert.strictEqual(programExists('othertool', env), false);
  assert.strictEqual(programExists(path.join(dir, 'othertool'), env), false);
  assert.strictEqual(programExists('mytool', { PATH: '' }), false, 'empty PATH');
  assert.strictEqual(programExists('', env), false);
});
