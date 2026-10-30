#!/usr/bin/env node

import readline from 'node:readline';
import { loadControlConfig } from './src/config.mjs';
import { createDirectBackend } from './src/direct-backend.mjs';
import { createControlPlugin } from './src/plugin.mjs';
import { devMode, parseProfile, toolsForProfile } from './src/profiles.mjs';

const VERSION = '0.3.0';
const argv = process.argv.slice(2);
const profile = parseProfile(argv);
const dev = devMode(argv);
const tools = toolsForProfile(profile, { dev });
let initialized = false;
let service;

function output(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  output({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  output({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(id, value) {
  result(id, {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  });
}

function toolError(id, errorValue) {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  result(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

async function getService() {
  if (service) return service;
  const backend = createDirectBackend(loadControlConfig());
  service = createControlPlugin({ backend, profile, dev });
  return service;
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    initialized = true;
    return result(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `bridge-control:${profile}`, version: VERSION },
      instructions: [
        `Loaded internal bridge-control profile: ${profile}.`,
        'This package is designed for a trusted internal host, not ordinary global Codex exposure.',
        'CMB is accessed directly through its public HTTP/SSE API.',
        'Creation and approvals are authorized only by the latest real user transcript recorded by voice-control.',
      ].join(' '),
    });
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'tools/list') {
    if (!initialized) return error(message.id, -32002, 'Server is not initialized');
    return result(message.id, { tools });
  }
  if (message.method === 'tools/call') {
    if (!initialized) return error(message.id, -32002, 'Server is not initialized');
    if (!message.params || typeof message.params.name !== 'string') {
      return error(message.id, -32602, 'Invalid tool call');
    }
    try {
      const control = await getService();
      const value = await control.call(message.params.name, message.params.arguments || {});
      return toolResult(message.id, value);
    } catch (toolFailure) {
      return toolError(message.id, toolFailure);
    }
  }
  if (message.id != null) return error(message.id, -32601, `Unknown method: ${message.method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return error(null, -32700, 'Invalid JSON');
  }
  handle(message).catch((failure) => {
    if (message?.id != null) error(message.id, -32603, failure.message || 'Internal error');
  });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
