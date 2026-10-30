import crypto from 'node:crypto';

import { CmbError } from './errors.mjs';
import {
  assertSessionId,
  boundedInteger,
  requireText,
  tryParseJson,
} from './util.mjs';

export function parseSseBlock(block) {
  let id = null;
  let event = 'message';
  const data = [];
  for (const line of block.replace(/\r/g, '').split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('id:')) id = line.slice(3).trim();
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const text = data.join('\n');
  try {
    return { id, event, data: JSON.parse(text) };
  } catch {
    return { id, event, data: text };
  }
}

export async function* readSse(response, { signal } = {}) {
  if (!response.body) throw new CmbError('CMB SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function cookieFromResponse(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return values
    .map((value) => String(value).split(';', 1)[0].trim())
    .find((value) => value.includes('=')) || null;
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new CmbError('CMB baseUrl must be an absolute HTTP(S) URL', {
      code: 'cmb_config_invalid',
      status: 500,
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CmbError('CMB baseUrl must be a credential-free HTTP(S) URL', {
      code: 'cmb_config_invalid',
      status: 500,
    });
  }
  return url.href.replace(/\/$/, '');
}

function requestFailure(error, write) {
  if (error instanceof CmbError) return error;
  const unknown = Boolean(write);
  return new CmbError(`CMB request failed: ${error.message}`, {
    code: unknown ? 'write_result_unknown' : 'cmb_unavailable',
    status: 502,
    unknown,
    cause: error,
  });
}

export class CmbAdapter {
  constructor({
    baseUrl,
    username,
    password,
    timeoutMs = 120000,
    fetchImpl = fetch,
  }) {
    this.baseUrl = validateBaseUrl(baseUrl);
    this.username = requireText(username, 'cmb.username', 200);
    this.password = requireText(password, 'cmb.password', 1000);
    this.timeoutMs = boundedInteger(timeoutMs, {
      fallback: 120000,
      minimum: 1000,
      maximum: 600000,
      field: 'cmb.timeoutMs',
    });
    this.fetch = fetchImpl;
    this.cookie = null;
    this.csrf = null;
    this.loginPromise = null;
  }

  async #raw(pathname, { method = 'GET', body, headers = {}, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('CMB request timed out')), this.timeoutMs);
    const mergedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      return await this.fetch(`${this.baseUrl}${pathname}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          Accept: 'application/json',
          ...headers,
        },
        redirect: 'error',
        signal: mergedSignal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async login() {
    if (this.cookie && this.csrf) return;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      try {
        const response = await this.#raw('/api/login', {
          method: 'POST',
          headers: {
            Origin: this.baseUrl,
            'Content-Type': 'application/json',
          },
          body: {
            username: this.username,
            password: this.password,
            remember: false,
          },
        });
        const text = await response.text();
        const value = tryParseJson(text);
        if (!response.ok) {
          throw new CmbError(value.error || `CMB login failed with HTTP ${response.status}`, {
            code: value.code || 'cmb_login_failed',
            status: response.status === 401 || response.status === 403 ? 401 : 502,
          });
        }
        const cookie = cookieFromResponse(response);
        if (!cookie || !value.csrf) {
          throw new CmbError('CMB login did not return a session and CSRF token', {
            code: 'cmb_login_invalid',
          });
        }
        this.cookie = cookie;
        this.csrf = value.csrf;
      } catch (error) {
        throw requestFailure(error, false);
      }
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async request(pathname, {
    method = 'GET',
    body,
    signal,
    retryAuth = true,
  } = {}) {
    await this.login();
    const write = method !== 'GET';
    let response;
    try {
      response = await this.#raw(pathname, {
        method,
        body,
        signal,
        headers: {
          Cookie: this.cookie,
          ...(write ? {
            Origin: this.baseUrl,
            'Content-Type': 'application/json',
            'X-CSRF-Token': this.csrf,
          } : {}),
        },
      });
    } catch (error) {
      throw requestFailure(error, write);
    }
    if (response.status === 401 && retryAuth && !write) {
      this.cookie = null;
      this.csrf = null;
      await this.login();
      return this.request(pathname, { method, body, signal, retryAuth: false });
    }
    const text = await response.text();
    const value = tryParseJson(text);
    if (!response.ok) {
      throw new CmbError(value.error || `CMB request failed with HTTP ${response.status}`, {
        code: value.code || 'cmb_request_failed',
        status: response.status === 401 ? 401 : (response.status >= 500 ? 502 : 409),
        unknown: write && response.status >= 500,
      });
    }
    return value;
  }

  async status() {
    const auth = await this.request('/api/auth');
    return {
      software: 'cmb',
      baseUrl: this.baseUrl,
      authenticated: auth.authenticated === true,
      instanceId: auth.instanceId || null,
      computer: auth.computer || null,
      passwordless: auth.passwordless === true,
      transport: auth.transport || null,
    };
  }

  async sessions({ query = '', limit = 20 } = {}) {
    const size = boundedInteger(limit, {
      fallback: 20,
      minimum: 1,
      maximum: 50,
      field: 'limit',
    });
    const params = new URLSearchParams({
      q: String(query || '').slice(0, 200),
      limit: String(size),
      source: 'all',
    });
    const value = await this.request(`/api/sessions?${params}`);
    return {
      sessions: (value.sessions || []).slice(0, size).map((session) => ({
        id: session.id,
        title: session.title || 'Untitled',
        project: session.projectName || session.project || null,
        cwd: session.cwd || null,
        provider: session.provider || null,
        source: session.source || null,
        host: session.host || null,
      })),
      availableSources: value.availableSources || [],
      unavailableHosts: value.unavailableHosts || [],
    };
  }

  async view(sessionId) {
    const id = assertSessionId(sessionId);
    return this.request(`/api/sessions/${encodeURIComponent(id)}`);
  }

  async send(sessionId, {
    text,
    requestId = crypto.randomUUID(),
    mode = 'send',
    skills = [],
    workMode = 'default',
    attachments = [],
    uiLocale = 'zh-CN',
  } = {}) {
    const id = assertSessionId(sessionId);
    const message = requireText(text, 'text', 100000);
    if (!['send', 'queue', 'steer'].includes(mode)) {
      throw new CmbError('CMB send mode is unsupported', {
        code: 'invalid_request',
        status: 400,
      });
    }
    if (!Array.isArray(skills) || !Array.isArray(attachments)) {
      throw new CmbError('skills and attachments must be arrays', {
        code: 'invalid_request',
        status: 400,
      });
    }
    return this.request(`/api/sessions/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      body: {
        id: requireText(requestId, 'requestId', 128),
        text: message,
        mode,
        skills,
        workMode,
        attachments,
        uiLocale,
      },
    });
  }

  async openEvents(sessionId, { signal } = {}) {
    const id = assertSessionId(sessionId);
    await this.login();
    const open = async () => {
      try {
        return await this.#raw(`/api/sessions/${encodeURIComponent(id)}/events`, {
          headers: {
            Accept: 'text/event-stream',
            Cookie: this.cookie,
          },
          signal,
        });
      } catch (error) {
        throw requestFailure(error, false);
      }
    };
    let response = await open();
    if (response.status === 401) {
      this.cookie = null;
      this.csrf = null;
      await this.login();
      response = await open();
    }
    if (!response.ok) {
      const text = await response.text();
      const value = tryParseJson(text);
      throw new CmbError(value.error || `CMB event stream failed with HTTP ${response.status}`, {
        code: 'cmb_sse_failed',
        status: response.status === 401 ? 401 : 502,
      });
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      throw new CmbError('CMB events endpoint did not return an SSE stream', {
        code: 'cmb_sse_invalid',
        status: 502,
      });
    }
    return response;
  }
}
