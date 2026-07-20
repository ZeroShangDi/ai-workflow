'use strict';

// AWF State MCP Server — zero external dependency, stdio transport
// Direct file I/O: reads/writes $PROJECT_ROOT/.awf/state.json
// No longer proxies through the HTTP server — fully standalone.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.AWF_PROJECT_ROOT || process.cwd();
const STATE_PATH = path.join(PROJECT_ROOT, '.awf', 'state.json');

// ---- file helpers ----

function readState() {
  const raw = fs.readFileSync(STATE_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeState(s) {
  s.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// ---- tool definitions ----

const TOOLS = [
  {
    name: 'awf_read_state',
    description: '读取当前工作流的完整 state.json（任务列表、里程碑、WBS、阶段等）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'awf_task_status',
    description: '更新任务状态。status 可选: pending | active | done | blocked',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID，如 T1, T2' },
        status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked'], description: '任务状态' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'awf_task_result',
    description: '记录任务执行结果和产出文件列表',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID' },
        result: { type: 'string', description: '执行结果描述' },
        files: { type: 'array', items: { type: 'string' }, description: '产出文件路径列表' },
      },
      required: ['id'],
    },
  },
  {
    name: 'awf_task_commit',
    description: '追加 commit 记录到任务',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID' },
        hash: { type: 'string', description: 'git commit hash' },
        message: { type: 'string', description: 'commit message' },
      },
      required: ['id', 'hash', 'message'],
    },
  },
  {
    name: 'awf_task_create',
    description: '创建新任务',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID（唯一）' },
        desc: { type: 'string', description: '任务描述' },
        prompt: { type: 'string', description: '开发 prompt' },
        wbsRef: { type: 'string', description: '关联的 WBS ID' },
        deps: { type: 'array', items: { type: 'string' }, description: '依赖任务 ID 列表' },
      },
      required: ['id', 'desc', 'prompt'],
    },
  },
  {
    name: 'awf_task_update',
    description: '更新任务字段（只更新提供的字段）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID' },
        desc: { type: 'string', description: '新的任务描述' },
        prompt: { type: 'string', description: '新的开发 prompt' },
        wbsRef: { type: 'string', description: '新的 WBS 引用' },
        deps: { type: 'array', items: { type: 'string' }, description: '新的依赖列表' },
      },
      required: ['id'],
    },
  },
  {
    name: 'awf_task_delete',
    description: '删除任务',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的任务 ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'awf_plan_configure',
    description: '配置 Plan 元数据（summary, reqDoc, hasUI, scope, acceptance criteria）',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '项目摘要' },
        reqDoc: { type: 'string', description: '需求文档路径' },
        hasUI: { type: 'boolean', description: '是否有 UI' },
        inScope: { type: 'array', items: { type: 'string' }, description: '范围内事项' },
        outOfScope: { type: 'array', items: { type: 'string' }, description: '范围外事项' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: '验收标准' },
      },
      required: [],
    },
  },
  {
    name: 'awf_wbs_create',
    description: '创建 WBS 工作分解项',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'WBS ID' },
        name: { type: 'string', description: 'WBS 名称' },
        desc: { type: 'string', description: 'WBS 描述' },
        acceptance: { type: 'string', description: '验收标准' },
        deps: { type: 'array', items: { type: 'string' }, description: '依赖的 WBS ID' },
      },
      required: ['id', 'name'],
    },
  },
  {
    name: 'awf_wbs_update',
    description: '更新 WBS 项',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'WBS ID' },
        name: { type: 'string', description: '新的名称' },
        desc: { type: 'string', description: '新的描述' },
        acceptance: { type: 'string', description: '新的验收标准' },
        deps: { type: 'array', items: { type: 'string' }, description: '新的依赖列表' },
      },
      required: ['id'],
    },
  },
  {
    name: 'awf_wbs_delete',
    description: '删除 WBS 项',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的 WBS ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'awf_phase',
    description: '设置当前工作流阶段。可选: IDLE | PLAN | DESIGN | CODE | REVIEW | TEST | COMMIT | FINISH | DEBUG',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', description: '阶段名称，如 CODE, REVIEW, FINISH 等' },
      },
      required: ['phase'],
    },
  },
  {
    name: 'awf_milestone_update',
    description: '更新里程碑状态。status 可选: active | done',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '里程碑 ID，如 M1' },
        status: { type: 'string', enum: ['active', 'done'], description: '里程碑状态' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'awf_milestone_create',
    description: '创建新里程碑',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '里程碑 ID' },
        desc: { type: 'string', description: '里程碑描述' },
        status: { type: 'string', description: '初始状态，默认 active' },
        tasks: { type: 'array', items: { type: 'string' }, description: '关联的任务 ID 列表' },
      },
      required: ['id', 'desc'],
    },
  },
];

// ---- JSON-RPC / MCP handler ----

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function logStderr(msg) {
  process.stderr.write(`[awf-state] ${msg}\n`);
}

const handlers = {
  async initialize(params) {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'awf-state-mcp', version: '1.0.0' },
    };
  },

  async 'tools/list'() {
    return { tools: TOOLS };
  },

  async 'tools/call'(params) {
    const { name, arguments: args } = params || {};

    try {
      // special: read-only
      if (name === 'awf_read_state') {
        return textResult(readState());
      }

      // all other tools: read → mutate → write
      const s = readState();
      const tasks = s.plan?.tasks || [];
      const milestones = s.milestones || [];

      switch (name) {
        case 'awf_task_status': {
          const t = tasks.find(t => t.id == args.id);
          if (!t) return textResult({ ok: false, error: `task ${args.id} not found` });
          t.status = args.status;
          break;
        }
        case 'awf_task_result': {
          const t = tasks.find(t => t.id == args.id);
          if (!t) return textResult({ ok: false, error: `task ${args.id} not found` });
          if (!t.exec) t.exec = {};
          if (args.result !== undefined) t.exec.result = args.result;
          if (args.files) t.exec.files = args.files;
          break;
        }
        case 'awf_task_commit': {
          const t = tasks.find(t => t.id == args.id);
          if (!t) return textResult({ ok: false, error: `task ${args.id} not found` });
          if (!t.commits) t.commits = [];
          t.commits.push({ hash: args.hash, message: args.message });
          break;
        }
        case 'awf_task_create': {
          if (!s.plan) s.plan = {};
          if (!s.plan.tasks) s.plan.tasks = [];
          if (s.plan.tasks.find(t => t.id == args.id)) {
            return textResult({ ok: false, error: `task ${args.id} already exists` });
          }
          s.plan.tasks.push({
            id: args.id, desc: args.desc, prompt: args.prompt,
            wbsRef: args.wbsRef, deps: args.deps || [], status: 'pending',
          });
          break;
        }
        case 'awf_task_update': {
          const t = tasks.find(t => t.id == args.id);
          if (!t) return textResult({ ok: false, error: `task ${args.id} not found` });
          if (args.desc !== undefined) t.desc = args.desc;
          if (args.prompt !== undefined) t.prompt = args.prompt;
          if (args.wbsRef !== undefined) t.wbsRef = args.wbsRef;
          if (args.deps !== undefined) t.deps = args.deps;
          break;
        }
        case 'awf_task_delete': {
          const idx = s.plan?.tasks?.findIndex(t => t.id == args.id);
          if (idx === undefined || idx === -1) {
            return textResult({ ok: false, error: `task ${args.id} not found` });
          }
          s.plan.tasks.splice(idx, 1);
          break;
        }
        case 'awf_plan_configure': {
          if (!s.plan) s.plan = {};
          if (args.summary !== undefined) s.plan.summary = args.summary;
          if (args.reqDoc !== undefined) s.plan.reqDoc = args.reqDoc;
          if (args.hasUI !== undefined) s.plan.hasUI = args.hasUI;
          if (args.inScope !== undefined) s.plan.inScope = args.inScope;
          if (args.outOfScope !== undefined) s.plan.outOfScope = args.outOfScope;
          if (args.acceptanceCriteria !== undefined) s.plan.acceptanceCriteria = args.acceptanceCriteria;
          break;
        }
        case 'awf_wbs_create': {
          if (!s.plan) s.plan = {};
          if (!s.plan.wbs) s.plan.wbs = [];
          if (s.plan.wbs.find(w => w.id == args.id)) {
            return textResult({ ok: false, error: `wbs ${args.id} already exists` });
          }
          s.plan.wbs.push({
            id: args.id, name: args.name, desc: args.desc,
            acceptance: args.acceptance, deps: args.deps || [],
          });
          break;
        }
        case 'awf_wbs_update': {
          const w = s.plan?.wbs?.find(w => w.id == args.id);
          if (!w) return textResult({ ok: false, error: `wbs ${args.id} not found` });
          if (args.name !== undefined) w.name = args.name;
          if (args.desc !== undefined) w.desc = args.desc;
          if (args.acceptance !== undefined) w.acceptance = args.acceptance;
          if (args.deps !== undefined) w.deps = args.deps;
          break;
        }
        case 'awf_wbs_delete': {
          const idx = s.plan?.wbs?.findIndex(w => w.id == args.id);
          if (idx === undefined || idx === -1) {
            return textResult({ ok: false, error: `wbs ${args.id} not found` });
          }
          s.plan.wbs.splice(idx, 1);
          break;
        }
        case 'awf_phase': {
          s.currentState = args.phase;
          break;
        }
        case 'awf_milestone_update': {
          const m = milestones.find(m => m.id == args.id);
          if (!m) return textResult({ ok: false, error: `milestone ${args.id} not found` });
          m.status = args.status;
          break;
        }
        case 'awf_milestone_create': {
          if (!s.milestones) s.milestones = [];
          if (s.milestones.find(m => m.id == args.id)) {
            return textResult({ ok: false, error: `milestone ${args.id} already exists` });
          }
          s.milestones.push({
            id: args.id, desc: args.desc,
            status: args.status || 'active', tasks: args.tasks || [],
          });
          break;
        }
        default:
          return textResult({ ok: false, error: `unknown tool: ${name}` });
      }

      writeState(s);
      logStderr(`${name} ${args.id || args.phase || ''} -> ok`);
      return textResult({ ok: true, tool: name });
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
