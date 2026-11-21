'use strict';
// Test stand-ins for programs such as claude and codex, written as Node scripts so they run on every OS.
// POSIX: an executable file with a node shebang. Windows cannot start a script file directly (spawn EFTYPE),
// so there it is <name>.cmd calling node on the script, which is how npm installs CLIs on Windows too.
const fs = require('fs');
const path = require('path');

const win = process.platform === 'win32';

// A program whose body is the given Node source. Returns the path to run.
function fakeBin(dir, name, js) {
  if (!win) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, '#!/usr/bin/env node\n' + js);
    fs.chmodSync(f, 0o755);
    return f;
  }
  const script = path.join(dir, name + '.js');
  fs.writeFileSync(script, js);
  return cmdFor(dir, name, script);
}

// A program named <name> in dir that runs an existing Node script file. Returns the path to run.
function linkBin(dir, name, script) {
  if (!win) {
    const f = path.join(dir, name);
    fs.symlinkSync(script, f);
    return f;
  }
  return cmdFor(dir, name, script);
}

function cmdFor(dir, name, script) {
  const f = path.join(dir, name + '.cmd');
  fs.writeFileSync(f, `@"${process.execPath}" "${script}" %*\r\n`);
  return f;
}

module.exports = { fakeBin, linkBin, win };
