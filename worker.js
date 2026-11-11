'use strict';
// 무거운 대화 기록 읽기를 확장 호스트 밖 스레드에서 한다(Claude 패널이 멈추지 않게).
const { parentPort } = require('worker_threads');
const { createModel } = require('./scanner');

const model = createModel();
let lastSig = '';

function signature(sessions) {
  return sessions.map((s) => `${s.sid}:${s.lastActivity}:${s.changes.length}:${s.status}:${s.waitingFor}:${s.statusSince}:${s.alive}:${s.title}:${s.activity ? s.activity.ts + (s.activity.done ? 'd' : 'p') : ''}:${(s.liveFiles || []).join(',')}`).join('|');
}

parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'status') {
    // 상태 표시줄용 가벼운 확인(대화 기록은 읽지 않음)
    try {
      parentPort.postMessage({ type: 'status', id: msg.id, sessions: model.status(msg.opts || {}).sessions });
    } catch (e) {
      parentPort.postMessage({ type: 'status', id: msg.id, sessions: [], error: String((e && e.message) || e) });
    }
    return;
  }
  if (msg.type === 'save') {
    try { model.save(msg.opts || {}); } catch { /* 다음에 다시 */ }
    return;
  }
  if (msg.type !== 'scan') return;
  try {
    // 읽는 데 오래 걸리면(처음 읽기) 먼저 읽은 세션부터 중간 결과를 보낸다
    const onProgress = (p) => parentPort.postMessage({ type: 'partial', id: msg.id, sessions: p.sessions });
    const res = model.scan({ ...(msg.opts || {}), onProgress });
    const sig = signature(res.sessions);
    if (sig === lastSig && !(msg.opts && msg.opts.force)) {
      parentPort.postMessage({ type: 'same', id: msg.id, stats: res.stats });
      return;
    }
    lastSig = sig;
    parentPort.postMessage({ type: 'result', id: msg.id, sessions: res.sessions, stats: res.stats });
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String((e && e.stack) || e) });
  }
});
