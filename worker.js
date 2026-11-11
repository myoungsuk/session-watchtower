'use strict';
// 무거운 대화 기록 읽기를 확장 호스트 밖 스레드에서 한다(Claude 패널이 멈추지 않게).
const { parentPort } = require('worker_threads');
const { createModel } = require('./scanner');

const model = createModel();
let lastSig = '';

function signature(sessions) {
  return sessions.map((s) => `${s.sid}:${s.lastActivity}:${s.changes.length}:${s.status}:${s.waitingFor}:${s.statusSince}:${s.alive}:${s.title}`).join('|');
}

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'scan') return;
  try {
    const res = model.scan(msg.opts || {});
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
