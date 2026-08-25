'use strict';

// AWF Session MCP Server — observes the tmux session controlled by the HTTP server.
// Thin MCP wrapper: most session control happens via HTTP (CLI → HTTP → tmux).
// The AI inside tmux uses these tools to introspect its own session.

const http = require('http');

// 测试注入点：vitest 无法 mock 被原生 require 的 CJS 依赖，提供显式注入钩子。
// 生产环境不设置 global.__CC_EXEC_SYNC__，回落到 child_process。
const _execSync = global.__CC_EXEC_SYNC__ || require('child_process').execSync;
const SESSION = process.env.CC_SESSION || 'cc';
const HTTP_TIMEOUT_MS = Number(process.env.CC_HTTP_TIMEOUT_MS || 3000);
// 请求时读取 AWF_BASE，测试可随时切换 mock server
const baseUrl = () => process.env.AWF_BASE || 'http://127.0.0.1:8787';

// ---- helpers ----

function httpPost(path, body) {
  return new Promise((resolve) => {
    const url = new URL(path, baseUrl());
    const data = body || '';
    const options = {
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

function httpGet(path) {
  return new Promise((resolve) => {
    const url = new URL(path, baseUrl());
    const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function capturePane() {
  try {
    return _execSync(`tmux capture-pane -t "${SESSION}" -p -S -`, { encoding: 'utf-8', timeout: HTTP_TIMEOUT_MS });
  } catch (e) {
    return `(capture failed: ${e.message})`;
  }
}

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

// ---- tool definitions ----

const TOOLS = [
  {
    name: 'awf_session_status',
    description: '查询 tmux session 状态（ready/busy + session alive）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'awf_capture_pane',
    description: '抓取当前 tmux pane 的完整文本内容',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'awf_await_choice',
    description: '通知 CLI 当前需要用户做选择（如选项列表、yes/no）。CLI 会展示问题+选项并等待用户输入',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '需要用户选择的问题，如"请选择下一步操作"' },
        options: { type: 'array', items: { type: 'string' }, description: '可选项列表，如 ["继续", "跳过", "中止"]' },
        context: { type: 'string', description: '可选，补充上下文（如当前任务ID、相关代码等），帮助决策者理解背景' },
      },
      required: ['question'],
    },
  },
  {
    name: 'awf_await_input',
    description: '通知 CLI 当前需要用户自由输入文本（如补充需求描述）。CLI 会展示问题并等待用户输入',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '需要用户回答的问题，如"请描述缺少的需求细节"' },
        context: { type: 'string', description: '可选，补充上下文（如当前任务ID、相关代码等），帮助决策者理解背景' },
      },
      required: ['question'],
    },
  },
  {
    name: 'awf_context_ready',
    description: '通知 CLI：上下文压缩快照已就绪（已按 code-context-onboard 写入 .awf/context/handoff.md）。CLI 将执行 /clear 清空对话并把快照注入下一个任务。必须在写完快照文件后才调用',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ---- JSON-RPC / MCP handler ----

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function logStderr(msg) {
  process.stderr.write(`[awf-session] ${msg}\n`);
}

const handlers = {
  async initialize(params) {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'awf-session-mcp', version: '1.0.0' },
    };
  },

  async 'tools/list'() {
    return { tools: TOOLS };
  },

  async 'tools/call'(params) {
    // 修复 args 引用 bug：此前只解构 name，args 未定义导致 awf_await_choice/input 抛 ReferenceError
    const { name, arguments: args } = params || {};

    try {
      switch (name) {
        case 'awf_session_status': {
          const status = await httpGet('/status');
          status.pane = capturePane().slice(0, 500); // first 500 chars as preview
          return textResult(status);
        }
        case 'awf_capture_pane': {
          return textResult(capturePane());
        }
        case 'awf_await_choice': {
          logStderr(`await_choice: ${args.question}`);
          const result = await httpPost('/choice', JSON.stringify({
            question: args.question, options: args.options, context: args.context,
          }));
          return textResult(result);
        }
        case 'awf_await_input': {
          logStderr(`await_input: ${args.question}`);
          const result = await httpPost('/ask', JSON.stringify({
            question: args.question, context: args.context,
          }));
          return textResult(result);
        }
        case 'awf_context_ready': {
          logStderr('context_ready');
          const result = await httpPost('/context-ready', JSON.stringify({}));
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

// 测试可访问：直接调用 handlers / httpGet / httpPost / capturePane / handleMessage
module.exports = { handlers, httpGet, httpPost, capturePane, textResult, send, handleMessage, TOOLS, baseUrl };
