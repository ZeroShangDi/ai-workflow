const toggle = document.querySelector('#toggle');
const toggleLabel = document.querySelector('#toggleLabel');
const stateLabel = document.querySelector('#state');
const transcript = document.querySelector('#transcript');
const errorBanner = document.querySelector('#error');
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canRecognize = typeof Recognition === 'function';
const canSpeak = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';

const model = {
  active: false,
  opening: false,
  session: null,
  source: null,
  recognition: null,
  shouldListen: false,
  restartTimer: null,
  speechQueue: [],
  speaking: null,
  seen: new Set(),
  cursor: '0',
};

function showError(value = '') {
  errorBanner.textContent = value;
  errorBanner.hidden = !value;
}

function setState(value) {
  stateLabel.textContent = value;
}

function setToggle(active, opening = false) {
  model.active = active;
  model.opening = opening;
  toggle.disabled = opening;
  toggle.setAttribute('aria-pressed', String(active));
  toggleLabel.textContent = opening ? '正在连接' : active ? '结束聊天' : '开始聊天';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message || `请求失败 (${response.status})`);
  return value;
}

function append(role, text) {
  transcript.querySelector('.placeholder')?.remove();
  const row = document.createElement('p');
  row.className = role;
  row.textContent = role === 'user' ? `你：${text}` : role === 'assistant' ? text : `任务播报：${text}`;
  transcript.append(row);
  while (transcript.children.length > 8) transcript.firstElementChild.remove();
  transcript.scrollTop = transcript.scrollHeight;
}

function speak(text, { noticeId = null, kind = 'direct' } = {}) {
  if (!canSpeak || !text || !model.active) return;
  model.speechQueue.push({ text, noticeId, kind });
  drainSpeech();
}

function drainSpeech() {
  if (!model.active || model.speaking || !model.speechQueue.length || !canSpeak) return;
  model.speechQueue.sort((left, right) => (left.kind === 'direct' ? -1 : 1) - (right.kind === 'direct' ? -1 : 1));
  const item = model.speechQueue.shift();
  model.speaking = item;
  setState(item.kind === 'notice' ? '正在播报任务进展' : '正在回答');
  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.lang = document.documentElement.lang || navigator.language || 'zh-CN';
  const settle = async (status) => {
    if (model.speaking !== item) return;
    model.speaking = null;
    if (item.noticeId && model.session) {
      await api(`/api/sessions/${encodeURIComponent(model.session.id)}/events`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'delivery',
          noticeId: item.noticeId,
          status,
          dedupeKey: `delivery:${item.noticeId}:${status}`,
        }),
      }).catch(() => {});
    }
    if (model.active) setState('我在听');
    drainSpeech();
  };
  utterance.onend = () => void settle('spoken');
  utterance.onerror = (event) => {
    const interrupted = ['canceled', 'interrupted'].includes(event.error);
    void settle(interrupted ? 'interrupted' : 'failed');
  };
  window.speechSynthesis.speak(utterance);
}

function interruptSpeech() {
  if (!model.speaking && !model.speechQueue.length) return;
  if (model.speaking) {
    const item = model.speaking;
    model.speaking = null;
    if (item.noticeId && model.session) {
      void fetch(`/api/sessions/${encodeURIComponent(model.session.id)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'delivery',
          noticeId: item.noticeId,
          status: 'interrupted',
          dedupeKey: `delivery:${item.noticeId}:interrupted`,
        }),
      }).catch(() => {});
    }
  }
  model.speechQueue.length = 0;
  if (canSpeak) window.speechSynthesis.cancel();
}

function handleEvent(event) {
  if (!event || model.seen.has(event.eventId)) return;
  model.seen.add(event.eventId);
  model.cursor = String(event.cursor || model.cursor);
  if (event.type === 'transcript') {
    if (event.role === 'assistant') {
      append('assistant', event.text);
      speak(event.text);
    } else if (event.role === 'user' && ![...transcript.children].some((node) => node.textContent === `你：${event.text}`)) {
      append('user', event.text);
    }
    return;
  }
  if (event.type === 'trigger') {
    append('notice', event.text);
    speak(event.text, { noticeId: event.noticeId, kind: 'notice' });
    return;
  }
  if (event.type === 'voice') {
    if (event.state === 'thinking') setState('正在想');
    if (event.state === 'warning' || event.state === 'error') showError(event.message || '语音服务暂时不可用');
  }
}

function connectEvents() {
  model.source?.close();
  const source = new EventSource(`/api/sessions/${encodeURIComponent(model.session.id)}/events?after=0`);
  model.source = source;
  for (const type of ['transcript', 'trigger', 'voice', 'activity', 'session.closed']) {
    source.addEventListener(type, (event) => {
      try { handleEvent(JSON.parse(event.data)); } catch { /* Ignore malformed frames. */ }
    });
  }
}

function stopRecognition() {
  model.shouldListen = false;
  if (model.restartTimer) clearTimeout(model.restartTimer);
  model.restartTimer = null;
  try { model.recognition?.stop(); } catch { /* Already stopped. */ }
}

async function sendUserText(text) {
  if (!text.trim() || !model.session || !model.active) return;
  append('user', text.trim());
  interruptSpeech();
  setState('正在想');
  try {
    await api(`/api/sessions/${encodeURIComponent(model.session.id)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ text: text.trim() }),
    });
  } catch (failure) {
    showError(failure.message);
    setState('我在听');
  }
}

function startRecognition() {
  if (!canRecognize || !model.active) return;
  if (!model.recognition) {
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = document.documentElement.lang || navigator.language || 'zh-CN';
    recognition.onresult = (event) => {
      interruptSpeech();
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) void sendUserText(result[0]?.transcript || '');
      }
    };
    recognition.onerror = (event) => {
      if (!['aborted', 'no-speech'].includes(event.error)) {
        showError('浏览器语音识别不可用，请检查麦克风权限。');
      }
    };
    recognition.onend = () => {
      if (!model.active || !model.shouldListen) return;
      model.restartTimer = setTimeout(() => {
        try { recognition.start(); } catch { /* Browser restart races are harmless. */ }
      }, 300);
    };
    model.recognition = recognition;
  }
  model.shouldListen = true;
  try { model.recognition.start(); } catch { /* Already listening. */ }
}

async function start() {
  showError();
  if (!canRecognize) {
    showError('当前浏览器不支持语音识别。');
    return;
  }
  setToggle(false, true);
  setState('正在打开麦克风');
  try {
    const opened = await api('/api/open', { method: 'POST', body: JSON.stringify({}) });
    model.session = opened.session;
    model.seen.clear();
    transcript.replaceChildren();
    setToggle(true);
    connectEvents();
    startRecognition();
    setState('我在听');
  } catch (failure) {
    setToggle(false);
    setState('准备就绪');
    showError(failure.message);
  }
}

async function stop() {
  interruptSpeech();
  stopRecognition();
  model.source?.close();
  model.source = null;
  const session = model.session;
  model.session = null;
  setToggle(false);
  setState('准备就绪');
  if (session) {
    await api('/api/close', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id }),
    }).catch((failure) => showError(failure.message));
  }
}

toggle.addEventListener('click', () => {
  if (model.opening) return;
  if (model.active) void stop(); else void start();
});
window.addEventListener('pagehide', () => {
  if (model.session) {
    navigator.sendBeacon?.(
      '/api/close',
      new Blob([JSON.stringify({ sessionId: model.session.id })], { type: 'application/json' }),
    );
  }
});
setToggle(false);
if (!canRecognize) {
  setState('语音识别不可用');
  showError('当前浏览器不支持语音识别。');
}
