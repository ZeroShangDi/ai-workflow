import { createRealtimeAudio } from '/realtime-qwen.js';

const elements = {
  toggle: document.querySelector('#toggle'),
  toggleLabel: document.querySelector('#toggleLabel'),
  state: document.querySelector('#state'),
  transcript: document.querySelector('#transcript'),
  error: document.querySelector('#error'),
  speaker: document.querySelector('#speaker'),
};

const model = {
  active: false,
  opening: false,
  session: null,
  source: null,
  peer: null,
  stream: null,
  channel: null,
  realtime: null,
  noticeQueue: [],
  seen: new Set(),
};

function showError(value = '') {
  elements.error.textContent = value;
  elements.error.hidden = !value;
}

function setState(value) {
  elements.state.textContent = value;
}

function controls() {
  elements.toggle.disabled = model.opening;
  elements.toggle.setAttribute('aria-pressed', String(model.active));
  elements.toggleLabel.textContent = model.opening ? '正在连接' : model.active ? '结束聊天' : '开始聊天';
}

function append(role, text) {
  elements.transcript.querySelector('.placeholder')?.remove();
  const row = document.createElement('p');
  row.className = role;
  row.textContent = role === 'user' ? `你：${text}` : role === 'notice' ? `任务播报：${text}` : text;
  elements.transcript.append(row);
  while (elements.transcript.children.length > 8) elements.transcript.firstElementChild.remove();
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
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

function connectLocalEvents() {
  model.source?.close();
  const source = new EventSource(`/api/sessions/${encodeURIComponent(model.session.id)}/events?after=0`);
  model.source = source;
  source.addEventListener('trigger', (event) => {
    let value;
    try { value = JSON.parse(event.data); } catch { return; }
    if (model.seen.has(value.eventId)) return;
    model.seen.add(value.eventId);
    append('notice', value.text);
    const notice = { type: 'task_notice', id: value.noticeId, text: value.text };
    if (model.channel?.readyState === 'open') model.channel.send(JSON.stringify(notice));
    else model.noticeQueue.push(notice);
  });
}

function handleChannelMessage(event) {
  let value;
  try { value = JSON.parse(event.data); } catch { return; }
  if (model.realtime?.handle(value)) return;
  if (value.type === 'transcript' && ['user', 'assistant'].includes(value.role)) {
    append(value.role, value.text);
    return;
  }
  if (value.type === 'voice') {
    if (value.state === 'listening') setState('我在听');
    if (value.state === 'thinking') setState('正在想');
    if (value.state === 'working') setState('正在处理');
    if (value.state === 'speaking') setState('正在说');
    if (value.state === 'warning') {
      setState('可以继续说话');
      showError(value.message || '这次语音处理失败');
    }
    if (value.state === 'error') showError(value.message || '语音连接异常');
    return;
  }
  if (value.type === 'task_notice_ack' && typeof value.id === 'string' && model.session) {
    void api(`/api/sessions/${encodeURIComponent(model.session.id)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'delivery',
        noticeId: value.id,
        status: 'spoken',
        dedupeKey: `delivery:${value.id}:spoken`,
      }),
    }).catch(() => {});
  }
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('网络连接准备超时')), 8000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function start() {
  showError();
  model.opening = true;
  controls();
  setState('正在打开麦克风');
  try {
    let sessionId = null;
    model.realtime = createRealtimeAudio({
      send(value) {
        if (model.channel?.readyState === 'open') model.channel.send(JSON.stringify(value));
      },
      onDelivery(value) {
        if (!sessionId) return;
        void api(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: 'POST', body: JSON.stringify({ type: 'delivery', ...value,
            dedupeKey: `delivery:${value.noticeId}:${value.status}` }),
        }).catch(() => {});
      },
      onState(state) { setState(state === 'speaking' ? '正在说' : '我在听'); },
      onError: showError,
    });
    await model.realtime.prepare();
    const opened = await api('/api/open', { method: 'POST', body: JSON.stringify({}) });
    model.session = opened.session;
    sessionId = opened.session.id;
    model.seen.clear();
    connectLocalEvents();

    const capture = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    model.stream = capture;

    const peer = new RTCPeerConnection();
    model.peer = peer;
    const channel = peer.createDataChannel('chat');
    model.channel = channel;
    channel.onopen = () => {
      while (model.noticeQueue.length && channel.readyState === 'open') {
        channel.send(JSON.stringify(model.noticeQueue.shift()));
      }
    };
    channel.onmessage = handleChannelMessage;
    peer.ontrack = async (event) => {
      elements.speaker.srcObject = event.streams[0] || new MediaStream([event.track]);
      try { await elements.speaker.play(); } catch { showError('无法播放语音，请检查浏览器音频权限'); }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        model.opening = false;
        model.active = true;
        setState('我在听');
        controls();
      } else if (['failed', 'disconnected', 'closed'].includes(peer.connectionState) && model.active) {
        void stop(peer.connectionState === 'failed' ? '语音连接已断开' : '');
      }
    };
    capture.getTracks().forEach((track) => {
      track.onended = () => { if (model.active) void stop('麦克风已停止'); };
      peer.addTrack(track, capture);
    });

    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer);
    const voiceSession = await api('/api/voice/session', { method: 'POST', body: '{}' });
    const answer = await api('/api/voice/offer', {
      method: 'POST',
      body: JSON.stringify({
        ticket: voiceSession.ticket,
        sdp: peer.localDescription.sdp,
        type: peer.localDescription.type,
      }),
    });
    await peer.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
  } catch (failure) {
    await stop();
    showError(failure.message || '无法开启语音');
    setState('准备就绪');
  }
}

async function stop(message = '') {
  model.opening = false;
  model.active = false;
  model.realtime?.close();
  model.realtime = null;
  model.channel = null;
  model.noticeQueue.length = 0;
  model.source?.close();
  model.source = null;
  model.stream?.getTracks().forEach((track) => track.stop());
  model.stream = null;
  const peer = model.peer;
  model.peer = null;
  peer?.close();
  elements.speaker.pause();
  elements.speaker.srcObject = null;
  const session = model.session;
  model.session = null;
  controls();
  if (message) showError(message);
  setState(message || '准备就绪');
  if (session) {
    await api('/api/close', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id }),
    }).catch(() => {});
  }
}

elements.toggle.addEventListener('click', () => {
  if (model.opening) return;
  if (model.active || model.peer) void stop(); else void start();
});
window.addEventListener('pagehide', () => {
  if (model.session) {
    navigator.sendBeacon?.(
      '/api/close',
      new Blob([JSON.stringify({ sessionId: model.session.id })], { type: 'application/json' }),
    );
  }
});
controls();
void api('/api/health').then((health) => {
  if (!health.audio?.configured) {
    showError('语音后端未配置，请设置 VOICE_CENTER_AUDIO_SERVICE_URL 和票据密钥。');
  }
}).catch((failure) => showError(failure.message));
