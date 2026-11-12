'use strict';
// 무거운 대화 기록 읽기를 확장 호스트 밖 스레드에서 한다(Claude 패널이 멈추지 않게).
const { parentPort } = require('worker_threads');
const { createModel, createPromptIndex } = require('./scanner');

const model = createModel();
let lastSig = '';
let promptIndex = null;

function signature(sessions) {
  return sessions.map((s) => `${s.sid}:${s.lastActivity}:${s.changes.length}:${s.status}:${s.waitingFor}:${s.statusSince}:${s.alive}:${s.title}:${s.activity ? s.activity.ts + (s.activity.done ? 'd' : 'p') : ''}:${(s.liveFiles || []).join(',')}:${(s.overlaps || []).length}:${s.subagents ? s.subagents.active : 0}`).join('|');
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
  if (msg.type === 'search') {
    // 대화 내용으로 세션 찾기(이 일은 따로 띄운 일꾼이 맡는다: 처음에는 기록 전체를 한 번 읽어야 해서 오래 걸릴 수 있다)
    try {
      if (!promptIndex) promptIndex = createPromptIndex();
      let last = 0;
      const onProgress = (done, total) => { if (Date.now() - last > 250) { last = Date.now(); parentPort.postMessage({ type: 'searchProgress', id: msg.id, done, total }); } };
      const res = promptIndex.search(msg.query, { ...(msg.opts || {}), onProgress });
      parentPort.postMessage({ type: 'searchResult', id: msg.id, ...res });
    } catch (e) {
      parentPort.postMessage({ type: 'searchResult', id: msg.id, results: [], total: 0, error: String((e && e.message) || e) });
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
