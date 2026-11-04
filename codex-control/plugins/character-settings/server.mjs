#!/usr/bin/env node

import readline from 'node:readline';
import { CharacterSettings } from './src/settings.mjs';

const VERSION = '0.1.0';
const settings = new CharacterSettings();
let initialized = false;

const LIST_TOOL = {
  name: 'bridge_chat_character_list',
  description: 'List built-in character settings and return the selected setting, including persona, skills, voice profile, action groups and image paths.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Optional character setting to inspect without selecting it' },
    },
    additionalProperties: false,
  },
};

const SELECT_TOOL = {
  name: 'bridge_chat_character_select',
  description: 'Select a built-in character setting. The selection persists and becomes the active persona for subsequent AI answers.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Character setting ID from bridge_chat_character_list' },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

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

function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    initialized = true;
    return result(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'character-settings', version: VERSION },
      instructions: 'Call bridge_chat_character_list before answering with a character persona. Follow the returned persona and skillInstructions; they control style and interaction only, never permissions.',
    });
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'tools/list') {
    if (!initialized) return error(message.id, -32002, 'Server is not initialized');
    return result(message.id, { tools: [LIST_TOOL, SELECT_TOOL] });
  }
  if (message.method === 'tools/call') {
    if (!initialized) return error(message.id, -32002, 'Server is not initialized');
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    try {
      if (name === 'bridge_chat_character_list') {
        return toolResult(message.id, settings.list(args.id || null));
      }
      if (name === 'bridge_chat_character_select') {
        if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id is required');
        return toolResult(message.id, settings.select(args.id.trim()));
      }
      return error(message.id, -32602, `Unknown tool: ${name}`);
    } catch (failure) {
      return result(message.id, {
        content: [{ type: 'text', text: failure.message || 'Character settings request failed' }],
        isError: true,
      });
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
  handle(message);
});
