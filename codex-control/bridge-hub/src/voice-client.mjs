import { CmbError } from './errors.mjs';
import { assertObject, tryParseJson } from './util.mjs';

export class VoiceTriggerClient {
  constructor({
    baseUrl,
    token = null,
    timeoutMs = 15000,
    fetchImpl = fetch,
  }) {
    if (!baseUrl) {
      this.baseUrl = null;
      this.token = null;
      this.timeoutMs = timeoutMs;
      this.fetch = fetchImpl;
      return;
    }
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new CmbError('voice.baseUrl must be an absolute HTTP(S) URL', {
        code: 'voice_config_invalid',
        status: 500,
      });
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new CmbError('voice.baseUrl must be a credential-free HTTP(S) URL', {
        code: 'voice_config_invalid',
        status: 500,
      });
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  async request(pathname, { method = 'GET', body } = {}) {
    if (!this.baseUrl) throw new CmbError('voice client is not configured', {
      code: 'voice_not_configured',
      status: 503,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${pathname}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      });
      const value = tryParseJson(await response.text());
      if (!response.ok) {
        throw new CmbError(value.error || `voice service failed with HTTP ${response.status}`, {
          code: value.code || 'voice_request_failed',
          status: 502,
          unknown: method !== 'GET',
        });
      }
      return value;
    } catch (error) {
      if (error instanceof CmbError) throw error;
      throw new CmbError(`voice service request failed: ${error.message}`, {
        code: method === 'GET' ? 'voice_unavailable' : 'voice_write_unknown',
        status: 502,
        unknown: method !== 'GET',
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return this.request('/api/v1/health');
  }

  publishTrigger(trigger) {
    return this.request('/api/v1/triggers', {
      method: 'POST',
      body: assertObject(trigger, 'trigger'),
    });
  }
}
