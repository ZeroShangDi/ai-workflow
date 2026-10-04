'use strict';

// Work management is a Server client. The MCP never writes workflow state or
// accepts/merges an item on behalf of a human.
const http = require('node:http');

const tools = [
  { name: 'awf_work_list_requirements', description: '列出当前项目需求及其业务状态。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'awf_work_create_draft', description: '创建项目需求草稿；一段原始想法即可。不会自动进入待办。', inputSchema: { type: 'object', properties: { title: { type: 'string' }, requestText: { type: 'string' } }, required: ['requestText'], additionalProperties: false } },
  { name: 'awf_work_list_bugs', description: '列出项目 Bug；可按需求过滤。', inputSchema: { type: 'object', properties: { requirementId: { type: 'string' } }, additionalProperties: false } },
  { name: 'awf_work_report_bug', description: '登记 Bug。创建后由人在项目页面决定是否允许闲时处理；需求内 Bug 由当前 Run 的派生任务继续处理。', inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, requirementId: { type: 'string' }, sessionId: { type: 'string' } }, required: ['title'], additionalProperties: false } },
  { name: 'awf_work_submit_requirement', description: 'Run 完成且任务全部完成后，将需求提交人工验收。此工具不能验收或合并。', inputSchema: { type: 'object', properties: { requirementId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['requirementId', 'expectedRevision'], additionalProperties: false } },
  { name: 'awf_work_submit_bug', description: '将已修复 Bug 提交人工验收。此工具不能关闭或合并。', inputSchema: { type: 'object', properties: { bugId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['bugId', 'expectedRevision'], additionalProperties: false } },
  { name: 'awf_work_events', description: '读取需求或 Bug 的操作历史及关闭原因。', inputSchema: { type: 'object', properties: { itemType: { type: 'string', enum: ['requirement', 'bug'] }, itemId: { type: 'string' } }, required: ['itemType', 'itemId'], additionalProperties: false } },
];

function request(method, pathname, body) {
  const projectRoot = process.env.AWF_PROJECT_ROOT || process.env.CC_PROJECT;
  if (!projectRoot) throw new Error('AWF_PROJECT_ROOT / CC_PROJECT 未设置');
  const url = new URL(pathname, process.env.AWF_BASE || 'http://127.0.0.1:8787');
  url.searchParams.set('p', projectRoot);
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, { method, headers: payload ? { 'content-type': 'application/json' } : {} }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const value = JSON.parse(raw);
          if (res.statusCode >= 400 || value.ok === false) reject(new Error(value.error || `HTTP ${res.statusCode}`));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('awf-work 请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function call(name, args = {}) {
  switch (name) {
    case 'awf_work_list_requirements': return request('GET', '/api/persistence/requirements');
    case 'awf_work_create_draft': return request('POST', '/api/persistence/requirements', { ...args, draft: true });
    case 'awf_work_list_bugs': return request('GET', `/api/persistence/bugs${args.requirementId ? `?requirementId=${encodeURIComponent(args.requirementId)}` : ''}`);
    case 'awf_work_report_bug': return request('POST', '/api/persistence/bugs', { ...args, allowAiWork: false });
    case 'awf_work_submit_requirement': return request('POST', `/api/persistence/requirements/${encodeURIComponent(args.requirementId)}/submit`, { expectedRevision: args.expectedRevision, actor: 'agent' });
    case 'awf_work_submit_bug': return request('POST', `/api/persistence/bugs/${encodeURIComponent(args.bugId)}/submit`, { expectedRevision: args.expectedRevision, actor: 'agent' });
    case 'awf_work_events': return request('GET', `/api/persistence/work-events/${encodeURIComponent(args.itemType)}/${encodeURIComponent(args.itemId)}`);
    default: throw new Error(`未知工具：${name}`);
  }
}

async function handle(message) {
  if (message.id === undefined || message.id === null) return;
  let result;
  try {
    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'awf-work', version: '1.0.0' } };
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call') {
      const value = await call(message.params?.name, message.params?.arguments || {});
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } else { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`); return; }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } })}\n`);
  }
}

if (require.main === module) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) { try { void handle(JSON.parse(line)); } catch { /* invalid JSON-RPC frame */ } }
    }
  });
}

module.exports = { tools, call, handle };
