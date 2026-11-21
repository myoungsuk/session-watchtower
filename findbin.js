'use strict';
// Is this program there? On Windows a program started through the shell (needed for npm's .cmd files) never gives
// ENOENT: cmd.exe just exits (0 or 1), so "not installed" looks like an ordinary failure. Look it up first instead.
// cmd: a bare name looked up on PATH (with PATHEXT on Windows), or a path to a file.
const fs = require('fs');
const path = require('path');

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function programExists(cmd, env = process.env, platform = process.platform) {
  const name = String(cmd || '');
  if (!name) return false;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exts = win ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const tryAll = (base) => exts.some((e) => isFile(base + e));
  if (name.includes('/') || (win && name.includes('\\'))) return tryAll(name);
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
  return dirs.some((d) => tryAll(p.join(d.replace(/^"|"$/g, ''), name)));
}

module.exports = { programExists };
