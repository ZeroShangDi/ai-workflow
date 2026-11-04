import { tryParseJson } from './util.mjs';

class ControlClientError extends Error {
  constructor(message, {
    code = 'hub_request_failed',
    status = 0,
    details = null,
    unknown = false,
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'ControlClientError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.unknown = unknown;
  }
}

function endpoint(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new ControlClientError('BRIDGE_HUB_URL must be an absolute HTTP(S) URL', {
      code: 'HUB_NOT_CONFIGURED',
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ControlClientError('BRIDGE_HUB_URL must be a credential-free HTTP(S) URL', {
      code: 'HUB_NOT_CONFIGURED',
    });
  }
  return url.href.replace(/\/$/, '');
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function timeoutValue(value) {
  const timeout = value === undefined || value === null || value === ''
    ? 30000
    : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) {
    throw new ControlClientError('Hub timeout must be an integer from 1000 to 600000 ms', {
      code: 'HUB_NOT_CONFIGURED',
    });
  }
  return timeout;
}

export class HubControlClient {
  constructor({
    baseUrl,
    token = null,
    consumer = 'bridge-control',
    voiceConsumer = 'voice-control',
    timeoutMs = 30000,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = endpoint(baseUrl);
    this.token = token;
    this.consumer = consumer;
    this.voiceConsumer = voiceConsumer;
    this.timeoutMs = timeoutValue(timeoutMs);
    this.fetch = fetchImpl;
  }

  async request(pathname, {
    method = 'GET',
    query,
    body,
    signal,
  } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Hub request timed out')),
      this.timeoutMs,
    );
    const mergedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const write = method !== 'GET';
    try {
      const response = await this.fetch(
        `${this.baseUrl}${pathname}${queryString(query)}`,
        {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: {
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          redirect: 'error',
          signal: mergedSignal,
        },
      );
      const value = tryParseJson(await response.text());
      if (!response.ok) {
        const unknown = value.result === 'unknown';
        throw new ControlClientError(value.error || `Hub request failed with ${response.status}`, {
          code: unknown ? 'UNKNOWN_RESULT' : (value.code || 'hub_request_failed'),
          status: response.status,
          details: value.details || null,
          unknown,
        });
      }
      return value;
    } catch (error) {
      if (error instanceof ControlClientError) throw error;
      throw new ControlClientError(`Hub request failed: ${error.message}`, {
        code: write ? 'UNKNOWN_RESULT' : 'HUB_UNAVAILABLE',
        status: 502,
        unknown: write,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  latestUserTranscript({ sessionId }) {
    return this.request('/api/v1/chat/latest-user-transcript', {
      query: { sessionId, consumer: this.consumer },
    }).then((value) => value.transcript);
  }

  getPending({ sessionId, interactionId }) {
    return this.request('/api/v1/chat/pending', {
      query: { sessionId, interactionId, consumer: this.consumer },
    }).then((value) => value.interaction || null);
  }

  createWork({
    sessionId,
    draftId,
    binding,
    draft,
    transcript,
    idempotencyKey,
  }) {
    return this.request('/api/v1/chat/work/create', {
      method: 'POST',
      body: {
        consumer: this.consumer,
        sessionId,
        draftId,
        binding,
        draft,
        transcript,
        idempotencyKey,
      },
    });
  }

  findWork({ query, limit }) {
    return this.request('/api/v1/chat/work/find', {
      query: { consumer: this.consumer, query, limit },
    });
  }

  getStatus({ sessionId, workId }) {
    return this.request('/api/v1/chat/work/status', {
      query: { consumer: this.consumer, sessionId, workId },
    });
  }

  sendMessage({
    sessionId,
    workId,
    text,
    mode,
    idempotencyKey,
  }) {
    return this.request('/api/v1/chat/work/send', {
      method: 'POST',
      body: {
        consumer: this.consumer,
        sessionId,
        workId,
        text,
        mode,
        idempotencyKey,
      },
    });
  }

  readWork({
    sessionId,
    workId,
    view,
    before,
    after,
    maxChars,
  }) {
    return this.request('/api/v1/chat/work/read', {
      query: {
        consumer: this.consumer,
        sessionId,
        workId,
        view,
        before,
        after,
        maxChars,
      },
    });
  }

  readEvents({ sessionId, after, topics, limit }) {
    const params = new URLSearchParams();
    params.set('consumer', this.consumer);
    if (after === undefined || after === null) params.set('after', '0');
    else params.set('after', String(after));
    if (limit !== undefined) params.set('limit', String(limit));
    for (const topic of topics || []) params.append('topic', topic);
    if (sessionId) params.set('sessionId', sessionId);
    return this.request(`/api/v1/chat/events?${params}`);
  }

  resolveAnswer(args) {
    return this.request('/api/v1/chat/work/answer', {
      method: 'POST',
      body: { consumer: this.consumer, ...args },
    });
  }

  resolveApproval(args) {
    return this.request('/api/v1/chat/work/approve', {
      method: 'POST',
      body: { consumer: this.consumer, ...args },
    });
  }

  stopWork(args) {
    return this.request('/api/v1/chat/work/stop', {
      method: 'POST',
      body: { consumer: this.consumer, ...args },
    });
  }

  emitProgress(args) {
    return this.request('/api/v1/chat/work/progress', {
      method: 'POST',
      body: { consumer: this.consumer, ...args },
    });
  }

  requestInput(args) {
    return this.request('/api/v1/chat/work/request-input', {
      method: 'POST',
      body: { consumer: this.consumer, ...args },
    });
  }

  requestApproval(args) {
    return this.request('/api/v1/chat/work/request-approval', {
      method: 'POST',
      body: { consumer: this.consumer, ...args },
    });
  }

  publishArtifact(args) {
    return this.request('/api/v1/chat/work/artifact', {
      method: 'POST',
      body: { consumer: this.consumer, ...args },
    });
  }

  finishWork(args) {
    return this.request('/api/v1/chat/work/finish', {
      method: 'POST',
      body: { consumer: this.consumer, ...args },
    });
  }

  ackAnnouncement({ noticeId, deliveryStatus, error }) {
    return this.request('/api/v1/chat/announcement/ack', {
      method: 'POST',
      body: {
        consumer: this.voiceConsumer,
        noticeId,
        deliveryStatus,
        error,
      },
    });
  }
}

export function createHubClient({ env = process.env } = {}) {
  return new HubControlClient({
    baseUrl: env.BRIDGE_HUB_URL,
    token: env.BRIDGE_HUB_API_TOKEN || null,
    consumer: env.BRIDGE_CONTROL_CONSUMER || 'bridge-control',
    voiceConsumer: env.BRIDGE_VOICE_CONSUMER || 'voice-control',
    timeoutMs: Number(env.BRIDGE_CONTROL_TIMEOUT_MS || 30000),
  });
}
