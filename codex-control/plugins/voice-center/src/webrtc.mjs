import crypto from 'node:crypto';
import fs from 'node:fs';

import { VoiceControlError } from './errors.mjs';

function absoluteUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('VOICE_CENTER_AUDIO_SERVICE_URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('VOICE_CENTER_AUDIO_SERVICE_URL must be a credential-free HTTP(S) URL');
  }
  return url.href.replace(/\/$/, '');
}

function ticketSecret(env) {
  if (env.VOICE_CENTER_TICKET_SECRET) return env.VOICE_CENTER_TICKET_SECRET.trim();
  if (env.VOICE_CENTER_TICKET_SECRET_FILE) {
    return fs.readFileSync(env.VOICE_CENTER_TICKET_SECRET_FILE, 'utf8').trim();
  }
  return '';
}

function identity(env) {
  return {
    tenant: String(env.VOICE_CENTER_TENANT || '0'),
    user: String(env.VOICE_CENTER_USER || '1'),
    device: String(env.VOICE_CENTER_DEVICE || '1'),
  };
}

export function encodeTicket(claims, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('ticket secret is too short');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export class VoiceWebRtcTransport {
  constructor({
    serviceUrl = '',
    secret = '',
    identity: identityValue = { tenant: '0', user: '1', device: '1' },
    timeoutMs = 20000,
    now = () => Date.now(),
    fetchImpl = fetch,
  } = {}) {
    this.serviceUrl = serviceUrl ? absoluteUrl(serviceUrl) : null;
    this.secret = secret;
    this.identity = identityValue;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.serviceUrl && this.secret.length >= 32);
  }

  status() {
    return {
      configured: this.configured,
      serviceUrl: this.serviceUrl,
      serverVad: true,
      bargeIn: true,
      streamingTts: true,
    };
  }

  createSession() {
    if (!this.configured) {
      throw new VoiceControlError(
        'voice_transport_not_configured',
        'Voice WebRTC backend is not configured',
        { status: 503 },
      );
    }
    const current = Math.floor(this.now() / 1000);
    const claims = {
      aud: 'voice',
      tenant: this.identity.tenant,
      user: this.identity.user,
      device: this.identity.device,
      exp: current + 45,
      nonce: crypto.randomUUID(),
    };
    return { mode: 'webrtc', ticket: encodeTicket(claims, this.secret) };
  }

  async offer({ ticket, sdp, type = 'offer' }) {
    if (!this.configured) {
      throw new VoiceControlError(
        'voice_transport_not_configured',
        'Voice WebRTC backend is not configured',
        { status: 503 },
      );
    }
    if (typeof ticket !== 'string' || !ticket || typeof sdp !== 'string' || !sdp || sdp.length > 100000) {
      throw new VoiceControlError('invalid_offer', 'ticket and SDP are required', { status: 400 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.serviceUrl}/offer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ticket}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sdp,
          type,
          host_task_bridge: true,
          host_plugin_bridge: false,
        }),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await response.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = null;
      }
      if (!response.ok || !value || typeof value.sdp !== 'string') {
        throw new VoiceControlError(
          'voice_offer_failed',
          value?.detail || value?.error || `Voice backend returned HTTP ${response.status}`,
          { status: response.status === 401 ? 401 : 502 },
        );
      }
      return { type: value.type || 'answer', sdp: value.sdp };
    } catch (error) {
      if (error instanceof VoiceControlError) throw error;
      throw new VoiceControlError(
        'voice_backend_unavailable',
        `Voice backend is unavailable: ${error.message}`,
        { status: 502 },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createVoiceWebRtcTransport(env = process.env) {
  return new VoiceWebRtcTransport({
    serviceUrl: env.VOICE_CENTER_AUDIO_SERVICE_URL || '',
    secret: ticketSecret(env),
    identity: identity(env),
    timeoutMs: Number(env.VOICE_CENTER_AUDIO_TIMEOUT_MS || 20000),
  });
}
