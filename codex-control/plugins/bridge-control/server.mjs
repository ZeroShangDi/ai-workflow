#!/usr/bin/env node

import readline from 'node:readline';
import { loadConfig, publicConfig, saveConfig } from './src/config.mjs';
import { adapterFor, adapterNames } from './src/adapters/index.mjs';

const VERSION = '0.1.0';
let initialized = false;

const TOOLS = [
  {
    name: 'bridge_status',
    description: 'Check the configured bridge software, authentication state, and computer identity.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_configure',
    description: 'Configure the bridge adapter without accepting a plaintext password. Use a password file or environment variable.',
    inputSchema: {
      type: 'object',
      properties: {
        software: { type: 'string', enum: adapterNames() },
        baseUrl: { type: 'string', description: 'HTTP(S) origin, for example http://127.0.0.1:18787' },
        username: { type: 'string' },
        passwordEnv: { type: 'string', description: 'Environment variable holding the password' },
        passwordFile: { type: 'string', description: 'Absolute path to a local password file' },
        defaultProject: { type: 'string', description: 'Project ID, name, or path used for new test chats' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_projects',
    description: 'List projects exposed by the configured bridge.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_sessions',
    description: 'List recent conversations exposed by the configured bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bridge_chat',
    description: 'Send a message through the configured bridge, observe its event stream, and return the completed reply.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Existing bridge conversation UUID; omit to create a test chat' },
        project: { type: 'string', description: 'Project ID, name, or path when creating a chat' },
        title: { type: 'string', description: 'Title when creating a chat' },
        text: { type: 'string', minLength: 1, maxLength: 100000 },
        timeoutMs: { type: 'integer', minimum: 5000, maximum: 600000 },
      },
      required: ['text'],
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

function toolError(id, errorValue) {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  result(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function progress(token, value, message) {
  if (token == null) return;
  output({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken: token,
      progress: value,
      total: 100,
      message,
    },
  });
}

async function callTool(name, args, requestId, progressToken) {
  if (name === 'bridge_configure') {
    if (args.software && !adapterNames().includes(args.software)) {
      throw new Error(`Unsupported bridge software: ${args.software}`);
    }
    const saved = saveConfig(args);
    return { ...saved, adapters: adapterNames() };
  }
  if (name === 'bridge_status') {
    const config = loadConfig();
    const adapter = adapterFor(config);
    return {
      config: publicConfig(config),
      status: await adapter.status(),
      adapters: adapterNames(),
    };
  }
  if (name === 'bridge_projects') {
    return { projects: await adapterFor(loadConfig()).projects() };
  }
  if (name === 'bridge_sessions') {
    return adapterFor(loadConfig()).sessions(args);
  }
  if (name === 'bridge_chat') {
    progress(progressToken, 1, 'Preparing bridge adapter');
    const adapter = adapterFor(loadConfig());
    const reply = await adapter.chat({
      ...args,
      onProgress: ({ progress: value, message }) => progress(progressToken, value, message),
    });
    progress(progressToken, 100, 'Bridge reply completed');
    return reply;
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    initialized = true;
    return result(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'bridge-control', version: VERSION },
      instructions: 'Use bridge_status before bridge_chat. bridge_chat sends through the configured external bridge and waits for the completed streamed reply.',
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
    if (!message.params || typeof message.params.name !== 'string') {
      return error(message.id, -32602, 'Invalid tool call');
    }
    try {
      const value = await callTool(
        message.params.name,
        message.params.arguments || {},
        message.id,
        message.params._meta?.progressToken,
      );
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
