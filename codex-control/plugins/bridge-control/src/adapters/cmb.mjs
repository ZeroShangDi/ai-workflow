import crypto from 'node:crypto';
import { assertBaseUrl, passwordFor } from '../config.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSessionId(value) {
  return UUID.test(String(value || ''));
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

export function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const text = data.join('\n');
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}

function assistantText(state) {
  const turns = Array.isArray(state?.turns) ? state.turns : [];
  const messages = turns.flatMap((turn) => Array.isArray(turn?.messages) ? turn.messages : []);
  return messages
    .filter((message) => message?.role === 'assistant')
    .map((message) => String(message.text || ''))
    .filter(Boolean)
    .join('\n');
}

export class CmbAdapter {
  constructor(config) {
    this.config = config;
    this.baseUrl = assertBaseUrl(config.baseUrl);
    this.cookie = '';
    this.csrf = '';
    this.loggingIn = null;
  }

  async request(pathname, { method = 'GET', body, signal, retryAuth = true } = {}) {
    await this.login();
    const headers = {
      Accept: 'application/json',
      Cookie: this.cookie,
    };
    if (body !== undefined) {
      headers.Origin = this.baseUrl;
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = this.csrf;
    }
    const response = await fetch(this.baseUrl + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    if (response.status === 401 && retryAuth && method === 'GET') {
      this.cookie = '';
      this.csrf = '';
      await this.login();
      return this.request(pathname, { method, body, signal, retryAuth: false });
    }
    const text = await response.text();
    let value = {};
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        value = { text };
      }
    }
    if (!response.ok) {
      throw new Error(value.error || `CMB request failed with HTTP ${response.status}`);
    }
    return value;
  }

  async login() {
    if (this.cookie && this.csrf) return;
    if (this.loggingIn) return this.loggingIn;
    this.loggingIn = (async () => {
      const password = passwordFor(this.config);
      const response = await fetch(`${this.baseUrl}/api/login`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Origin: this.baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: this.config.username, password, remember: false }),
        redirect: 'error',
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(value.error || `CMB login failed with HTTP ${response.status}`);
      }
      const cookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      const cookie = cookies.map((item) => String(item).split(';', 1)[0]).find((item) => item.includes('='));
      if (!cookie || !value.csrf) throw new Error('CMB login did not return a session');
      this.cookie = cookie;
      this.csrf = value.csrf;
    })();
    try {
      await this.loggingIn;
    } finally {
      this.loggingIn = null;
    }
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

  async projects() {
    const value = await this.request('/api/projects');
    return (value.projects || []).map((project) => ({
      id: project.key,
      name: project.name,
      cwd: project.cwd || null,
    }));
  }

  async sessions({ query = '', limit = 20 } = {}) {
    const params = new URLSearchParams({
      q: String(query || '').slice(0, 200),
      limit: String(bounded(limit, 20, 1, 50)),
      source: 'all',
    });
    const value = await this.request(`/api/sessions?${params}`);
    return {
      sessions: (value.sessions || []).slice(0, bounded(limit, 20, 1, 50)).map((session) => ({
        id: session.id,
        title: session.title || 'Untitled',
        project: session.projectName || session.project || null,
        cwd: session.cwd || null,
        provider: session.provider || null,
        source: session.source || null,
        host: session.host || 'local',
      })),
      availableSources: value.availableSources || [],
      unavailableHosts: value.unavailableHosts || [],
    };
  }

  async resolveProject(project, fallback) {
    const desired = String(project || fallback || '').trim();
    if (!desired) throw new Error('A CMB project is required when creating a chat');
    const projects = await this.projects();
    const match = projects.find((row) => row.id === desired)
      || projects.find((row) => row.name === desired)
      || projects.find((row) => row.cwd === desired);
    if (!match) throw new Error(`CMB project not found: ${desired}`);
    return match.id;
  }

  async createChat({ project, title } = {}) {
    const projectId = await this.resolveProject(project, this.config.defaultProject);
    const id = crypto.randomUUID();
    const value = await this.request('/api/sessions', {
      method: 'POST',
      body: { id, project: projectId, title: title || 'Bridge Control test' },
    });
    return { id: value.id || id, host: value.host || 'local', message: value.message || '' };
  }

  async view(sessionId) {
    if (!isSessionId(sessionId)) throw new Error('Session ID is invalid');
    return this.request(`/api/sessions/${sessionId}`);
  }

  async waitUntilConnected(sessionId, timeoutMs = 30000, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const view = await this.view(sessionId);
      if (view.connected === true) return view;
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (signal?.aborted) throw new Error('Bridge operation was cancelled');
    }
    throw new Error('CMB session did not connect before the deadline');
  }

  async send(sessionId, text) {
    if (!isSessionId(sessionId)) throw new Error('Session ID is invalid');
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) {
      throw new Error('Message must contain 1 to 100000 characters');
    }
    return this.request(`/api/sessions/${sessionId}/send`, {
      method: 'POST',
      body: {
        id: crypto.randomUUID(),
        text,
        mode: 'send',
        skills: [],
        workMode: 'default',
        attachments: [],
        uiLocale: 'zh-CN',
      },
    });
  }

  async openEvents(sessionId, signal) {
    await this.login();
    const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/events`, {
      headers: {
        Accept: 'text/event-stream',
        Cookie: this.cookie,
      },
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error(`CMB event stream failed with HTTP ${response.status}`);
    return response;
  }

  async chat({ sessionId, project, title, text, timeoutMs = 120000, onProgress = () => {} }) {
    let id = sessionId;
    if (!id) {
      const created = await this.createChat({ project, title });
      id = created.id;
      await this.waitUntilConnected(id, 30000);
    }
    const before = await this.view(id);
    const baseline = new Set((before.turns || []).map((turn) => turn.turnId || turn.id).filter(Boolean));
    const timeout = bounded(timeoutMs, 120000, 5000, 600000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const startedAt = Date.now();
    let firstUpdateMs = null;
    let stateUpdates = 0;
    let latest = before;
    let finalText = '';
    try {
      const response = await this.openEvents(id, controller.signal);
      const sent = await this.send(id, text);
      onProgress({ progress: 5, message: `Message accepted: ${sent.status || 'accepted'}` });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary).replace(/\r/g, '');
          buffer = buffer.slice(boundary + 2);
          const event = parseSseBlock(block);
          if (!event || event.event !== 'state' || !event.data || typeof event.data !== 'object') continue;
          latest = event.data;
          stateUpdates += 1;
          if (firstUpdateMs == null) firstUpdateMs = Date.now() - startedAt;
          const newTurns = (latest.turns || []).filter((turn) => {
            const turnId = turn.turnId || turn.id;
            return turnId && !baseline.has(turnId);
          });
          const currentText = assistantText({ turns: newTurns });
          const progress = Math.min(95, 10 + stateUpdates * 4 + Math.min(40, currentText.length));
          onProgress({
            progress,
            message: currentText
              ? `Reply streaming: ${currentText.length} chars`
              : `CMB state: ${latest.status || 'active'}`,
          });
          const completed = newTurns.find((turn) => turn.status === 'completed' && assistantText({ turns: [turn] }));
          if (completed) {
            finalText = assistantText({ turns: [completed] });
            break;
          }
        }
        if (finalText) break;
      }
      if (!finalText) {
        throw new Error(`CMB reply did not complete (${latest.status || 'unknown'} after ${stateUpdates} state updates)`);
      }
      return {
        sessionId: id,
        status: latest.status || 'unknown',
        connected: latest.connected === true,
        stateUpdates,
        firstUpdateMs,
        elapsedMs: Date.now() - startedAt,
        reply: finalText,
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
