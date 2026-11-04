import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeTicket, VoiceWebRtcTransport } from '../src/webrtc.mjs';

test('issues a short-lived voice ticket and proxies the SDP offer', async () => {
  const calls = [];
  const transport = new VoiceWebRtcTransport({
    serviceUrl: 'http://voice.test',
    secret: 'x'.repeat(64),
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ type: 'answer', sdp: 'answer-sdp' });
    },
  });
  const session = transport.createSession();
  const claims = JSON.parse(Buffer.from(session.ticket.split('.')[0], 'base64url'));
  assert.equal(session.mode, 'webrtc');
  assert.equal(claims.aud, 'voice');
  assert.equal(claims.exp, 1_700_000_045);
  assert.equal(session.ticket, encodeTicket(claims, 'x'.repeat(64)));

  const answer = await transport.offer({ ticket: session.ticket, sdp: 'offer-sdp' });
  assert.deepEqual(answer, { type: 'answer', sdp: 'answer-sdp' });
  assert.equal(calls[0].url, 'http://voice.test/offer');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${session.ticket}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.host_task_bridge, true);
  assert.equal(body.host_plugin_bridge, false);
});
