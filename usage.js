'use strict';
// 사용량(요금제 한도) 읽기. 인터넷에 묻지 않고 로그 전체를 다시 읽지도 않는다: 이미 디스크에 있는 값을, 그 파일이 바뀌었을 때만 읽는다.
// Claude: ~/.claude.json 의 cachedUsageUtilization — Claude Code가 사용량을 받아 올 때(1분에 한 번까지) 적어 두는 값.
// Codex: 가장 최근 Codex 기록 끝부분의 token_count 사건에 든 rate_limits.
const fs = require('fs');
const { claudeConfigPath } = require('./mcp');

const TAIL_BYTES = 256 * 1024;
const CLAUDE_KEYS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

let claudeMemo = { mtimeMs: -1, size: -1, file: '', value: null };
let codexMemo = { mtimeMs: -1, size: -1, file: '', value: null };
const stats = { claudeReads: 0, codexReads: 0 }; // 시험·측정용: 실제로 파일 내용을 읽은 횟수

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// { at, windows: [{ key, percent, resetsAt }] } 또는 null
function readClaude() {
  const file = claudeConfigPath();
  let st;
  try { st = fs.statSync(file); } catch { claudeMemo = { mtimeMs: -1, size: -1, file, value: null }; return null; }
  if (claudeMemo.file === file && st.mtimeMs === claudeMemo.mtimeMs && st.size === claudeMemo.size) return claudeMemo.value;
  let value = null;
  try {
    stats.claudeReads++;
    const c = JSON.parse(fs.readFileSync(file, 'utf8')).cachedUsageUtilization;
    const u = c && typeof c === 'object' ? c.utilization : null;
    if (u && typeof u === 'object' && num(c.fetchedAtMs)) {
      const windows = [];
      for (const key of CLAUDE_KEYS) {
        const w = u[key];
        if (w && typeof w === 'object' && num(w.utilization) !== null) windows.push({ key, percent: w.utilization, resetsAt: Date.parse(w.resets_at) || null });
      }
      value = { at: c.fetchedAtMs, windows };
    }
  } catch { value = null; }
  claudeMemo = { mtimeMs: st.mtimeMs, size: st.size, file, value };
  return value;
}

// Codex 기록 파일 끝에서 마지막 rate_limits를 찾는다. { at, plan, windows: [{ key, minutes, percent, resetsAt }] } 또는 null
function readCodex(file) {
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (codexMemo.file === file && st.mtimeMs === codexMemo.mtimeMs && st.size === codexMemo.size) return codexMemo.value;
  let value = null;
  let fd = null;
  try {
    stats.codexReads++;
    fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && !value; i--) {
      const line = lines[i];
      if (line.indexOf('"rate_limits"') < 0 || line.indexOf('"token_count"') < 0) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; } // 잘린 첫 줄
      const r = o && o.payload && o.payload.rate_limits;
      if (!r || typeof r !== 'object') continue;
      const windows = [];
      for (const key of ['primary', 'secondary']) {
        const w = r[key];
        if (w && typeof w === 'object' && num(w.used_percent) !== null) windows.push({ key, minutes: num(w.window_minutes), percent: w.used_percent, resetsAt: num(w.resets_at) ? w.resets_at * 1000 : null });
      }
      if (windows.length) value = { at: Date.parse(o.timestamp) || st.mtimeMs, plan: typeof r.plan_type === 'string' ? r.plan_type : '', windows };
    }
  } catch { value = null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* 닫힘 */ } }
  codexMemo = { mtimeMs: st.mtimeMs, size: st.size, file, value };
  return value;
}

// 초기화 시각이 이미 지난 칸은 옛 값이라 뺀다
function liveWindows(v, now = Date.now()) {
  return v && Array.isArray(v.windows) ? v.windows.filter((w) => !w.resetsAt || w.resetsAt > now) : [];
}

module.exports = { readClaude, readCodex, liveWindows, stats };
