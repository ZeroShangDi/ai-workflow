#!/usr/bin/env node

import readline from 'node:readline';
import path from 'node:path';
import { loadIntegrationConfig, updateIntegrationConfig } from './src/integration-config.mjs';

const VERSION = '0.3.0';
let initialized = false;
let loadedConfig = null;

const TOOLS = [
  {
    name: 'bridge_chat_voice_config_load',
    description: 'Load and validate the Voice Control integration configuration from an absolute file path.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string', description: 'Absolute path to the integration JSON file' },
      },
      required: ['configPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat_voice_config_update',
    description: 'Atomically update the loaded integration configuration workspace fields.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string', description: 'Absolute path to the loaded integration JSON file' },
        workspace: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            projectKey: { type: 'string' },
            voiceSessionId: { type: 'string' },
            voiceSessionTitle: { type: 'string' },
            initialized: { type: 'boolean' },
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ['configPath', 'workspace'],
      additionalProperties: false,
    },
  },
];

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
      serverInfo: { name: 'voice-control-integration', version: VERSION },
      instructions: 'Load the Voice integration config before starting a managed voice session.',
    });
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'tools/list') {
    if (!initialized) return error(message.id, -32002, 'Server is not initialized');
    return result(message.id, { tools: TOOLS });
  }
  if (message.method === 'tools/call') {
    if (!initialized) return error(message.id, -32002, 'Server is not initialized');
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    try {
      if (name === 'bridge_chat_voice_config_load') {
        const config = loadIntegrationConfig(args.configPath);
        loadedConfig = config;
        return toolResult(message.id, { status: 'loaded', ...config, loadedConfigPath: loadedConfig.configPath });
      }
      if (name === 'bridge_chat_voice_config_update') {
        if (!loadedConfig) throw new Error('load the integration config before updating it');
        if (typeof args.configPath !== 'string' || path.resolve(args.configPath) !== loadedConfig.configPath) {
          throw new Error('configPath must match the loaded integration config');
        }
        const result = updateIntegrationConfig(args.configPath, { workspace: args.workspace });
        loadedConfig = result.current;
        return toolResult(message.id, {
          status: 'updated',
          configPath: loadedConfig.configPath,
          workspace: { ...loadedConfig.workspace },
        });
      }
      return error(message.id, -32602, `Unknown tool: ${name}`);
    } catch (failure) {
      return result(message.id, {
        content: [{ type: 'text', text: failure.message || 'Voice config load failed' }],
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
