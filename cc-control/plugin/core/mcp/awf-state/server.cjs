'use strict';

// AWF State MCP Server — zero external dependency, stdio transport
// Direct file I/O: reads/writes $PROJECT_ROOT/.awf/state.json
// No longer proxies through the HTTP server — fully standalone.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.AWF_PROJECT_ROOT || process.cwd();
const STATE_PATH = path.join(PROJECT_ROOT, '.awf', 'state.json');
const LOCK_PATH = path.join(PROJECT_ROOT, '.awf', 'state.lock');

// ---- file helpers ----

function readState() {
  const raw = fs.readFileSync(STATE_PATH, 'utf-8');
  return JSON.parse(raw);
}

// state 写锁：CLI 与 MCP 共用 .awf/state.lock。所有 MCP 变更必须把完整的
// read → mutate → write 放在锁内，避免 pause 与任务落账相互覆盖。
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStateLock(fn) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) throw new Error(`state.lock timeout: ${LOCK_PATH}`);
      syncSleep(50);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(LOCK_PATH); } catch {} }
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
    description: '读取工作流状态。不传 taskId → 返回完整 state.json；传 taskId → 只返回该任务完整详情（含 status/exec/commits）。判断任务状态或 exec 时用 taskId 单查，避免全量读取',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID，如 T1。传了则只返回该任务详情' },
      },
      required: [],
    },
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
    name: 'awf_task_complete',
    description: '原子完成一个任务：一次提交 status + result + files + commits（替代多次 awf_task_status/result/commit 调用，避免落账中间态）。status 缺省 done',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID' },
        status: { type: 'string', enum: ['done', 'blocked'], description: '最终状态（默认 done）' },
        result: { type: 'string', description: '执行结果描述（exec.result）' },
        files: { type: 'array', items: { type: 'string' }, description: '产出文件路径列表（exec.files）' },
        verdict: { type: 'object', description: '门禁判定结果（写进 exec.verdict，如 { level: "pass|changes_requested|fail", conclusion: "..." }）' },
        commits: { type: 'array', items: { type: 'object', properties: { hash: { type: 'string' }, message: { type: 'string' } }, required: ['hash', 'message'] }, description: 'commit 记录列表' },
        blockedReason: { type: 'string', description: 'status=blocked 时的原因说明' },
      },
      required: ['id'],
    },
  },
  {
    name: 'awf_task_create',
    description: '创建新任务',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID（唯一）' },
        title: { type: 'string', description: '任务名（一句话）' },
        kind: { type: 'string', enum: ['dev', 'debug', 'review', 'test', 'doc', 'commit', 'ui-design', 'ui-code'], description: '任务类型（默认 dev），用于选择对应自定义命令；review/test/doc 为门禁类型' },
        plannedFiles: { type: 'array', items: { type: 'string' }, description: '规划改动文件（相对路径；多 agent 并行按此做冲突过滤，缺失则保守串行）' },
        constraints: { type: 'array', items: { type: 'string' }, description: '任务专属硬约束列表；通用执行规则不应重复写入' },
        prompt: { type: 'string', description: '精简执行提示词（命令 + task ID + 具体要做什么）；不得复制其他结构化字段' },
        wbsRef: { type: 'string', description: '关联的 WBS ID' },
        deps: { type: 'array', items: { type: 'string' }, description: '依赖任务 ID 列表' },
        acceptance: { type: 'string', description: '可验证的完成条件' },
      },
      required: ['id', 'title', 'prompt'],
    },
  },
  {
    name: 'awf_task_update',
    description: '更新任务字段（只更新提供的字段）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID' },
        title: { type: 'string', description: '新的任务名' },
        kind: { type: 'string', enum: ['dev', 'debug', 'review', 'test', 'doc', 'commit', 'ui-design', 'ui-code'], description: '新的任务类型' },
        plannedFiles: { type: 'array', items: { type: 'string' }, description: '新的规划改动文件列表' },
        constraints: { type: 'array', items: { type: 'string' }, description: '新的任务专属硬约束列表' },
        prompt: { type: 'string', description: '新的执行提示词' },
        wbsRef: { type: 'string', description: '新的 WBS 引用' },
        deps: { type: 'array', items: { type: 'string' }, description: '新的依赖列表' },
        acceptance: { type: 'string', description: '新的完成条件' },
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
    name: 'awf_mode',
    description: '设置工作流运行模式。可选: idle | plan | run | pause。pause 会让 CLI 停止派发和收尾，恢复为 run 后自动继续',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['idle', 'plan', 'run', 'pause'], description: '运行模式' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'awf_version',
    description: '更新 state.json 版本号',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: '新版本号，如 0.1.4' },
      },
      required: ['version'],
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
  {
    name: 'awf_milestone_delete',
    description: '删除里程碑',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的里程碑 ID' },
      },
      required: ['id'],
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
        const s = readState();
        if (args?.taskId) {
          const t = (s.tasks || []).find((x) => x.id == args.taskId);
          if (!t) return textResult({ ok: false, error: `task ${args.taskId} not found` });
          return textResult(t);
        }
        return textResult(s);
      }

      // all other tools: lock 内完成 read → mutate → write
      return withStateLock(() => {
      const s = readState();

      // tasks live at root ("s.tasks")
      function getTasks() {
        return Array.isArray(s.tasks) ? s.tasks : [];
      }
      function ensureTasks() {
        if (!Array.isArray(s.tasks)) s.tasks = [];
        return s.tasks;
      }
      const tasks = getTasks();
      const milestones = s.milestones || [];

      switch (name) {
        case 'awf_task_status': {
          const t = tasks.find(t => t.id == args.id);
          if (!t) return textResult({ ok: false, error: `task ${args.id} not found` });
          const previousStatus = t.status;
          t.status = args.status;
          t.exec = t.exec || {};
          if (args.status === 'active') {
            if (previousStatus !== 'active' || !t.exec.startedAt) {
              t.exec.startedAt = new Date().toISOString();
              delete t.exec.completedAt;
            }
          } else if (args.status === 'done' || args.status === 'blocked') {
            t.exec.completedAt = new Date().toISOString();
          } else if (args.status === 'pending') {
            delete t.exec.startedAt;
            delete t.exec.completedAt;
          }
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
        case 'awf_task_complete': {
          const t = tasks.find(t => t.id == args.id);
          if (!t) return textResult({ ok: false, error: `task ${args.id} not found` });
          const status = args.status || 'done';
          if (status !== 'done' && status !== 'blocked') {
            return textResult({ ok: false, error: `status must be done|blocked, got ${status}` });
          }
          if (!t.exec) t.exec = {};
          if (args.result !== undefined) t.exec.result = args.result;
          if (args.files) t.exec.files = args.files;
          if (args.verdict !== undefined) t.exec.verdict = args.verdict;
          if (args.commits) {
            if (!t.commits) t.commits = [];
            t.commits.push(...args.commits);
          }
          if (status === 'blocked') {
            t.blockedReason = args.blockedReason;
          } else {
            delete t.blockedReason;
          }
          t.status = status;
          t.exec.completedAt = new Date().toISOString();
          break;
        }
        case 'awf_task_create': {
          const taskList = ensureTasks();
          if (taskList.find(t => t.id == args.id)) {
            return textResult({ ok: false, error: `task ${args.id} already exists` });
          }
          taskList.push({
            id: args.id, title: args.title, kind: args.kind || 'dev', prompt: args.prompt,
            wbsRef: args.wbsRef, deps: args.deps || [], status: 'pending',
            plannedFiles: args.plannedFiles || [],
            constraints: args.constraints || [],
            acceptance: args.acceptance,
          });
          break;
        }
        case 'awf_task_update': {
          const t = tasks.find(t => t.id == args.id);
          if (!t) return textResult({ ok: false, error: `task ${args.id} not found` });
          if (args.title !== undefined) t.title = args.title;
          if (args.kind !== undefined) t.kind = args.kind;
          if (args.plannedFiles !== undefined) t.plannedFiles = args.plannedFiles;
          if (args.constraints !== undefined) t.constraints = args.constraints;
          if (args.prompt !== undefined) t.prompt = args.prompt;
          if (args.wbsRef !== undefined) t.wbsRef = args.wbsRef;
          if (args.deps !== undefined) t.deps = args.deps;
          if (args.acceptance !== undefined) t.acceptance = args.acceptance;
          break;
        }
        case 'awf_task_delete': {
          const idx = tasks.findIndex(t => t.id == args.id);
          if (idx === -1) {
            return textResult({ ok: false, error: `task ${args.id} not found` });
          }
          tasks.splice(idx, 1);
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
          if (!Array.isArray(s.wbs)) s.wbs = [];
          if (s.wbs.find(w => w.id == args.id)) {
            return textResult({ ok: false, error: `wbs ${args.id} already exists` });
          }
          s.wbs.push({
            id: args.id, name: args.name, desc: args.desc,
            acceptance: args.acceptance, deps: args.deps || [],
          });
          break;
        }
        case 'awf_wbs_update': {
          const w = s.wbs?.find(w => w.id == args.id);
          if (!w) return textResult({ ok: false, error: `wbs ${args.id} not found` });
          if (args.name !== undefined) w.name = args.name;
          if (args.desc !== undefined) w.desc = args.desc;
          if (args.acceptance !== undefined) w.acceptance = args.acceptance;
          if (args.deps !== undefined) w.deps = args.deps;
          break;
        }
        case 'awf_wbs_delete': {
          const idx = s.wbs?.findIndex(w => w.id == args.id);
          if (idx === undefined || idx === -1) {
            return textResult({ ok: false, error: `wbs ${args.id} not found` });
          }
          s.wbs.splice(idx, 1);
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
        case 'awf_mode': {
          s.mode = args.mode;
          break;
        }
        case 'awf_version': {
          s.version = args.version;
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
        case 'awf_milestone_delete': {
          const idx = s.milestones?.findIndex(m => m.id == args.id);
          if (idx === undefined || idx === -1) {
            return textResult({ ok: false, error: `milestone ${args.id} not found` });
          }
          s.milestones.splice(idx, 1);
          break;
        }
        default:
          return textResult({ ok: false, error: `unknown tool: ${name}` });
      }

      writeState(s);
      logStderr(`${name} ${args.id || args.phase || ''} -> ok`);
      return textResult({ ok: true, tool: name });
      });
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
