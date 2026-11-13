'use strict';
// 시험용 가짜 홈 폴더와 가짜 대화 기록을 만든다. 실제 ~/.claude 는 건드리지 않는다.
// 주의: scanner.js·extension.js 는 불러올 때 홈 폴더를 정하므로, makeHome()을 먼저 부른 뒤 require 해야 한다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const iso = (ms) => new Date(ms).toISOString();

function makeHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swt-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // 진짜 설정을 가리키는 환경 변수가 있으면 시험이 사용자 파일을 읽고 쓴다(11-13 CODEX_HOME으로 진짜 config.toml을 고친 일) → 시험에서는 늘 지운다
  for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BOARD_STATE_DIR']) delete process.env[k];
  const project = path.join(home, 'work', 'demo-app');
  fs.mkdirSync(project, { recursive: true });
  return { home, project, markers: path.join(home, '.cache', 'claude-attention') };
}

const encode = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function writeLines(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function claudeSession(home, cwd, sid, records) {
  return writeLines(path.join(home, '.claude', 'projects', encode(cwd), sid + '.jsonl'), records);
}

function subagentSession(home, cwd, sid, name, records) {
  return writeLines(path.join(home, '.claude', 'projects', encode(cwd), sid, 'subagents', name + '.jsonl'), records);
}

function codexSession(home, uuid, records, when) {
  const d = new Date(when || Date.now());
  const day = [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
  return writeLines(path.join(home, '.codex', 'sessions', ...day, `rollout-2026-01-01T00-00-00-${uuid}.jsonl`), records);
}

const rec = {
  aiTitle: (sid, title) => ({ type: 'ai-title', aiTitle: title, sessionId: sid }),
  customTitle: (sid, title) => ({ type: 'custom-title', customTitle: title, sessionId: sid }),
  user: (cwd, ts, text) => ({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, cwd, timestamp: iso(ts) }),
  toolUse: (cwd, ts, id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, cwd, timestamp: iso(ts) }),
  toolResult: (ts, id, toolUseResult) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] }, timestamp: iso(ts), toolUseResult }),
  // Claude Code가 남기는 API 요청 사본(실제 모양 그대로): 이전 대화의 메시지가 message 칸에 다시 들어 있다
  apiCopy: (message) => ({ type: 'api-request-blob', sessionId: 's', hash: 'h', message }),
  editResult: (filePath, original, oldString, newString) => ({
    filePath, oldString, newString, originalFile: original, replaceAll: false, userModified: false,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-' + oldString, '+' + newString, '+extra'] }],
  }),
  writeResult: (filePath, content) => ({ type: 'create', filePath, content, structuredPatch: [], originalFile: null, userModified: false }),
  bashResult: (extra) => ({ stdout: '', stderr: '', interrupted: false, isImage: false, ...extra }),
  bashDiff: (filePath, lines, created) => ({
    files: [{ filePath, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }], ...(created ? { created: true } : {}) }],
    moreFiles: 0, changedFiles: [filePath],
  }),
};

function procStart(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return undefined; }
}

// 실행 중 세션 목록(~/.claude/sessions/<pid>.json). pid는 실제로 살아 있는 프로세스여야 "실행 중"으로 본다.
function registerSession(home, pid, sid, fields) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const data = { pid, sessionId: sid, procStart: procStart(pid), kind: 'interactive', entrypoint: 'claude-vscode', statusUpdatedAt: Date.now(), ...fields };
  if (data.procStart === undefined) delete data.procStart;
  fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify(data));
}

function writeMarker(dir, sid, tool) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, crypto.createHash('sha256').update(sid).digest('hex').slice(0, 12) + '.pending');
  fs.writeFileSync(p, tool);
  return p;
}

module.exports = { makeHome, claudeSession, subagentSession, codexSession, rec, registerSession, writeMarker, iso, encode };
