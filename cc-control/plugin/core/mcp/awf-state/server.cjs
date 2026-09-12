'use strict';

// AWF State MCP Server — zero external dependency, stdio transport
// Direct file I/O: reads/writes $PROJECT_ROOT/.awf/state.json
// No longer proxies through the HTTP server — fully standalone.

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const PROJECT_ROOT = process.env.AWF_PROJECT_ROOT || process.cwd();
const STATE_PATH = path.join(PROJECT_ROOT, '.awf', 'state.json');
const LOCK_PATH = path.join(PROJECT_ROOT, '.awf', 'state.lock');

// ---- file helpers ----
// 持久化优先走 store-core（src/lib，单写序列化 + 原子写，与 CLI/server 同一实现）。
// 该 server 的可用路径总是包根之上的副本（自托管/跨项目 .mcp.json 绝对路径），
// 故 require 相对包根可达；仅当运行在无 src/ 的纯插件副本（connect-only、不暴露工具）
// 时才回退到本地同语义最小实现——真实工具面永远走 store-core。
let storeCore = null;
let taskGraph = null;
try {
  storeCore = require(path.join(__dirname, '..', '..', '..', '..', 'src', 'lib', 'store-core.cjs'));
} catch {
  storeCore = null;
}
try {
  taskGraph = require(path.join(__dirname, '..', '..', '..', '..', 'src', 'lib', 'task-graph.cjs'));
} catch {
  taskGraph = null;
}

function readState() {
  if (storeCore) {
    const s = storeCore.readJsonSync(STATE_PATH);
    if (!s) {
      const err = new Error(`ENOENT: state file missing at ${STATE_PATH}`);
      err.code = 'ENOENT';
      throw err;
    }
    return s;
  }
  const raw = fs.readFileSync(STATE_PATH, 'utf-8');
  return JSON.parse(raw);
}

// state 写锁：CLI 与 MCP 共用 .awf/state.lock。所有 MCP 变更必须把完整的
// read → mutate → write 放在锁内，避免 pause 与任务落账相互覆盖。
function withStateLock(fn) {
  if (storeCore) return storeCore.withFileLock(LOCK_PATH, fn);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) throw new Error(`state.lock timeout: ${LOCK_PATH}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(LOCK_PATH); } catch {} }
}

function writeState(s) {
  s.lastUpdated = new Date().toISOString();
  if (storeCore) storeCore.writeJsonAtomicSync(STATE_PATH, s);
  else fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// ---- T1-077：server run api 单写者模式（env CC_AWF_STATE_SERVER=1 启用）----
// 基础 CRUD 语义仍由本 MCP 判定/mutate；仅读/写边界经 server：读 GET /awf/state、写 POST
// /run/state/apply（server 以 state.js 锁 + 原子落盘，MCP 不再直写文件/自持锁）。缺省关 →
// 离线/plan/单测沿用直写文件（现状不变）。
const http = require('node:http');
const SERVER_MODE = process.env.CC_AWF_STATE_SERVER === '1';
const SERVER_PORT = Number(process.env.CC_PORT || 8787);
// T1-078：MCP 只碰本 sid run（软约束）——带上自身 CC_SID，server 按 sid 分片 state。
// 单 server 多项目：本项目根（bootstrap env CC_PROJECT / .mcp env AWF_PROJECT_ROOT）
const PROJ_ROOT = process.env.AWF_PROJECT_ROOT || process.env.CC_PROJECT || '';
/** server 请求 query：sid(命中本 run 槽) + p(多项目路由到本项目)；无则空串 */
function stateQuery() {
  const parts = [];
  if (process.env.CC_SID) parts.push(`sid=${encodeURIComponent(String(process.env.CC_SID))}`);
  if (PROJ_ROOT) parts.push(`p=${encodeURIComponent(PROJ_ROOT)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function httpJson(method, pathname, obj) {
  return new Promise((resolve) => {
    const data = obj ? JSON.stringify(obj) : '';
    const req = http.request({
      host: '127.0.0.1', port: SERVER_PORT, path: pathname, method,
      headers: { 'content-type': 'application/json' },
    }, (r) => {
      let raw = '';
      // 必须显式 utf8：不设编码时 data 给的是 Buffer，逐块 `raw += Buffer` 会对每个 chunk 单独
      // toString —— 多字节字符跨 chunk 边界即被切成 U+FFFD。state.json 从几十 KB 长到几百 KB 后，
      // 读取结果必然与磁盘指纹不一致，SERVER_MODE 下每次写都被 CAS 判为冲突（409）。见 .awf/bugs/。
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; });
      r.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    if (obj) req.write(data);
    req.end();
  });
}
async function readStateServer() {
  const s = await httpJson('GET', `/awf/state${stateQuery()}`);
  if (s && typeof s === 'object' && 'tasks' in s) return s;
  throw new Error(`awf-state server 读取失败（port ${SERVER_PORT} /awf/state）`);
}

async function dynamicPlanServer(args) {
  const r = await httpJson('POST', `/run/dynamic-planning/proposals${stateQuery()}`, args);
  if (!r) throw new Error('dynamic planning server 无响应');
  return r;
}

async function dynamicPlanStatusServer(proposalId) {
  const suffix = `${stateQuery()}${stateQuery() ? '&' : '?'}proposalId=${encodeURIComponent(proposalId)}`;
  const r = await httpJson('GET', `/awf/dynamic-planning/proposals${suffix}`);
  if (!r) throw new Error('dynamic planning server 无响应');
  return r;
}
function stateFingerprint(s) {
  return crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex');
}

async function writeStateServer(s, expectedLastUpdated, expectedStateFingerprint) {
  const r = await httpJson('POST', `/run/state/apply${stateQuery()}`, {
    state: s,
    expectedLastUpdated: expectedLastUpdated ?? null,
    expectedStateFingerprint,
  });
  if (!r || r.ok !== true) {
    throw new Error(r?.error || 'awf-state server 落盘失败（/run/state/apply）');
  }
}

function resultFailed(result) {
  try {
    const payload = JSON.parse(result?.content?.[0]?.text || '{}');
    return payload?.ok === false;
  } catch {
    return false;
  }
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
    name: 'awf_dynamic_plan',
    description: '运行期动态任务规划：提交一次语义化任务调整，由 server 计算插入位置、依赖/milestone/ready 副作用并按项目设置自动应用或等待人工批准。禁止用裸 task CRUD 代替本工具',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么原计划需要局部调整；必须说明缺口与原目标的关系' },
        trigger: { type: 'string', description: '触发来源，默认 ai_runtime' },
        requestedBy: { type: 'string', description: '请求者标识，默认 ai' },
        operations: {
          type: 'array',
          minItems: 1,
          description: '原子变更集；支持 insert_task/edit_task/delete_task',
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  type: { const: 'insert_task' },
                  relation: {
                    type: 'object',
                    properties: {
                      type: { const: 'prerequisite_for' },
                      targetTaskId: { type: 'string', description: '缺少该前置工作的目标任务' },
                    },
                    required: ['type', 'targetTaskId'],
                  },
                  task: {
                    type: 'object',
                    description: '新增任务；wbsRef/deps 缺省时从目标任务继承，位置由 server 决定',
                    properties: {
                      id: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' },
                      prompt: { type: 'string' }, acceptance: { type: 'string' }, wbsRef: { type: 'string' },
                      deps: { type: 'array', items: { type: 'string' } },
                      plannedFiles: { type: 'array', items: { type: 'string' } },
                      constraints: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['id', 'title', 'prompt', 'acceptance'],
                  },
                },
                required: ['type', 'relation', 'task'],
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'edit_task' },
                  taskId: { type: 'string' },
                  reopen: { type: 'boolean', description: 'blocked 任务调整后是否恢复 pending' },
                  patch: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' }, kind: { type: 'string' }, prompt: { type: 'string' },
                      wbsRef: { type: 'string' }, acceptance: { type: 'string' },
                      deps: { type: 'array', items: { type: 'string' } },
                      plannedFiles: { type: 'array', items: { type: 'string' } },
                      constraints: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
                required: ['type', 'taskId', 'patch'],
              },
              {
                type: 'object',
                properties: { type: { const: 'delete_task' }, taskId: { type: 'string' } },
                required: ['type', 'taskId'],
              },
            ],
          },
        },
      },
      required: ['reason', 'operations'],
    },
  },
  {
    name: 'awf_dynamic_plan_status',
    description: '读取动态任务规划 proposal 的状态、影响分析和应用结果；不返回内部 proposedState 快照',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: '动态规划 proposal ID' },
      },
      required: ['proposalId'],
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
    description: '原子完成一个任务：一次提交 status + result + files + commits + architecture（替代多次写入，避免落账中间态）。status 缺省 done',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID' },
        status: { type: 'string', enum: ['done', 'blocked'], description: '最终状态（默认 done）' },
        result: { type: 'string', description: '执行结果描述（exec.result）' },
        files: { type: 'array', items: { type: 'string' }, description: '产出文件路径列表（exec.files）' },
        verdict: { type: 'object', description: '门禁判定结果（写进 exec.verdict，如 { level: "pass|changes_requested|fail", conclusion: "..." }）' },
        architecture: { type: 'object', description: '本次架构判断或审查结论（写进 exec.architecture）' },
        commits: { type: 'array', items: { type: 'object', properties: { hash: { type: 'string' }, message: { type: 'string' } }, required: ['hash', 'message'] }, description: 'commit 记录列表' },
        blockedReason: { type: 'string', description: 'status=blocked 时的原因说明' },
      },
      required: ['id'],
    },
  },
  {
    name: 'awf_task_create',
    description: '创建新任务；plan/idle 阶段可用 prerequisiteFor 原子插到目标之前并自动连依赖，run/pause 阶段结构调整必须用 awf_dynamic_plan',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID（唯一）' },
        title: { type: 'string', description: '任务名（一句话）' },
        kind: { type: 'string', enum: ['dev', 'debug', 'review', 'test', 'doc', 'commit', 'ui-design', 'ui-code'], description: '任务类型（默认 dev）；T1 doc 为文档产出，T4 doc 为项目文档门禁' },
        plannedFiles: { type: 'array', items: { type: 'string' }, description: '规划改动文件（相对路径；多 agent 并行按此做冲突过滤，缺失则保守串行）' },
        constraints: { type: 'array', items: { type: 'string' }, description: '任务专属硬约束列表；通用执行规则不应重复写入' },
        prompt: { type: 'string', description: '精简执行提示词（命令 + task ID + 具体要做什么）；不得复制其他结构化字段' },
        wbsRef: { type: 'string', description: '关联的 WBS ID' },
        deps: { type: 'array', items: { type: 'string' }, description: '依赖任务 ID 列表' },
        prerequisiteFor: { type: 'string', description: '可选目标任务 ID；新任务将原子插到它之前并成为其依赖（目标必须 pending）' },
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
        const s = SERVER_MODE ? await readStateServer() : readState();
        if (args?.taskId) {
          const t = (s.tasks || []).find((x) => x.id == args.taskId);
          if (!t) return textResult({ ok: false, error: `task ${args.taskId} not found` });
          return textResult(t);
        }
        return textResult(s);
      }

      // 动态规划是 server 完整能力；MCP 只保留薄协议入口，不在本进程复制业务语义。
      if (name === 'awf_dynamic_plan') {
        if (!SERVER_MODE) return textResult({ ok: false, error: 'awf_dynamic_plan requires state server mode' });
        return textResult(await dynamicPlanServer(args || {}));
      }
      if (name === 'awf_dynamic_plan_status') {
        if (!SERVER_MODE) return textResult({ ok: false, error: 'awf_dynamic_plan_status requires state server mode' });
        return textResult(await dynamicPlanStatusServer(args?.proposalId || ''));
      }

      // all other tools：本地语义 mutate（server 模式读/写边界经 server 单写者）
      const serverState = SERVER_MODE ? await readStateServer() : null;
      const apply = () => {
      const s = serverState || readState();

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

      if (['run', 'pause'].includes(s.mode) && ['awf_task_create', 'awf_task_update', 'awf_task_delete'].includes(name)) {
        return textResult({
          ok: false,
          error: `${name} is disabled while mode=${s.mode}; use awf_dynamic_plan so side effects are handled atomically`,
        });
      }

      switch (name) {
        case 'awf_task_status': {
          const t = tasks.find(t => t.id == args.id);
          if (!t) return textResult({ ok: false, error: `task ${args.id} not found` });
          if ((args.status === 'active' || args.status === 'done' || args.status === 'blocked') && taskGraph) {
            taskGraph.assertTaskDependenciesDone(tasks, args.id);
          }
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
          if (taskGraph) taskGraph.assertTaskDependenciesDone(tasks, args.id);
          if (!t.exec) t.exec = {};
          if (args.result !== undefined) t.exec.result = args.result;
          if (args.files) t.exec.files = args.files;
          if (args.verdict !== undefined) t.exec.verdict = args.verdict;
          if (args.architecture !== undefined) t.exec.architecture = args.architecture;
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
          if (args.kind === 'doc') {
            const isOutput = /^T1-/.test(args.id);
            const isProjectGate = /^T4-/.test(args.id);
            if (!isOutput && !isProjectGate) {
              return textResult({ ok: false, error: 'doc task id must be T1-* (document output) or T4-* (project documentation gate)' });
            }
            if (isProjectGate) {
              if (!/^W4-/.test(args.wbsRef || '')) {
                return textResult({ ok: false, error: 'T4 documentation gate requires a W4-* wbsRef' });
              }
              const duplicateGate = taskList.find(t => /^T4-/.test(t.id) && t.wbsRef === args.wbsRef);
              if (duplicateGate) {
                return textResult({ ok: false, error: `project ${args.wbsRef} already has documentation gate ${duplicateGate.id}` });
              }
            }
          }
          const created = {
            id: args.id, title: args.title, kind: args.kind || 'dev', prompt: args.prompt,
            wbsRef: args.wbsRef, deps: args.deps || [], status: 'pending',
            plannedFiles: args.plannedFiles || [],
            constraints: args.constraints || [],
            acceptance: args.acceptance,
          };
          if (args.prerequisiteFor !== undefined) {
            if (!taskGraph) return textResult({ ok: false, error: 'prerequisiteFor requires task-graph capability' });
            taskGraph.insertPrerequisiteTask(s, { targetId: args.prerequisiteFor, task: created });
          } else {
            taskList.push(created);
            // plan 阶段允许先建被依赖任务、后补前置任务；离开 plan 后每次新增都必须保持完整合法图。
            if (taskGraph && s.mode !== 'plan') taskGraph.assertTaskGraph(taskList);
          }
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
          if (args.deps !== undefined) {
            if (!taskGraph) return textResult({ ok: false, error: 'dependency update requires task-graph capability' });
            taskGraph.replaceTaskDependencies(s, args.id, args.deps);
          }
          if (args.acceptance !== undefined) t.acceptance = args.acceptance;
          break;
        }
        case 'awf_task_delete': {
          const exists = tasks.some(t => t.id == args.id);
          if (!exists) {
            return textResult({ ok: false, error: `task ${args.id} not found` });
          }
          if (!taskGraph) return textResult({ ok: false, error: 'task delete requires task-graph capability' });
          taskGraph.removeTaskFromGraph(s, args.id);
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

      if (!SERVER_MODE) writeState(s);
      logStderr(`${name} ${args.id || args.phase || ''} -> ok`);
      return textResult({ ok: true, tool: name });
      };
      if (SERVER_MODE) {
        const expectedLastUpdated = serverState?.lastUpdated ?? null;
        const expectedStateFingerprint = stateFingerprint(serverState);
        const res = apply();
        // 参数/图约束失败属于 no-op，不能再把读取到的旧快照写回 server。
        if (resultFailed(res)) return res;
        await writeStateServer(serverState, expectedLastUpdated, expectedStateFingerprint);
        return res;
      }
      return withStateLock(apply);
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
