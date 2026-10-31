#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';

import { loadIntegrationConfig } from './src/integration-config.mjs';

function argumentsFrom(argv) {
  const result = {
    configPath: '',
    profile: 'voice-controller',
    tool: '',
    args: '{}',
    threadId: process.env.CODEX_THREAD_ID || '',
    timeoutMs: 120000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || value === undefined) throw new Error(`Invalid argument: ${key}`);
    if (key === '--config') result.configPath = value;
    else if (key === '--profile') result.profile = value;
    else if (key === '--tool') result.tool = value;
    else if (key === '--args') result.args = value;
    else if (key === '--thread-id') result.threadId = value;
    else if (key === '--timeout-ms') result.timeoutMs = Number(value);
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  if (!result.configPath || !result.tool || !result.threadId) {
    throw new Error('--config, --tool and a CODEX_THREAD_ID or --thread-id are required');
  }
  return result;
}

function waitFor(socket, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close(4001, 'tool call timeout');
      reject(new Error('Control tool call timed out'));
    }, timeoutMs);
    timer.unref?.();
    const listener = async (event) => {
      let message;
      try {
        const raw = typeof event.data === 'string'
          ? event.data
          : (event.data instanceof Blob ? await event.data.text() : String(event.data));
        message = JSON.parse(raw);
      } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', listener);
      resolve(message);
    };
    socket.addEventListener('message', listener);
  });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const config = loadIntegrationConfig(options.configPath);
  const url = config.plugins.control.websocketUrl;
  const tokenFile = config.plugins.control.tokenFile;
  if (!url || !tokenFile) throw new Error('Control WebSocket URL or token file is not configured');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  let parsedArgs;
  try { parsedArgs = JSON.parse(options.args); } catch { throw new Error('--args must be valid JSON'); }
  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
    throw new Error('--args must be a JSON object');
  }

  const socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Control WebSocket connection failed')), { once: true });
    });
    socket.send(JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      client: { id: 'bridge-control-cli', version: '0.3.0' },
      token,
      cursor: '0',
    }));
    await waitFor(socket, (message) => message.type === 'hello.ack', 5000);
    socket.send(JSON.stringify({ type: 'subscribe', topics: ['control.tool.call.*', 'control.error'] }));
    await waitFor(socket, (message) => message.type === 'replay.complete', 5000);

    const correlationId = `req_${crypto.randomUUID()}`;
    socket.send(JSON.stringify({
      type: 'event',
      event: {
        schemaVersion: 1,
        eventId: `evt_${crypto.randomUUID()}`,
        correlationId,
        topic: 'control.tool.call.requested',
        source: 'bridge-control-cli',
        createdAt: new Date().toISOString(),
        payload: {
          profile: options.profile,
          tool: options.tool,
          threadId: options.threadId,
          arguments: parsedArgs,
        },
      },
    }));
    const response = await waitFor(socket, (message) => (
      message.type === 'event'
      && message.event?.correlationId === correlationId
      && ['control.tool.call.completed', 'control.tool.call.failed', 'control.error'].includes(message.event.topic)
    ), options.timeoutMs);
    const event = response.event;
    if (event.topic !== 'control.tool.call.completed') {
      const error = new Error(event.payload?.message || event.payload?.result?.message || 'Control tool call failed');
      error.code = event.payload?.code || 'control_tool_failed';
      throw error;
    }
    process.stdout.write(`${JSON.stringify(event.payload.result)}\n`);
  } finally {
    socket.close(1000, 'done');
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: { code: error.code || 'control_cli_failed', message: error.message },
  })}\n`);
  process.exitCode = 1;
});
