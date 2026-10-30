const elements = {
  serverDot: document.querySelector('#serverDot'),
  serverLabel: document.querySelector('#serverLabel'),
  sessionStatus: document.querySelector('#sessionStatus'),
  sessionId: document.querySelector('#sessionId'),
  lastCursor: document.querySelector('#lastCursor'),
  triggerStatus: document.querySelector('#triggerStatus'),
  asrCapability: document.querySelector('#asrCapability'),
  ttsCapability: document.querySelector('#ttsCapability'),
  capabilityNote: document.querySelector('#capabilityNote'),
  startButton: document.querySelector('#startButton'),
  stopButton: document.querySelector('#stopButton'),
  muteButton: document.querySelector('#muteButton'),
  textForm: document.querySelector('#textForm'),
  textInput: document.querySelector('#textInput'),
  sendButton: document.querySelector('#sendButton'),
  transcript: document.querySelector('#transcript'),
  emptyState: document.querySelector('#emptyState'),
  eventCount: document.querySelector('#eventCount'),
  activityText: document.querySelector('#activityText'),
  interimText: document.querySelector('#interimText'),
  errorBanner: document.querySelector('#errorBanner'),
};

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canRecognize = typeof Recognition === 'function';
const canSpeak = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';

const state = {
  session: null,
  eventSource: null,
  running: false,
  shouldRecognize: false,
  recognition: null,
  restartTimer: null,
  speechResumeTimer: null,
  muted: false,
  seenEvents: new Set(),
  eventCount: 0,
  currentCursor: '0',
  userSpeechActive: false,
  lastUserSpeechAt: 0,
  playback: {
    active: null,
    directQueue: [],
    noticeQueue: [],
    timer: null,
  },
};

const activityLabels = {
  idle: '空闲',
  listening: '正在聆听',
  thinking: '正在思考',
  speaking: '正在播报',
  working: '工作处理中',
  warning: '需要留意',
  error: '发生错误',
};

function setServerState(kind, label) {
  elements.serverDot.className = `state-dot ${kind}`;
  elements.serverLabel.textContent = label;
}

function setCapability(element, kind, label) {
  element.className = `capability ${kind}`;
  element.textContent = label;
}

function showError(message = '') {
  elements.errorBanner.textContent = message;
  elements.errorBanner.hidden = !message;
}

function setActivity(label) {
  elements.activityText.textContent = label;
}

function updateControls() {
  const active = Boolean(state.session) && state.running;
  elements.startButton.disabled = active;
  elements.stopButton.disabled = !active;
  elements.sessionStatus.textContent = active ? '会话中' : '空闲';
  elements.sessionId.textContent = state.session?.id || '—';
  elements.lastCursor.textContent = state.currentCursor;
  elements.textInput.disabled = !active;
  elements.sendButton.disabled = !active;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(value?.error?.message || `请求失败 (${response.status})`);
  }
  return value;
}

function clearTranscript() {
  if (state.playback.timer) clearTimeout(state.playback.timer);
  state.playback = {
    active: null,
    directQueue: [],
    noticeQueue: [],
    timer: null,
  };
  state.seenEvents.clear();
  state.eventCount = 0;
  state.currentCursor = '0';
  elements.transcript.replaceChildren();
  elements.transcript.append(elements.emptyState);
  elements.emptyState.hidden = false;
  elements.eventCount.textContent = '0 条';
}

function eventSourceName(event) {
  if (event.type === 'transcript') return event.role;
  return 'system';
}

function eventText(event) {
  if (event.type === 'transcript') return event.text;
  if (event.type === 'voice') return event.message || activityLabels[event.state] || event.state;
  if (event.type === 'activity') return activityLabels[event.state] || event.state;
  if (event.type === 'trigger') return event.text;
  if (event.type === 'delivery') {
    const labels = {
      spoken: '播报完成',
      interrupted: '播报已打断',
      failed: '播报失败',
    };
    return `${labels[event.state] || event.state} · ${event.noticeId}`;
  }
  if (event.type === 'session.opened') return event.message || '语音会话已打开';
  if (event.type === 'session.closed') return event.message || '语音会话已关闭';
  return event.message || event.text || event.type;
}

async function postEvent(event, { keepalive = false } = {}) {
  if (!state.session || !state.running) return null;
  return api(`/api/sessions/${encodeURIComponent(state.session.id)}/events`, {
    method: 'POST',
    keepalive,
    body: JSON.stringify(event),
  });
}

async function postVoiceState(event, voiceState) {
  await postEvent({
    type: 'voice',
    state: voiceState,
    event,
    dedupeKey: `${event}:${state.session?.id}:${Date.now()}`,
  });
}

function postDelivery(item, status, message = null, { keepalive = false } = {}) {
  if (!item.noticeId) return;
  void postEvent({
    type: 'delivery',
    noticeId: item.noticeId,
    status,
    message,
    dedupeKey: `delivery:${item.noticeId}:${status}`,
  }, { keepalive }).catch(() => {});
}

function schedulePlayback(delay = 350) {
  if (state.playback.timer) clearTimeout(state.playback.timer);
  state.playback.timer = setTimeout(() => {
    state.playback.timer = null;
    processPlaybackQueue();
  }, delay);
}

function settlePlayback(item, status, message = null, { keepalive = false } = {}) {
  if (!item || item.settled) return;
  item.settled = true;
  if (state.playback.active === item) state.playback.active = null;
  postDelivery(item, status, message, { keepalive });
  void postVoiceState('bot_stopped', 'listening').catch(() => {});
  setActivity(status === 'spoken' ? '空闲' : activityLabels.listening);
  schedulePlayback(450);
}

function interruptPlayback(status = 'interrupted') {
  const current = state.playback.active;
  if (current) {
    settlePlayback(current, status, status === 'interrupted' ? 'user interrupted playback' : null);
  }
  if (canSpeak) window.speechSynthesis.cancel();
}

function startPlayback(item) {
  if (!canSpeak || state.muted || !state.running) return;
  state.playback.active = item;
  setActivity(activityLabels.speaking);
  void postVoiceState('bot_started', 'speaking').catch(() => {});

  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.lang = document.documentElement.lang || navigator.language || 'zh-CN';
  utterance.onend = () => {
    settlePlayback(item, 'spoken');
  };
  utterance.onerror = (event) => {
    const interrupted = ['canceled', 'interrupted'].includes(event.error);
    settlePlayback(
      item,
      interrupted ? 'interrupted' : 'failed',
      interrupted ? 'speech synthesis cancelled' : `speech synthesis failed: ${event.error}`,
    );
  };
  window.speechSynthesis.speak(utterance);
}

function processPlaybackQueue() {
  if (!state.running || state.muted || !canSpeak || state.playback.active) return;
  const item = state.playback.directQueue.shift() || state.playback.noticeQueue[0] || null;
  if (!item) return;
  if (item.kind === 'notice') {
    if (state.userSpeechActive || Date.now() - state.lastUserSpeechAt < 1800) {
      schedulePlayback(500);
      return;
    }
    state.playback.noticeQueue.shift();
  }
  startPlayback(item);
}

function queueSpeech(text, { kind = 'direct', noticeId = null } = {}) {
  if (!canSpeak || !text || !state.running) return;
  const item = {
    text,
    kind,
    noticeId,
    settled: false,
  };
  if (kind === 'notice') {
    if (state.playback.noticeQueue.some((value) => value.noticeId === noticeId)) return;
    state.playback.noticeQueue.push(item);
  } else {
    if (state.playback.active?.kind === 'notice') interruptPlayback('interrupted');
    state.playback.directQueue.push(item);
  }
  processPlaybackQueue();
}

function renderEvent(event) {
  if (!event?.eventId || state.seenEvents.has(event.eventId)) return;
  state.seenEvents.add(event.eventId);
  state.currentCursor = event.cursor || state.currentCursor;
  state.eventCount += 1;
  elements.eventCount.textContent = `${state.eventCount} 条`;
  elements.lastCursor.textContent = state.currentCursor;
  elements.emptyState.hidden = true;

  const source = eventSourceName(event);
  const row = document.createElement('article');
  row.className = `message-row message-${source}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const speaker = document.createElement('span');
  speaker.textContent = source === 'user' ? '你' : source === 'assistant' ? '助手' : '系统';
  const time = document.createElement('time');
  const createdAt = event.createdAt ? new Date(event.createdAt) : new Date();
  time.dateTime = createdAt.toISOString();
  time.textContent = createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.append(speaker, time);

  const body = document.createElement('p');
  body.textContent = eventText(event);
  row.append(meta, body);
  elements.transcript.append(row);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;

  if (event.type === 'activity') setActivity(activityLabels[event.state] || event.state);
  if (event.type === 'voice') setActivity(activityLabels[event.state] || event.state);
  if (event.type === 'transcript' && ['assistant', 'system'].includes(event.role)) {
    queueSpeech(event.text, { kind: 'direct' });
  } else if (event.type === 'trigger') {
    queueSpeech(event.text, { kind: 'notice', noticeId: event.noticeId });
  } else if (event.type === 'voice' && ['warning', 'error'].includes(event.state)) {
    queueSpeech(eventText(event), { kind: 'notice' });
  }
}

function handleSse(frame) {
  let event;
  try {
    event = JSON.parse(frame.data);
  } catch {
    return;
  }
  renderEvent(event);
  if (event.type === 'session.closed') {
    state.running = false;
    state.shouldRecognize = false;
    stopRecognition();
    state.eventSource?.close();
    state.eventSource = null;
    setServerState('ready', '服务可用');
    setActivity('会话已结束');
    updateControls();
  }
}

function attachEvents() {
  state.eventSource?.close();
  const source = new EventSource(
    `/api/sessions/${encodeURIComponent(state.session.id)}/events?after=0`,
  );
  state.eventSource = source;
  source.onopen = () => setServerState('ready', '事件流已连接');
  source.onerror = () => {
    if (state.running) setServerState('warning', '事件流重连中');
  };
  for (const type of [
    'transcript',
    'voice',
    'activity',
    'trigger',
    'delivery',
    'session.opened',
    'session.closed',
  ]) {
    source.addEventListener(type, handleSse);
  }
}

function stopRecognition() {
  state.shouldRecognize = false;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  if (state.speechResumeTimer) clearTimeout(state.speechResumeTimer);
  state.restartTimer = null;
  state.speechResumeTimer = null;
  state.userSpeechActive = false;
  try {
    state.recognition?.stop();
  } catch {
    // Recognition may already be stopped by the browser.
  }
  elements.interimText.textContent = '';
}

async function postUserText(text) {
  if (!state.session || !state.running || !text.trim()) return;
  await postEvent({
    type: 'transcript',
    role: 'user',
    text: text.trim(),
    dedupeKey: `text:${state.session.id}:${Date.now()}`,
  });
}

function beginRecognition() {
  if (!canRecognize || !state.running) return;
  state.shouldRecognize = true;
  if (!state.recognition) {
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = document.documentElement.lang || navigator.language || 'zh-CN';
    recognition.onstart = () => {
      setCapability(elements.asrCapability, 'ready', '识别 · 运行中');
      setActivity(activityLabels.listening);
    };
    recognition.onresult = (event) => {
      state.userSpeechActive = true;
      state.lastUserSpeechAt = Date.now();
      if (state.speechResumeTimer) clearTimeout(state.speechResumeTimer);
      interruptPlayback('interrupted');
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript || '';
        if (result.isFinal) {
          void postUserText(text).catch((error) => showError(error.message));
        } else {
          interim += text;
        }
      }
      elements.interimText.textContent = interim;
      if (!interim) {
        state.speechResumeTimer = setTimeout(() => {
          state.userSpeechActive = false;
          state.lastUserSpeechAt = Date.now();
          processPlaybackQueue();
        }, 1200);
      }
    };
    recognition.onerror = (event) => {
      if (['aborted', 'no-speech'].includes(event.error)) return;
      state.shouldRecognize = false;
      setCapability(elements.asrCapability, 'warning', '识别 · 不可用');
      elements.capabilityNote.textContent = '本机语音识别不可用，可改用文字输入。';
      showError('浏览器语音识别未完成，请检查麦克风权限或改用文字输入。');
    };
    recognition.onend = () => {
      if (!state.running || !state.shouldRecognize) return;
      state.restartTimer = setTimeout(() => {
        try {
          recognition.start();
        } catch {
          elements.capabilityNote.textContent = '语音识别暂未恢复，可继续使用文字输入。';
        }
      }, 350);
    };
    state.recognition = recognition;
  }
  try {
    state.recognition.start();
  } catch {
    // start() throws if the browser is already listening.
  }
}

async function startSession() {
  showError();
  elements.startButton.disabled = true;
  try {
    const result = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Voice Control' }),
    });
    state.session = result.session;
    state.running = true;
    clearTranscript();
    attachEvents();
    updateControls();
    setActivity('正在准备语音');
    beginRecognition();
  } catch (error) {
    state.running = false;
    state.session = null;
    showError(error.message);
    updateControls();
  }
}

async function closeSession() {
  if (!state.session) return;
  const session = state.session;
  interruptPlayback('interrupted');
  state.running = false;
  stopRecognition();
  state.playback.directQueue.length = 0;
  state.playback.noticeQueue.length = 0;
  if (canSpeak) window.speechSynthesis.cancel();
  updateControls();
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/close`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    showError(error.message);
  } finally {
    setTimeout(() => {
      if (state.eventSource && state.session?.id === session.id) {
        state.eventSource.close();
        state.eventSource = null;
      }
    }, 800);
  }
}

function detectCapabilities() {
  if (canRecognize) {
    setCapability(elements.asrCapability, 'ready', '识别 · 浏览器');
  } else {
    setCapability(elements.asrCapability, 'unavailable', '识别 · 不可用');
    elements.capabilityNote.textContent = '本机语音识别不可用，可改用文字输入。';
  }
  if (canSpeak) {
    setCapability(elements.ttsCapability, 'ready', '播报 · 浏览器');
  } else {
    setCapability(elements.ttsCapability, 'unavailable', '播报 · 不可用');
    elements.capabilityNote.textContent += ' 本机语音播报不可用，消息仅显示文本。';
  }
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    setServerState('ready', '服务可用');
    elements.triggerStatus.textContent = health.lifecycle?.subscribed ? '已配置' : '未配置';
  } catch (error) {
    setServerState('warning', '服务不可用');
    showError(error.message);
  }
}

elements.startButton.addEventListener('click', () => {
  void startSession();
});
elements.stopButton.addEventListener('click', () => {
  void closeSession();
});
elements.muteButton.addEventListener('click', () => {
  state.muted = !state.muted;
  elements.muteButton.setAttribute('aria-pressed', String(state.muted));
  elements.muteButton.textContent = state.muted ? '播报已静音' : '播报已开启';
  if (state.muted) {
    interruptPlayback('interrupted');
    state.playback.directQueue.length = 0;
    if (canSpeak) window.speechSynthesis.cancel();
  } else {
    processPlaybackQueue();
  }
});
elements.textForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = elements.textInput.value;
  elements.textInput.value = '';
  void postUserText(text).catch((error) => showError(error.message));
});
window.addEventListener('pagehide', () => {
  if (!state.session || !state.running) return;
  const active = state.playback.active;
  if (active) settlePlayback(active, 'interrupted', 'page closed during playback', {
    keepalive: true,
  });
  fetch(`/api/sessions/${encodeURIComponent(state.session.id)}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    keepalive: true,
  }).catch(() => {});
});

detectCapabilities();
updateControls();
void loadHealth();
