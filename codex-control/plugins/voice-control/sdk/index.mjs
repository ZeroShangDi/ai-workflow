export class VoiceClientError extends Error {
  constructor(message, { status = 0, body = null, cause } = {}) {
    super(message, { cause });
    this.name = 'VoiceClientError';
    this.status = status;
    this.body = body;
  }
}

function baseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('baseUrl is required');
  return value.replace(/\/+$/, '');
}

function mergeSignals(local, external) {
  if (!external) return () => {};
  const abort = () => local.abort(external.reason);
  if (external.aborted) abort();
  else external.addEventListener('abort', abort, { once: true });
  return () => external.removeEventListener('abort', abort);
}

function parseSseBlock(block) {
  let event = 'message';
  let id = null;
  const data = [];
  for (const rawLine of block.split('\n')) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    let value = separator === -1 ? '' : rawLine.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { event, id, data: data.join('\n') };
}

class SseParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.line = '';
    this.block = '';
    this.pendingCarriageReturn = false;
  }

  feed(chunk) {
    for (const character of chunk) {
      if (character === '\r') {
        this.pendingCarriageReturn = true;
        continue;
      }
      if (character === '\n') {
        this.#endLine();
        this.pendingCarriageReturn = false;
        continue;
      }
      if (this.pendingCarriageReturn) {
        this.#endLine();
        this.pendingCarriageReturn = false;
      }
      this.line += character;
    }
  }

  finish() {
    if (this.pendingCarriageReturn) this.#endLine();
    if (this.line) this.#endLine();
    if (this.block.trim()) this.#emitBlock();
  }

  #endLine() {
    if (this.line === '') {
      if (this.block) this.#emitBlock();
    } else {
      this.block += `${this.line}\n`;
    }
    this.line = '';
  }

  #emitBlock() {
    const frame = parseSseBlock(this.block.trimEnd());
    this.block = '';
    if (frame) this.onFrame(frame);
  }
}

export function createVoiceClient({
  baseUrl: baseUrlValue,
  fetch: fetchImpl = globalThis.fetch,
  headers = {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const root = baseUrl(baseUrlValue);

  async function request(path, { method = 'GET', body, signal } = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      throw new VoiceClientError(
        parsed?.error?.message || `Voice control request failed with ${response.status}`,
        { status: response.status, body: parsed },
      );
    }
    return parsed;
  }

  return {
    async getHealth({ signal } = {}) {
      return request('/api/health', { signal });
    },

    async createSession(options = {}) {
      const { signal, ...body } = options;
      const result = await request('/api/sessions', {
        method: 'POST',
        body,
        signal,
      });
      return result.session;
    },

    async closeSession(sessionId) {
      const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
        body: {},
      });
      return result.session;
    },

    async appendEvent(sessionId, event) {
      const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST',
        body: event,
      });
      return result;
    },

    async dispatchTrigger(triggerId, event) {
      const result = await request(`/api/triggers/${encodeURIComponent(triggerId)}/dispatch`, {
        method: 'POST',
        body: event,
      });
      return result;
    },

    async subscribe(sessionId, {
      after = '0',
      signal,
      onEvent = () => {},
      onError = () => {},
      onEnd = () => {},
    } = {}) {
      const controller = new AbortController();
      const detach = mergeSignals(controller, signal);
      const url = new URL(`${root}/api/sessions/${encodeURIComponent(sessionId)}/events`);
      url.searchParams.set('after', String(after));
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...headers,
          'Last-Event-ID': String(after),
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        detach();
        throw new VoiceClientError(
          `Voice event stream failed with ${response.status}`,
          { status: response.status },
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser((frame) => {
        if (frame.event === 'stream.end') {
          onEnd(frame.data ? JSON.parse(frame.data) : {});
          return;
        }
        let payload;
        try {
          payload = JSON.parse(frame.data);
        } catch (error) {
          throw new VoiceClientError('Voice event stream contained invalid JSON', { cause: error });
        }
        onEvent(payload, frame);
      });

      const finished = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.feed(decoder.decode(value, { stream: true }));
          }
          parser.feed(decoder.decode());
          parser.finish();
        } catch (error) {
          if (!controller.signal.aborted) {
            await onError(error);
            throw error;
          }
        } finally {
          detach();
        }
      })();
      void finished.catch(() => {});

      return {
        finished,
        close() {
          controller.abort();
        },
      };
    },
  };
}
