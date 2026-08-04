'use strict';

// AWF OneShot MCP Server — stateless LLM calls via `claude -p`.
// Zero external dependency, stdio transport.

// 测试注入点：vitest 无法 mock 被原生 require 的 CJS 依赖，提供显式注入钩子。
// 生产环境不设置 global.__CC_SPAWN__，回落到 child_process。
const _spawn = global.__CC_SPAWN__ || require('child_process').spawn;

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

// ---- tool definitions ----

const TOOLS = [
  {
    name: 'awf_oneshot',
    description: '调用 claude -p 执行一次性任务，返回 stdout。适合快速查询、代码生成等无状态操作',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '发给 Claude 的 prompt' },
        cwd: { type: 'string', description: '工作目录（可选，默认当前目录）' },
      },
      required: ['prompt'],
    },
  },
];

// ---- helpers ----

function spawnClaude(prompt, cwd) {
  return new Promise((resolve) => {
    const proc = _spawn('claude', ['-p', prompt], {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 300000, // 5 min
    });
    let output = '';
    proc.stdout.on('data', (c) => (output += c.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, text: output.trim() });
      else resolve({ ok: false, error: `claude -p exited ${code}`, text: output.trim() || null });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

// ---- JSON-RPC / MCP handler ----

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function logStderr(msg) {
  process.stderr.write(`[awf-oneshot] ${msg}\n`);
}

const handlers = {
  async initialize(params) {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'awf-oneshot-mcp', version: '1.0.0' },
    };
  },

  async 'tools/list'() {
    return { tools: TOOLS };
  },

  async 'tools/call'(params) {
    const { name, arguments: args } = params || {};

    try {
      switch (name) {
        case 'awf_oneshot': {
          // 显式校验 prompt，避免 undefined.slice 崩溃
          if (!args || typeof args.prompt !== 'string' || !args.prompt.length) {
            return textResult({ ok: false, error: 'prompt is required' });
          }
          logStderr(`oneshot: ${args.prompt.slice(0, 80)}...`);
          const result = await spawnClaude(args.prompt, args.cwd);
          return textResult(result);
        }
        default:
          return textResult({ ok: false, error: `unknown tool: ${name}` });
      }
    } catch (err) {
      return textResult({ ok: false, error: err.message });
    }
  },
};

// ---- main ----

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const idx = buffer.indexOf('\n');
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (e) {
      logStderr(`parse error: ${e.message}`);
    }
  }
});

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      logStderr('client initialized');
    }
    return;
  }

  const handler = handlers[method];
  if (!handler) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    return;
  }

  try {
    const result = await handler(params || {});
    send({ jsonrpc: '2.0', id, result });
  } catch (err) {
    logStderr(`error in ${method}: ${err.message}`);
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

logStderr('started');

// 测试可访问：直接调用 handlers / spawnClaude / handleMessage
module.exports = { handlers, spawnClaude, handleMessage, TOOLS, textResult };
