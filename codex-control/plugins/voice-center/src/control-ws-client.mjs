import crypto from 'node:crypto';
import fs from 'node:fs';

const PROTOCOL_VERSION = 1;
const MAX_QUEUE = 100;

function normalizeTopics(topics) {
  if (!Array.isArray(topics) || !topics.length) throw new Error('subscribeTopics must be a non-empty array');
  return [...new Set(topics.map((topic) => String(topic).trim()).filter(Boolean))];
}

async function messageText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Blob) return value.text();
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  return String(value);
}

export class ControlWebSocketClient {
  constructor({
    url = 'ws://127.0.0.1:8792',
    token = '',
    tokenFile = '',
    clientId = 'voice-center',
    clientVersion = '0.3.0',
    cursor = '0',
    subscribeTopics = ['control.*', 'task.*', 'interaction.*', 'artifact.*'],
    WebSocketImpl = globalThis.WebSocket,
    handshakeTimeoutMs = 5000,
    reconnectMinMs = 500,
    reconnectMaxMs = 10000,
    onEvent = () => {},
    onStatus = () => {},
    now = () => Date.now(),
  } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is unavailable in this runtime');
    this.url = url;
    this.token = String(token || '').trim();
    this.tokenFile = String(tokenFile || '');
    this.clientId = clientId;
    this.clientVersion = clientVersion;
    this.subscribeTopics = normalizeTopics(subscribeTopics);
    this.WebSocketImpl = WebSocketImpl;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.now = now;
    this.socket = null;
    this.status = 'idle';
    this.stopped = true;
    this.connected = false;
    this.cursor = String(cursor || '0');
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    this.outbox = [];
    this.pending = new Map();
    this.connectWaiters = new Set();
  }

  statusValue() {
    return {
      state: this.status,
      connected: this.connected,
      url: this.url,
      cursor: this.cursor,
    };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    this.connected = false;
    this.socket?.close(1000, 'client shutdown');
    this.socket = null;
    this.#setStatus('stopped');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Control WebSocket client stopped'));
    }
    this.pending.clear();
  }

  async waitUntilConnected(timeoutMs = 3000) {
    if (this.connected) return this.statusValue();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        this.connectWaiters.delete(waiter);
        reject(new Error('Control WebSocket is unavailable'));
      }, timeoutMs);
      timer.unref?.();
      this.connectWaiters.add(waiter);
    });
  }

  async request(topic, payload = {}, { timeoutMs = 15000, responseTopics = ['control.*'] } = {}) {
    const event = {
      schemaVersion: 1,
      eventId: `evt_${crypto.randomUUID()}`,
      correlationId: `req_${crypto.randomUUID()}`,
      topic,
      source: this.clientId,
      createdAt: new Date(this.now()).toISOString(),
      payload,
    };
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(event.correlationId);
        reject(new Error(`Control response timed out for ${topic}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(event.correlationId, {
        resolve,
        reject,
        timer,
        topics: normalizeTopics(responseTopics),
      });
    });
    this.#queueEvent(event);
    return response;
  }

  publish(event) {
    this.#queueEvent(event);
  }

  #connect() {
    if (this.stopped || this.socket) return;
    this.#setStatus('connecting');
    let token;
    try {
      token = this.token || fs.readFileSync(this.tokenFile, 'utf8').trim();
    } catch (error) {
      this.#disconnected(new Error(`Control WebSocket token is unavailable: ${error.message}`));
      return;
    }
    if (token.length < 32) {
      this.#disconnected(new Error('Control WebSocket token is unavailable or too short'));
      return;
    }
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.#disconnected(error);
      return;
    }
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      if (!this.connected) socket.close(4001, 'handshake timeout');
    }, this.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        client: { id: this.clientId, version: this.clientVersion },
        token,
        cursor: this.cursor,
      }));
    });
    socket.addEventListener('message', (event) => { void this.#message(event.data); });
    socket.addEventListener('close', () => this.#disconnected());
    socket.addEventListener('error', () => {
      // Close carries the reconnect decision; avoid duplicate reconnect timers.
    });
  }

  async #message(raw) {
    let message;
    try { message = JSON.parse(await messageText(raw)); } catch { return; }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.type === 'hello.ack') {
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        this.socket?.close(4002, 'protocol mismatch');
        return;
      }
      this.socket.send(JSON.stringify({ type: 'subscribe', topics: this.subscribeTopics }));
      return;
    }
    if (message.type === 'subscribe.ack' || message.type === 'replay.complete') {
      if (message.type === 'replay.complete') this.cursor = String(message.cursor || this.cursor);
      if (!this.connected && message.type === 'replay.complete') {
        this.connected = true;
        this.reconnectAttempt = 0;
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.#setStatus('connected');
        for (const waiter of [...this.connectWaiters]) {
          this.connectWaiters.delete(waiter);
          waiter.resolve(this.statusValue());
        }
        this.#flush();
      }
      return;
    }
    if (message.type === 'event' && message.event) {
      const event = message.event;
      if (event.cursor && /^(0|[1-9][0-9]*)$/.test(String(event.cursor))) {
        this.cursor = String(event.cursor);
      }
      const pending = event.correlationId ? this.pending.get(event.correlationId) : null;
      if (pending && pending.topics.some((topic) => (
        topic === event.topic || (topic.endsWith('.*') && event.topic.startsWith(topic.slice(0, -1)))
      ))) {
        clearTimeout(pending.timer);
        this.pending.delete(event.correlationId);
        pending.resolve(event);
      }
      this.onEvent(event);
      return;
    }
    if (message.type === 'event.ack') {
      this.outbox = this.outbox.filter((event) => event.eventId !== message.eventId);
      return;
    }
    if (message.type === 'error') {
      this.onStatus({ ...this.statusValue(), error: message.error || null });
    }
  }

  #queueEvent(event) {
    if (this.outbox.length >= MAX_QUEUE) this.outbox.shift();
    this.outbox.push(event);
    if (this.connected) this.#sendEvent(event);
  }

  #flush() {
    for (const event of this.outbox) this.#sendEvent(event);
  }

  #sendEvent(event) {
    if (!this.connected || this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify({ type: 'event', event }));
  }

  #disconnected(error = null) {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    if (this.stopped) return;
    this.#setStatus('unavailable', error);
    if (wasConnected) this.reconnectAttempt = 0;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * (2 ** Math.min(6, this.reconnectAttempt)),
    );
    this.reconnectAttempt += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.#connect(), delay);
    this.reconnectTimer.unref?.();
  }

  #setStatus(state, error = null) {
    this.status = state;
    this.onStatus({ ...this.statusValue(), error: error ? String(error.message || error) : null });
  }
}
