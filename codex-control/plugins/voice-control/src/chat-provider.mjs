import fs from 'node:fs';

function validUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return url.href.replace(/\/$/, '');
}

function content(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

export class OpenAICompatibleChatProvider {
  constructor({
    endpoint,
    apiKey = null,
    model,
    timeoutMs = 60000,
    fetchImpl = fetch,
  } = {}) {
    const normalized = validUrl(endpoint);
    this.endpoint = normalized
      ? (normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`)
      : null;
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.endpoint && this.model);
  }

  async reply({ messages }) {
    if (!this.configured) {
      const error = new Error('Voice chat provider is not configured');
      error.code = 'chat_not_configured';
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('chat provider timed out')), this.timeoutMs);
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          temperature: 0.7,
          max_tokens: 800,
        }),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await response.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = { text };
      }
      if (!response.ok) {
        const error = new Error(value?.error?.message || `Chat provider failed with HTTP ${response.status}`);
        error.code = 'chat_provider_failed';
        throw error;
      }
      const answer = content(value?.choices?.[0]?.message?.content)
        || (typeof value?.output_text === 'string' ? value.output_text.trim() : '')
        || (typeof value?.text === 'string' ? value.text.trim() : '');
      if (!answer) {
        const error = new Error('Chat provider returned no assistant text');
        error.code = 'chat_provider_invalid';
        throw error;
      }
      return answer.slice(0, 12000);
    } catch (failure) {
      if (failure.code) throw failure;
      const error = new Error(`Chat provider request failed: ${failure.message}`);
      error.code = 'chat_provider_unavailable';
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createChatProvider(env = process.env) {
  const fileKey = env.VOICE_CONTROL_CHAT_API_KEY_FILE
    ? fs.readFileSync(env.VOICE_CONTROL_CHAT_API_KEY_FILE, 'utf8').trim()
    : null;
  const apiKey = env.VOICE_CONTROL_CHAT_API_KEY || fileKey || env.OPENAI_API_KEY || null;
  const endpointValue = env.VOICE_CONTROL_CHAT_URL
    || (apiKey ? 'https://api.openai.com/v1/chat/completions' : '');
  return new OpenAICompatibleChatProvider({
    endpoint: endpointValue,
    apiKey,
    model: env.VOICE_CONTROL_CHAT_MODEL || (apiKey ? 'gpt-4.1-mini' : ''),
    timeoutMs: Number(env.VOICE_CONTROL_CHAT_TIMEOUT_MS || 60000),
  });
}

