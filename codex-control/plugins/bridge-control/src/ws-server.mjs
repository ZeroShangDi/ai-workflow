import crypto from 'node:crypto';

import { WebSocket, WebSocketServer } from 'ws';

import { WsEventStore } from './ws-event-store.mjs';
import {
  normalizeEvent,
  normalizeTopics,
  requireWsString,
  topicMatches,
  WS_MAX_MESSAGE_BYTES,
  WS_PROTOCOL_VERSION,
} from './ws-protocol.mjs';

function sameToken(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cursorValue(value) {
  const cursor = String(value || '0');
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error('cursor must be a non-negative integer');
  return cursor;
}

function sendJson(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

export class ControlWebSocketServer {
  constructor({
    host = '127.0.0.1',
    port = 8792,
    token,
    store,
    handler = null,
    handshakeTimeoutMs = 5000,
    heartbeatMs = 30000,
    logger = console,
  } = {}) {
    if (typeof token !== 'string' || token.length < 32) throw new Error('token must contain at least 32 characters');
    if (!store) throw new Error('event store is required');
    this.host = host;
    this.port = port;
    this.token = token;
    this.store = store;
    this.handler = handler;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.logger = logger;
    this.clients = new Map();
    this.server = null;
    this.heartbeat = null;
  }

  async start() {
    if (this.server) return this.address();
    this.server = new WebSocketServer({
      host: this.host,
      port: this.port,
      maxPayload: WS_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.server.on('connection', (socket, request) => this.#connected(socket, request));
    await new Promise((resolve, reject) => {
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });
    this.heartbeat = setInterval(() => this.#heartbeat(), this.heartbeatMs);
    this.heartbeat.unref?.();
    return this.address();
  }

  address() {
    const address = this.server?.address();
    if (!address || typeof address === 'string') return null;
    return { host: this.host, port: address.port, url: `ws://${this.host}:${address.port}` };
  }

  async publish(value) {
    const event = normalizeEvent(value);
    const stored = this.store.append(event);
    this.#deliver(stored);
    return stored;
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const state of this.clients.values()) {
      clearTimeout(state.handshakeTimer);
      state.socket.close(1001, 'server shutdown');
    }
    this.clients.clear();
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }

  #connected(socket, request) {
    const state = {
      socket,
      request,
      authenticated: false,
      clientId: null,
      clientVersion: null,
      subscriptions: new Set(),
      cursor: '0',
      alive: true,
      handshakeTimer: null,
    };
    this.clients.set(socket, state);
    state.handshakeTimer = setTimeout(() => {
      if (!state.authenticated) socket.close(4001, 'handshake timeout');
    }, this.handshakeTimeoutMs);
    state.handshakeTimer.unref?.();
    socket.on('pong', () => { state.alive = true; });
    socket.on('message', (raw, binary) => {
      if (binary) return this.#error(socket, 'binary_not_supported', 'Binary messages are not supported');
      this.#message(state, raw).catch((failure) => {
        this.#error(socket, 'invalid_message', failure.message || 'Invalid WebSocket message');
      });
    });
    socket.on('close', () => {
      clearTimeout(state.handshakeTimer);
      this.clients.delete(socket);
    });
    socket.on('error', (error) => {
      this.logger.error?.(`bridge-control websocket client error: ${error.message}`);
    });
  }

  async #message(state, raw) {
    if (Buffer.byteLength(raw) > WS_MAX_MESSAGE_BYTES) throw new Error('message is too large');
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { throw new Error('message must be valid JSON'); }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      throw new Error('message.type is required');
    }
    if (message.type === 'hello') return this.#hello(state, message);
    if (!state.authenticated) return state.socket.close(4001, 'hello required');
    if (message.type === 'subscribe') return this.#subscribe(state, message);
    if (message.type === 'event') return this.#event(state, message);
    return this.#error(state.socket, 'unknown_message_type', `Unknown message type: ${message.type}`);
  }

  #hello(state, message) {
    if (state.authenticated) throw new Error('connection is already authenticated');
    if (message.protocolVersion !== WS_PROTOCOL_VERSION) throw new Error('unsupported protocol version');
    if (!sameToken(message.token, this.token)) {
      state.socket.close(4003, 'authentication failed');
      return;
    }
    state.authenticated = true;
    state.clientId = requireWsString(message.client?.id, 'client.id', 128);
    state.clientVersion = requireWsString(message.client?.version, 'client.version', 64);
    state.cursor = cursorValue(message.cursor);
    clearTimeout(state.handshakeTimer);
    sendJson(state.socket, {
      type: 'hello.ack',
      protocolVersion: WS_PROTOCOL_VERSION,
      connectionId: `wsc_${crypto.randomUUID()}`,
      server: { id: 'bridge-control', version: '0.3.0' },
      cursor: state.cursor,
      capabilities: ['subscribe', 'publish', 'replay'],
    });
  }

  #subscribe(state, message) {
    const topics = normalizeTopics(message.topics);
    state.subscriptions = new Set(topics);
    sendJson(state.socket, { type: 'subscribe.ack', topics });
    const replay = this.store.after(state.cursor, { topics, limit: 1000 });
    for (const event of replay) {
      sendJson(state.socket, { type: 'event', event });
      state.cursor = event.cursor;
    }
    sendJson(state.socket, { type: 'replay.complete', cursor: state.cursor });
  }

  async #event(state, message) {
    const event = normalizeEvent(message.event, { source: state.clientId });
    const accepted = this.store.append(event);
    this.#deliver(accepted, { exclude: state.socket });
    sendJson(state.socket, { type: 'event.ack', eventId: event.eventId, cursor: accepted.cursor });
    if (!this.handler) return;
    const result = await this.handler({
      event: accepted,
      client: {
        id: state.clientId,
        version: state.clientVersion,
      },
    });
    const responses = result === undefined || result === null
      ? []
      : (Array.isArray(result) ? result : [result]);
    for (const response of responses) await this.publish(response);
  }

  #deliver(event, { exclude = null } = {}) {
    for (const state of this.clients.values()) {
      if (!state.authenticated || state.socket === exclude) continue;
      if (![...state.subscriptions].some((topic) => topicMatches(topic, event.topic))) continue;
      sendJson(state.socket, { type: 'event', event });
      state.cursor = event.cursor;
    }
  }

  #heartbeat() {
    for (const state of this.clients.values()) {
      if (!state.alive) {
        state.socket.terminate();
        continue;
      }
      state.alive = false;
      state.socket.ping();
    }
  }

  #error(socket, code, message) {
    sendJson(socket, { type: 'error', error: { code, message } });
  }
}

export function createControlWebSocketServer({ config, store, handler, logger = console }) {
  return new ControlWebSocketServer({
    host: config.host,
    port: config.port,
    token: config.token,
    store: store || new WsEventStore(config.eventStoreFile),
    handler,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    heartbeatMs: config.heartbeatMs,
    logger,
  });
}
