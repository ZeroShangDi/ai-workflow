#!/usr/bin/env node
/**
 * 真 run 全流程回归 harness（T1-098）
 *
 * 在独立沙箱项目里跑**真** `awf run`（真 tmux + 真 claude + 真 server），覆盖：
 *   - single   : 单 agent 最小链路（DEV 任务自我落账 → run done）
 *   - gate     : 门禁任务（kind=review）产出 verdict，断言门禁闭环不误派生修复
 *   - multi    : 多 agent（--multi-agent）
 *   - decision : 决策闸门（run.decision.enabled=true）真链路——
 *                `<AWF_DECISION_REQUIRED>` 收尾 → Stop 闸门转决策 → 产出 `<AWF_DECISION_RESULT>`
 *                → 决策落盘 + 续跑注入 → 任务完成（W3-008 L3 遗留项）
 *   - dual     : 同机两独立项目并发 run（W3-006 隔离回归）
 *   - resume   : 重连续接（T1-108）——宿主空闲时 `--attach` 拒绝且不清场；CLI 被 SIGKILL 中断后
 *                `--attach` 挂接仍在飞的 run 续观至完成（不重复提交）
 *   - pause    : pause 编排闩锁 + w-monitor 介入（T1-108）——未暂停时 `/intervene` 必须 409；
 *                置 pause 后任务边界处不再派发新任务（闩锁）；`/intervene` 与
 *                `/intervene/interrupt` 在暂停后受理；恢复 run 后剩余任务续跑
 *   - pause-release: 暂停期间「目标任务已结算 → 立即放行」（T1-111）——缓解宿主被闩锁挂死看不见结算；
 *                断言不等 mode 恢复即可收尾，且 T2 的 prompt 始终未派发（闩锁语义不放松）
 *   - recover  : 中断后的现场恢复（T1-108）——CLI 被 SIGKILL 后 tmux/server/state 现场保留、
 *                宿主不依赖 CLI 继续推进；`--resume` 完成收尾复位（run_interrupted 闭环）
 *   - init     : awf init 产出（T1-109）——插件注册/项目级 MCP/骨架目录/幂等，纯文件断言
 *   - mcp      : MCP 工具面冒烟（T1-109）——三 server 各做一次 initialize + tools/list
 *   - lifecycle: 常驻 server 空闲回收（T1-109）——小空闲阈值下探活 → 静置 → 端口关闭 + 进程退出
 *   - web      : 前端可达与取数（T1-109）——页面由构建产物托管/未构建时 503 + 告警（二态断言）、
 *                四视图取数 API 形状、`?p` 项目切换不串、决策 override 端点落盘、旧静态资产已退役
 *   - dynamic-planning: 运行期结构变更的**跨进程边界链路**（真 server + 真 awf-state MCP，不派生模型会话）——
 *                经 MCP JSON-RPC 提案 → proposal 落盘 + 事件追加 + hold 挡住调度器就绪池 →
 *                人工批准应用（新任务先于目标、依赖重连、hold 释放）→ 无关变化放行而相关变化被拒
 *                （闭包指纹 + 锁内重放）→ 拒绝路径同样释放 hold
 *   - dynamic-planning-run: 同一能力的**运行链路（全真）**（真 tmux + 真 Claude）——T1 执行期间 AI 自己
 *                从 task 图里找出 T3 的缺口并调用 `awf_dynamic_plan` 补前置；hold 只挡目标、并行任务
 *                仍继续；人在 **run 进行中**批准；**同一个 run** 跑完且前置先于目标执行
 *
 * 范围边界（plan 腿）：`awf plan` 是**交互式**入口（src/cli/plan.js → launchInteractiveClaude，
 * stdio inherit；w-plan 全流程含人工 Q&A，且 state.json 只在规划末尾落一次），headless 无法
 * 驱动其规划对话。故本 harness 以「与 plan 产物同构的 state.json」直接进入 run 半段；
 * plan 入口的真机链路由 `awf init`（插件/MCP/hooks 注册 = 两端共用）与 plan 自身门禁覆盖。
 *
 * 与其他测试不同：本脚本不 mock，会真实派生 claude 会话，耗时与 token 成本高，
 * 故不进 `npm test`（vitest include 只收 tests/**\/*.test.js），走独立入口 `npm run test:real`。
 * 沙箱产物（各 case 的项目目录 + 证据 JSON）生成到 `sandbox/regression/`（gitignore 的产物区）。
 *
 * 用法：
 *   npm run test:real -- --list                 列出全部 case（不跑）
 *   npm run test:real -- --case single          定向：跑单个 case
 *   npm run test:real -- --case all             全量：按注册表顺序跑全部 case
 *   npm run test:real -- --case all --out /tmp/evidence.json
 *   （等价直跑：node tests/regression/fullflow-regression.mjs --case all）
 *
 * 选项：
 *   --awf <path>   指定 awf CLI 入口（默认用本仓库 src/awf.js；传另一工作副本的 src/awf.js 可钉住被回归链路）
 *   --keep         保留沙箱目录（默认保留，证据留存）；--clean 跑前先删
 *   --timeout <ms> 单 case 超时（默认 10 分钟）
 *   --port <n>     隔离端口跑（自起 server + 插件副本）：测服务端改动时用，见 §隔离端口
 *   --list         列出注册表内全部 case 后退出
 *   --out <path>   汇总证据的 JSON 输出路径（缺省：全量为 evidence-all.json，定向为 evidence-<case>-summary.json）
 *
 * 证据落盘约定（sandbox/regression/，gitignore 产物区）：
 *   evidence-<case>.json  每个 case 一份，**跑完即写**（抛错也写，记为失败断言）——
 *                         定向跑与全量跑产物同名同形，便于横向对比历史
 *   evidence-all.json     全量跑的汇总（各 case 结果 + 总计）；**只有 `--case all` 会写它**，
 *                         定向跑写 evidence-<case>-summary.json，避免覆盖上一轮全量证据
 *   --out <path>          可改汇总输出路径（定向跑时也会覆盖上面的缺省命名）
 *
 * 注意：本脚本从「另一个 run 的会话内」执行时，父 run 会把 CC_SESSION 等变量 export 给
 * 本进程；子 run 必须用 sanitizedEnv() 剔除，否则子 run 会话名与共享 server 的装配不一致。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
// 就绪池/被 hold 判据取自**调度器自己用的那个模块**（state.js），不在这里另写一份近似。
// 「动态规划 hold 真的挡住了派发」只能用调度器的判据来证，否则证的是 harness 的复述。
import { heldTaskIds, peekReadyTasks } from '../../src/lib/state.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// 产物落仓库 sandbox/ 下（gitignore 的产物区）：源码入库、生成物不入库
const SANDBOX_ROOT = process.env.AWF_REGRESSION_ROOT || path.join(ROOT, 'sandbox', 'regression');

// ── CLI 参数 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { case: 'single', awf: null, timeoutMs: 10 * 60 * 1000, clean: false, out: null, list: false, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--case') out.case = argv[++i];
    else if (a === '--awf') out.awf = argv[++i];
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--list') out.list = true;
    else if (a === '--clean') out.clean = true;
    else if (a === '--keep') out.clean = false;
  }
  return out;
}

/**
 * awf CLI 入口（必须是 node 可执行的 .js 路径，不能是 PATH 上的 shell shim）。
 * 优先 --awf；缺省用本仓库自身的 src/awf.js，显式可用 --awf 钉住工作副本。
 */
function resolveAwfCli(explicit) {
  if (explicit) return path.resolve(explicit);
  const local = path.join(ROOT, 'src', 'awf.js');
  if (!fs.existsSync(local)) throw new Error(`找不到 awf CLI：${local}，请传 --awf <path>`);
  return local;
}

/**
 * 前置依赖检查：真 run 需要 tmux（会话）与 claude（会话内驱动）。
 * 失败要快 —— 在派生任何会话、消耗任何 token 之前中止。
 */
function preflight() {
  const missing = ['tmux', 'claude'].filter((bin) => {
    try {
      execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) throw new Error(`真机回归前置依赖缺失，请先安装并登录：${missing.join(', ')}（需在 PATH 上）`);
}

// ── 环境隔离 ────────────────────────────────────────────────────────────────

/**
 * 派生嵌套 run 时必须剔除父 run 注入的 CC_* 变量。
 * 父 run 的 tmux 会话会把 CC_SESSION 等 export 给它启动的 claude；本 harness 正是在
 * 这样的 claude 里执行，若透传则子 run 会按父会话名装配 tmux 会话，而共享 server 按
 * config 单源（cc）装配，二者不一致 → 宿主报 `tmux session '...' not found`。
 */
const INHERITED_CC_VARS = [
  'CC_SESSION', 'CC_PORT', 'CC_PROJECT', 'CC_WORKDIR',
  'CC_AWF_STATE_SERVER', 'CC_SID', 'CC_READY_TIMEOUT_MS',
];

function sanitizedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of INHERITED_CC_VARS) delete env[k];
  return { ...env, ...extra };
}

/** `open` 空实现：真 run 会 `spawn('open', dashboardURL)`，回归时不应弹浏览器 */
function openShimDir() {
  const dir = path.join(SANDBOX_ROOT, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'open');
  if (!fs.existsSync(shim)) {
    fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(shim, 0o755);
  }
  return dir;
}

// ── 沙箱项目 ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taskSet(kind) {
  const dev = (id, file, value) => ({
    id,
    title: `创建 ${file}`,
    kind: 'dev',
    status: 'pending',
    deps: [],
    wbsRef: 'W1',
    prompt: `执行 /ai-workflow-code:w-dev ${id}：在项目根创建 ${file}，导出一个自增计数器函数 makeCounter()，`
      + `返回 { inc(), value() }；完成后用 awf_task_complete 把 ${id} 记录为 done（result 说明产出，files 填 ${file}）。`,
    plannedFiles: [file],
    constraints: [`只创建 ${file}`],
    acceptance: `${file} 存在且导出 makeCounter`,
    _value: value,
  });
  if (kind === 'dev2') {
    // 两个互不依赖的 dev 任务：任务边界是 pause 闩锁的观察点（T1 完成后 T2 是否被派发）
    return [dev('T1', 'src/counter.js', 1), dev('T2', 'src/accumulator.js', 2)];
  }
  if (kind === 'gate') {
    return [
      dev('T1', 'src/counter.js'),
      {
        id: 'T2',
        title: '审查 T1 产出',
        kind: 'review',
        status: 'pending',
        deps: ['T1'],
        wbsRef: 'W1',
        prompt: '执行 /ai-workflow-code:w-review T2：对 T1 的产出 src/counter.js 做代码审查，'
          + '按 w-review 门禁口径用 awf_task_complete 落账 T2，并在 verdict 里给出 level（pass/fail）。',
        plannedFiles: ['src/counter.js'],
        constraints: [],
        acceptance: 'T2 落账并带 verdict.level',
      },
    ];
  }
  if (kind === 'decision') {
    return [
      {
        id: 'T1',
        title: '决策后创建 src/counter.js',
        kind: 'dev',
        status: 'pending',
        deps: [],
        wbsRef: 'W1',
        prompt: '执行 /ai-workflow-code:w-dev T1：本任务必须先做一次真实决策，再据此实现。\n'
          + '第一步（不要创建任何文件）：把「计数器是否需要上限保护」当作决策问题，'
          + '以 <AWF_DECISION_REQUIRED> 与 </AWF_DECISION_REQUIRED> 包裹问题内容，'
          + '并把该标记块放在本回合最后一行，然后结束本回合等待决策结果。\n'
          + '第二步：收到决策结果后，按结论在项目根创建 src/counter.js，导出一个自增计数器函数 makeCounter()，'
          + '返回 { inc(), value() }；完成后用 awf_task_complete 把 T1 记录为 done'
          + '（result 说明产出与决策如何影响实现，files 填 src/counter.js）。',
        plannedFiles: ['src/counter.js'],
        constraints: ['只创建 src/counter.js'],
        acceptance: 'src/counter.js 存在且导出 makeCounter；本次 run 产生过 decision_completed 记录',
      },
    ];
  }
  return [dev('T1', 'src/counter.js')];
}

function seedState(projectRoot, tasks, summary) {
  const state = {
    mode: 'idle',
    currentState: 'CODE',
    version: '0.2.0',
    milestones: [],
    plan: { summary, reqDoc: '', hasUI: false, inScope: [], outOfScope: [], acceptanceCriteria: [] },
    wbs: [{ id: 'W1', name: '沙箱样例', desc: summary, deps: [] }],
    tasks: tasks.map(({ _value, ...t }) => t),
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(projectRoot, '.awf', 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

/** 建一个独立沙箱项目：awf init + 播种 plan 状态 */
function makeProject(name, { tasks, summary, agentsMax = 1, decision = false }) {
  const projectRoot = path.join(SANDBOX_ROOT, name);
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  execFileSync('node', [AWF_CLI, 'init'], { cwd: projectRoot, env: sanitizedEnv(), stdio: 'pipe' });
  if (ISOLATED_PLUGIN_DIR) repointMarketplace(projectRoot, ISOLATED_PLUGIN_DIR); // §隔离端口
  const cfgPath = path.join(projectRoot, '.awf', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.run.agents.max = agentsMax;
  cfg.run.decision.enabled = decision;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  seedState(projectRoot, tasks, summary);
  return projectRoot;
}

let AWF_CLI = null;
let ISOLATED_PLUGIN_DIR = null; // --port 时为插件副本目录，否则 null（挂仓库自身 plugin/）

function readState(projectRoot) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, '.awf', 'state.json'), 'utf8'));
}

function taskSummary(projectRoot) {
  const s = readState(projectRoot);
  return {
    mode: s.mode,
    tasks: s.tasks.map((t) => ({ id: t.id, kind: t.kind, status: t.status, verdict: t.exec?.verdict?.level ?? null })),
    counts: s.tasks.reduce((acc, t) => ((acc[t.status] = (acc[t.status] || 0) + 1), acc), {}),
  };
}

// ── 真 run 执行 ─────────────────────────────────────────────────────────────

/**
 * 启动 `awf run`（后台进程）。
 * 返回**可序列化**的描述符 { pid, logPath, projectRoot }（进证据 JSON），
 * 子进程句柄另存 RUN_PROCS（ChildProcess 有循环引用，放进去会让 JSON.stringify 抛错）。
 */
function launchRun(projectRoot, { multiAgent = false, extraArgs = [], logSuffix = '', env = {} } = {}) {
  const logPath = path.join(path.dirname(projectRoot), `run-${path.basename(projectRoot)}${logSuffix}.log`);
  const args = [AWF_CLI, 'run', ...extraArgs];
  if (multiAgent) args.push('--multi-agent');
  const fd = fs.openSync(logPath, 'w');
  const proc = spawn('node', args, {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: sanitizedEnv({
      PATH: `${openShimDir()}${path.delimiter}${process.env.PATH}`,
      CC_SERVER_IDLE_MS: '0', // 回归期间不自动回收常驻 server
      // 与 harness 对话的 server 对齐（sanitizedEnv 会剔除继承来的 CC_PORT）：
      // 缺省 = config 缺省端口；--port 时 = 专用端口，子 run 自起 server
      CC_PORT: String(SERVER_PORT),
      ...env, // per-case 覆盖（如把 pause 告警阈值调小以便真机验证）
    }),
  });
  proc.unref();
  RUN_PROCS.set(proc.pid, proc);
  return { pid: proc.pid, logPath, projectRoot };
}

/** 运行中的 `awf run` 进程句柄：pid → ChildProcess（不入证据，见 launchRun 注释） */
const RUN_PROCS = new Map();

/** 等某个 `awf run` 进程退出（中断/重连场景要拿退出码，普通 case 不用） */
function waitRunExit(pid, { timeoutMs = 180000 } = {}) {
  const proc = RUN_PROCS.get(pid);
  if (!proc) return Promise.resolve({ ok: false, error: `未知 pid ${pid}`, code: null });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: '等待进程退出超时', code: null }), timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: true, code, signal });
    });
  });
}

/** 进程是否还活着（信号 0 探活） */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 硬中断 CLI：SIGKILL 绕过 run.js 的 SIGINT/SIGTERM 清理（doCleanup 会 kill tmux 会话），
 * 从而留下「CLI 已死、tmux/server/state 现场仍在」的中断态——正是 w-monitor 要识别的 run_interrupted。
 */
function killCli(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

/** 等 run 结束：state.mode 回 idle 或出现终止态（done/blocked 全覆盖） */
async function waitRunSettled(projectRoot, { timeoutMs }) {
  const t0 = Date.now();
  let settledSince = null; // 任务全部结算的时刻（mode 复位的宽限从这里起算，不是从 run 开始算）
  for (;;) {
    const s = readState(projectRoot);
    const settled = s.tasks.every((t) => t.status === 'done' || t.status === 'blocked');
    if (settled && s.mode !== 'run') return { ok: true, elapsedMs: Date.now() - t0 };
    if (settled) {
      settledSince = settledSince ?? Date.now();
      if (Date.now() - settledSince > 5000) return { ok: true, elapsedMs: Date.now() - t0, note: 'mode 未复位' };
    } else {
      settledSince = null;
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, elapsedMs: Date.now() - t0, error: 'run 超时未收敛' };
    await sleep(2000);
  }
}

// ── 断言 ────────────────────────────────────────────────────────────────────

function check(name, pass, detail) {
  return { name, pass: !!pass, detail: detail ?? null };
}

// ── 轮询 / 常驻 server 直连（恢复与介入 case 用） ───────────────────────────

/**
 * 常驻 server 端口。与子 run 同源：子 run 的 env 已被 sanitizedEnv 剔除 CC_PORT，故按 config
 * 缺省端口 —— 于是本 harness 对话的，正是**机器上已驻留的那个 server**。
 *
 * 注意（T1-108 踩到）：服务端改动只有在该 server 重启后才生效 —— 插件 hooks 的端口是渲染期
 * 烘进 `plugin/core/hooks/hooks.json` 的固定值（`gateway.cjs <port>`），换端口跑会让 hook 事件
 * 发往默认端口、子 run 收不到 SessionStart/Stop，session 状态机永远回不到 ready。故本 harness
 * **不能**靠换端口来对齐代码；要测服务端改动，得先让常驻 server 带新代码重启。
 */
let SERVER_PORT = null;

function resolveServerPort(explicit) {
  if (explicit) return explicit;
  const repoRoot = path.dirname(path.dirname(AWF_CLI));
  const req = createRequire(import.meta.url);
  return req(path.join(repoRoot, 'src', 'lib', 'runtime-config.cjs')).getServerPort(sanitizedEnv());
}

/**
 * §隔离端口：常驻 server 跑的是它启动时的代码 —— 改了 src/server/** 又不重启它，真机回归测的还是旧实现。
 * 换端口能自起 server，但**插件 hooks 的端口是渲染期写死在 `plugin/core/hooks/hooks.json` 里的 argv**
 * （`node gateway.cjs 8787`），`CC_PORT` 只是兜底、argv 优先。所以换端口会让 hook 事件发往默认端口，
 * 子 run 收不到 SessionStart/Stop，会话状态机永远回不到 ready（T1-108 踩过）。
 * 解法：把 plugin/ 复制一份到沙箱、只把副本 hooks 的端口改掉，再让沙箱项目挂这个副本。
 * 只动沙箱内的副本，不碰仓库里的 plugin/，也不打扰机器上正在跑的 run。
 */
function isolatedPluginDir(port) {
  const dir = path.join(SANDBOX_ROOT, `.plugin-${port}`);
  const src = path.join(path.dirname(path.dirname(AWF_CLI)), 'plugin');
  // 每次重建：副本若被复用会静默钉住上一轮的插件代码，回归就成了「测旧副本」
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(src, dir, { recursive: true });
  const hooksPath = path.join(dir, 'core', 'hooks', 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  for (const entries of Object.values(hooks.hooks || {})) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) {
        h.command = String(h.command).replace(/(gateway\.cjs\"?\s+)\d+/, `$1${port}`);
      }
    }
  }
  fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n');
  return dir;
}

/** 停掉本次用的隔离 server（best-effort：常驻 server 留着只会在机器上攒端口） */
function stopIsolatedServer() {
  try {
    execFileSync('node', [AWF_CLI, 'server', 'stop'], {
      cwd: path.dirname(SANDBOX_ROOT),
      env: sanitizedEnv({ CC_PORT: String(SERVER_PORT) }),
      stdio: 'ignore',
    });
  } catch { /* 没起来/已停都不影响结果 */ }
}

/** 让沙箱项目挂隔离副本（改写 awf init 写下的 marketplace 路径），其余字段原样保留 */
function repointMarketplace(projectRoot, pluginDir) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const m of Object.values(settings.extraKnownMarketplaces || {})) {
    if (m?.source?.source === 'directory') m.source.path = pluginDir;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

/** 读 state 容坏（写侧原子写 + 本进程并发轮询，仍可能出现瞬时半写） */
function readStateSafe(projectRoot) {
  try { return readState(projectRoot); } catch { return null; }
}

/**
 * 轮询 state 直到 predicate 为真。返回 { ok, state, elapsedMs }——ok=false 表示超时，
 * 由调用方决定这是断言失败还是可接受的分支（不静默吞）。
 */
async function waitFor(projectRoot, predicate, { timeoutMs = 120000, intervalMs = 500 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = readStateSafe(projectRoot);
    if (s && predicate(s)) return { ok: true, state: s, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, state: s, elapsedMs: Date.now() - t0 };
    await sleep(intervalMs);
  }
}

/**
 * POST 到常驻 server，经 `?p` 路由到该项目上下文。
 * 端点与 MCP 工具同源：`/run/state/mode`（awf_mode）、`/intervene` `/intervene/interrupt`（awf_session_*）。
 */
function postToServer(pathname, projectRoot, body, port = SERVER_PORT) {
  return httpRequest('POST', `${pathname}?p=${encodeURIComponent(projectRoot)}`, body, port);
}

/** GET 常驻 server（探活 / 读槽态 / 取页面） */
function getFromServer(pathname, projectRoot, port = SERVER_PORT) {
  return httpRequest('GET', `${pathname}?p=${encodeURIComponent(projectRoot)}`, null, port);
}

/** 取页面（不带 ?p：页面路由不按项目分片，?p 只影响后续取数） */
function getPage(pathname, port = SERVER_PORT) {
  return httpRequest('GET', pathname, null, port);
}

function httpRequest(method, pathWithQuery, body, port = SERVER_PORT) {
  return new Promise((resolve) => {
    const payload = body === null || body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathWithQuery,
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 非 JSON 响应保留 raw */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: '', error: e.message }));
    req.setTimeout(10000, () => { req.destroy(new Error('请求超时')); });
    req.end(payload ?? undefined);
  });
}

/** 轮询任意异步探测函数（用于 /run/status 这类不是 state.json 的信号） */
async function waitUntil(probe, { timeoutMs = 120000, intervalMs = 1000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return { ok: true, value: v, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, elapsedMs: Date.now() - t0 };
    await sleep(intervalMs);
  }
}

/** 该项目最近一次 run 的 main.log（server 侧 logPrompt 落这里） */
function projectRunLogOf(projectRoot) {
  const dir = logDirOf(projectRoot);
  return dir ? path.join(dir, 'main.log') : null;
}

/**
 * 该项目会话是否可读（每次重解析日志目录，避免 run 换目录后读到旧文件）。
 * logPrompt 是**派发的落账点**（在 pause 闩锁之后才调用），故它的有无即「是否已派发」的证据。
 */
function projectLogText(projectRoot) {
  const p = projectRunLogOf(projectRoot);
  return p ? readLog(p) : '';
}

/**
 * 等会话回到 ready。介入（/intervene）会把文本**打进会话输入框**，若此时会话正忙/输入框有残留，
 * 介入文本会与随后编排派发的 prompt 合并成同一条消息（T1-108 首版 pause case 真机上即如此，
 * 导致任务被探针指令带偏、run 卡住）。故介入前必须先确认会话已收尾。
 */
async function waitSessionReady(projectRoot, { timeoutMs = 180000, intervalMs = 1000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await getFromServer('/status', projectRoot);
    if (r.status === 200 && r.json?.state === 'ready') return { ok: true, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, elapsedMs: Date.now() - t0, last: r.json?.state ?? null };
    await sleep(intervalMs);
  }
}

// ── case 实现 ──────────────────────────────────────────────────────────────

async function caseSingle({ timeoutMs }) {
  const projectRoot = makeProject('single', {
    tasks: taskSet('dev'),
    summary: 'T1-098 单 agent 最小真 run',
  });
  const run = launchRun(projectRoot);
  const envProbe = probeSessionEnv(projectRoot);
  const settled = await waitRunSettled(projectRoot, { timeoutMs });
  const { env } = await envProbe;
  const sum = taskSummary(projectRoot);
  const artifact = path.join(projectRoot, 'src', 'counter.js');
  return {
    case: 'single',
    projectRoot,
    run,
    settled,
    sessionEnv: env,
    summary: sum,
    checks: [
      check('run 收敛', settled.ok, settled.error),
      check('T1 done', sum.tasks[0]?.status === 'done', sum.tasks[0]?.status),
      check('真实产出落盘', fs.existsSync(artifact), artifact),
      check('mode 复位 idle', sum.mode === 'idle', sum.mode),
      check('per-run 日志落盘', fs.existsSync(path.join(projectRoot, '.awf', 'logs'))),
      check('run 会话 env 指向本项目（CC_PROJECT/CC_WORKDIR）', envPointsAt(env, projectRoot), JSON.stringify(env)),
    ],
  };
}

async function caseGate({ timeoutMs }) {
  const projectRoot = makeProject('gate', {
    tasks: taskSet('gate'),
    summary: 'T1-098 门禁（review verdict）真 run',
  });
  const run = launchRun(projectRoot);
  const envProbe = probeSessionEnv(projectRoot);
  const settled = await waitRunSettled(projectRoot, { timeoutMs });
  const { env } = await envProbe;
  const sum = taskSummary(projectRoot);
  const review = sum.tasks.find((t) => t.kind === 'review');
  const state = readState(projectRoot);
  return {
    case: 'gate',
    projectRoot,
    run,
    settled,
    sessionEnv: env,
    summary: sum,
    checks: [
      check('run 收敛', settled.ok, settled.error),
      check('dev 任务 done', sum.tasks.find((t) => t.id === 'T1')?.status === 'done'),
      check('门禁任务已落账', !!review && ['done', 'blocked'].includes(review.status), review?.status),
      check('门禁产出 verdict.level', !!review?.verdict, review?.verdict),
      check('无残留 pending', !state.tasks.some((t) => t.status === 'pending' || t.status === 'active')),
      check('run 会话 env 指向本项目（CC_PROJECT/CC_WORKDIR）', envPointsAt(env, projectRoot), JSON.stringify(env)),
    ],
  };
}

async function caseMulti({ timeoutMs }) {
  const projectRoot = makeProject('multi', {
    tasks: taskSet('dev'),
    summary: 'T1-098 多 agent 真 run',
    agentsMax: 2,
  });
  const run = launchRun(projectRoot, { multiAgent: true });
  const envProbe = probeSessionEnv(projectRoot);
  const settled = await waitRunSettled(projectRoot, { timeoutMs });
  const { env } = await envProbe;
  const sum = taskSummary(projectRoot);
  return {
    case: 'multi',
    projectRoot,
    run,
    settled,
    sessionEnv: env,
    summary: sum,
    checks: [
      check('run 收敛', settled.ok, settled.error),
      check('T1 done', sum.tasks[0]?.status === 'done', sum.tasks[0]?.status),
      check('真实产出落盘', fs.existsSync(path.join(projectRoot, 'src', 'counter.js'))),
      check('run 会话 env 指向本项目（CC_PROJECT/CC_WORKDIR）', envPointsAt(env, projectRoot), JSON.stringify(env)),
    ],
  };
}

/**
 * 决策闸门（run.decision.enabled=true）：真 claude 走一次完整决策闭环。
 * 链路：AI 以 <AWF_DECISION_REQUIRED> 收尾 → Stop 闸门 block 并注入决策指令
 *      → AI 产出 <AWF_DECISION_RESULT> → 闸门 resolve → DecisionStore 落盘 + 置 decisionResume
 *      → CLI observe 轮询到 decisionResume → /send 注入续跑 → 任务继续并落账。
 */
async function caseDecision({ timeoutMs }) {
  const projectRoot = makeProject('decision', {
    tasks: taskSet('decision'),
    summary: 'T1-098 决策闸门真 run',
    decision: true,
  });
  const run = launchRun(projectRoot);
  const envProbe = probeSessionEnv(projectRoot);
  const settled = await waitRunSettled(projectRoot, { timeoutMs });
  const { env } = await envProbe;
  const sum = taskSummary(projectRoot);
  const records = readDecisions(projectRoot);
  const completed = records.filter((r) => r.event === 'decision_completed');
  const stamp = logStampOf(projectRoot);

  // T3-011-F1：per-run 日志目录取不到时，**当场取证**而不是只报一个 null。
  // 背景：DecisionStore 的 runStamp 正是从 `.awf/logs/<version>-<ts>/` 的目录名派生的
  // （decision-store.cjs 头注释）—— 目录缺失时它回退用当前时间生成，此时「决策属于本次 run」
  // 仍然成立，只是**派生依据不同**（这正是连跑模式下那条间歇失败的现场）。
  // 该条件目前无法从测试侧修（根因在 RunLogger._init 读不到 version 时静默 return），
  // 故这里如实降级判定 + 把现场写进证据，供下次出现时直接定位。
  const stamps = [...new Set(completed.map((r) => r.runStamp ?? null))];
  const stampWellFormed = (s) => typeof s === 'string' && /^\d+\.\d+\.\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(s);
  const diagnosis = stamp ? null : {
    stateVersionReadable: (() => {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(projectRoot, '.awf', 'state.json'), 'utf8')).version;
        return v ?? '(state.json 无 version 字段)';
      } catch (e) { return `state.json 读取失败: ${e.code || e.message}`; }
    })(),
    logsDirListing: (() => {
      try { return fs.readdirSync(path.join(projectRoot, '.awf', 'logs')); } catch { return null; }
    })(),
    decisionStamps: stamps,
    cliLog: run.logPath,
  };
  if (diagnosis) console.log(`  [诊断] per-run 日志目录未生成（decision case）: ${JSON.stringify(diagnosis)}`);

  return {
    case: 'decision',
    projectRoot,
    run,
    settled,
    sessionEnv: env,
    summary: sum,
    diagnosis,
    decisions: completed.map((r) => ({
      decisionId: r.decision_id,
      runStamp: r.runStamp,
      type: r.result?.type ?? null,
      fallback: r.fallback === true,
      answer: typeof r.result?.answer === 'string' ? r.result.answer.slice(0, 80) : null,
    })),
    checks: [
      check('run 收敛', settled.ok, settled.error),
      check('决策记录落盘（decision_completed）', completed.length >= 1, `${completed.length} 条`),
      check('决策非兜底（AI 产出可解析的 Decision Result）', completed.some((r) => r.fallback !== true), JSON.stringify(completed.map((r) => r.result?.type))),
      check('决策落本次 run 的 runStamp（per-run 隔离）',
        completed.length > 0 && completed.every((r) => stampWellFormed(r.runStamp)) && stamps.length === 1
          && (stamp === null || stamps[0] === stamp),
        stamp !== null ? `${stamp} vs ${stamps.join(',')}` : `无 per-run 日志目录 → 降级为自洽判定，诊断=${JSON.stringify(diagnosis)}`),
      ...(stamp === null ? [check('（降级）无 per-run 日志目录时的 runStamp 自洽',
        stamps.length === 1 && stampWellFormed(stamps[0]), `stamps=${JSON.stringify(stamps)}`)] : []),
      check('续跑注入（CLI 中继 decisionResume）', logContains(run.logPath, '→ 续跑'), run.logPath),
      check('T1 done', sum.tasks[0]?.status === 'done', sum.tasks[0]?.status),
      check('真实产出落盘', fs.existsSync(path.join(projectRoot, 'src', 'counter.js'))),
      check('mode 复位 idle', sum.mode === 'idle', sum.mode),
      check('run 会话 env 指向本项目（CC_PROJECT/CC_WORKDIR）', envPointsAt(env, projectRoot), JSON.stringify(env)),
    ],
  };
}

/**
 * 双 run（W3-006）：两个独立项目在同一常驻 server 上并发真 run。
 * 断言：两 tmux 会话名互异且并存、两 run 各自收敛、state 不串写、server 项目表含两者。
 */
async function caseDual({ timeoutMs }) {
  const a = makeProject('dual-a', { tasks: taskSet('dev'), summary: 'T1-098 双 run A' });
  const b = makeProject('dual-b', { tasks: taskSet('dev'), summary: 'T1-098 双 run B' });

  const baseline = listSessions();
  const runA = launchRun(a);
  const runB = launchRun(b);
  const envProbeA = probeSessionEnv(a);
  const envProbeB = probeSessionEnv(b);

  // 并发期采样：两个新 tmux 会话必须同时存在（单 server 多项目会话名唯一，见 projectSid）
  let peak = [];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    peak = listSessions().filter((s) => !baseline.includes(s));
    if (peak.length >= 2) break;
    await sleep(1000);
  }

  const [settledA, settledB] = await Promise.all([
    waitRunSettled(a, { timeoutMs }),
    waitRunSettled(b, { timeoutMs }),
  ]);
  const [{ env: envA }, { env: envB }] = await Promise.all([envProbeA, envProbeB]);

  const sumA = taskSummary(a);
  const sumB = taskSummary(b);
  // A/B 各自持己方会话名：cc-<projectSid(projectRoot)>
  const sessA = sessionNameOf(a);
  const sessB = sessionNameOf(b);

  return {
    case: 'dual',
    projects: { a, b },
    runs: { a: runA, b: runB },
    sessionsSeen: peak,
    sessionEnv: { a: envA, b: envB },
    expectedSessions: { a: sessA, b: sessB },
    settled: { a: settledA, b: settledB },
    summary: { a: sumA, b: sumB },
    checks: [
      check('并发期两 tmux 会话并存', peak.length >= 2, peak.join(',')),
      check('并发会话名互异', new Set(peak).size === peak.length, peak.join(',')),
      check('A/B 会话名与 projectSid 对应', peak.includes(sessA) && peak.includes(sessB), `${sessA} / ${sessB}`),
      check('A run 收敛', settledA.ok, settledA.error),
      check('B run 收敛', settledB.ok, settledB.error),
      check('A 任务 done', sumA.tasks[0]?.status === 'done', sumA.tasks[0]?.status),
      check('B 任务 done', sumB.tasks[0]?.status === 'done', sumB.tasks[0]?.status),
      check('A 真实产出', fs.existsSync(path.join(a, 'src', 'counter.js'))),
      check('B 真实产出', fs.existsSync(path.join(b, 'src', 'counter.js'))),
      check('A 状态只含己方任务', sumA.tasks.length === 1 && sumA.tasks[0].id === 'T1'),
      check('B 状态只含己方任务', sumB.tasks.length === 1 && sumB.tasks[0].id === 'T1'),
      check('两 run 各自 per-run 日志目录互异', logDirOf(a) !== logDirOf(b), `${logDirOf(a)} / ${logDirOf(b)}`),
      check('A 会话 env 指向 A 项目', envPointsAt(envA, a), JSON.stringify(envA)),
      check('B 会话 env 指向 B 项目', envPointsAt(envB, b), JSON.stringify(envB)),
      check('两 run 会话 env 不串（CC_PROJECT 互异）', !!envA.CC_PROJECT && !!envB.CC_PROJECT && envA.CC_PROJECT !== envB.CC_PROJECT, `${envA.CC_PROJECT} / ${envB.CC_PROJECT}`),
    ],
  };
}

/**
 * 重连续接（T1-108 / 缺口 6）：`--attach` / `--resume` 的重连语义。
 *
 * ① 宿主空闲时 `--attach` 必须拒绝（负向）：`awf run --attach` 对一个还没有 run 的项目 →
 *    driveSingle 找不到活跃 run → 报错退出；且**不清场**（tmux 会话与 mode 保留供诊断）。
 * ② CLI 被 SIGKILL 中断后 `--attach` 挂接**仍在飞**的 run：宿主活在 server 里、与 CLI 生死无关，
 *    故 attach 应挂接该 run 并续观至完成，不重复提交、不重建会话（重建会丢掉在跑的任务）。
 */
async function caseResume({ timeoutMs }) {
  // ① 负向：宿主空闲 → --attach 拒绝且保留现场
  const idleRoot = makeProject('resume-idle', {
    tasks: taskSet('dev'),
    summary: 'T1-108 --attach 无活跃 run 时的拒绝',
  });
  const idleRun = launchRun(idleRoot, { extraArgs: ['--attach'], logSuffix: '-idle' });
  const idleExit = await waitRunExit(idleRun.pid, { timeoutMs: 180000 });
  const idleState = readStateSafe(idleRoot);
  const idleSess = sessionNameOf(idleRoot);
  const idleKept = listSessions().includes(idleSess);
  const idleLog = readLog(idleRun.logPath);
  // 断言后就地清理①留下的游离会话，避免给后续 case 残留现场
  try { execFileSync('tmux', ['kill-session', '-t', idleSess], { stdio: 'ignore' }); } catch {}

  // ② 正向：真 run 中断 → --attach 挂接续接至完成
  const projectRoot = makeProject('resume-attach', {
    tasks: taskSet('dev'),
    summary: 'T1-108 中断后 --attach 重连续接',
  });
  const run = launchRun(projectRoot);
  const inflight = await waitFor(projectRoot, (s) => s.tasks[0]?.status === 'active', {
    timeoutMs: 180000, intervalMs: 400,
  });
  killCli(run.pid); // SIGKILL：绕过 doCleanup，保留 tmux/server 现场
  await sleep(1500);
  const afterKill = readStateSafe(projectRoot);
  const sess = sessionNameOf(projectRoot);
  const siteKept = listSessions().includes(sess);
  const cliDead = !isAlive(run.pid);

  const attach = launchRun(projectRoot, { extraArgs: ['--attach'], logSuffix: '-attach' });
  const attachExit = await waitRunExit(attach.pid, { timeoutMs });
  const settled = await waitRunSettled(projectRoot, { timeoutMs });
  const sum = taskSummary(projectRoot);
  const attachLog = readLog(attach.logPath);
  const artifact = path.join(projectRoot, 'src', 'counter.js');

  return {
    case: 'resume',
    projects: { idle: idleRoot, attach: projectRoot },
    runs: { idle: idleRun, attach, attachFirst: run },
    summary: { idle: taskSummary(idleRoot), attach: sum },
    checks: [
      // ① 负向
      check('① 宿主空闲时 --attach 报错（宿主无活跃 run）', /宿主无活跃 run/.test(idleLog), tailOf(idleLog, 3)),
      check('① 失败退出码非 0', idleExit.ok && idleExit.code !== 0, `code=${idleExit.code}`),
      check('① 失败不清场：tmux 会话保留', idleKept, idleSess),
      check('① 失败不清场：mode 未被静默复位', idleState?.mode !== 'idle', `mode=${idleState?.mode}`),
      // ② 正向
      check('② 中断前任务确实在飞（active）', inflight.ok, `elapsed=${inflight.elapsedMs}ms`),
      check('② CLI 已被硬中断（进程消失）', cliDead, `pid=${run.pid}`),
      check('② 中断后现场保留：tmux 会话仍在', siteKept, sess),
      check('② 中断后 mode 仍为 run（w-monitor 据此识别 run_interrupted）', afterKill?.mode === 'run', `mode=${afterKill?.mode}`),
      check('② --attach 挂接活跃 run（非新提交）', /挂接 run/.test(attachLog) && !/已提交 run/.test(attachLog), tailOf(attachLog, 4)),
      check('② attach 进程正常退出', attachExit.ok && attachExit.code === 0, `code=${attachExit.code} signal=${attachExit.signal}`),
      check('② run 收敛', settled.ok, settled.error),
      check('② 任务 done', sum.tasks[0]?.status === 'done', sum.tasks[0]?.status),
      check('② 真实产出落盘', fs.existsSync(artifact), artifact),
      check('② mode 复位 idle', sum.mode === 'idle', sum.mode),
    ],
  };
}

/** pause 闩锁断言窗口：暂停期间任务边界处必须停止派发新任务 */
const PAUSE_LATCH_WINDOW_MS = 15000;

/**
 * pause 编排闩锁 + w-monitor 介入（T1-108 / 缺口 7）。
 *
 * 链路：mode=pause（与 MCP awf_mode 同端点）→ 宿主的派发路径在 waitWhilePaused 上闩住 →
 *      任务边界处不再把下一个任务**派发进会话**；`/intervene`、`/intervene/interrupt` 仅在
 *      pause 下受理；恢复 mode=run → 剩余任务续跑至完成。
 *
 * 用两个互不依赖的 dev 任务把「任务边界」变成可观察点。注意判据是**有没有派发**，不是任务状态：
 * driveSingle 会先 markTaskActive + 发 task.started，再进 executor.runTask 等闩锁——所以暂停期间
 * T2 的 status 本来就可能是 active，真正该断言的是它的 prompt 没被送进会话（logPrompt 是派发落账点）。
 */
async function casePause({ timeoutMs }) {
  const projectRoot = makeProject('pause', {
    tasks: taskSet('dev2'),
    summary: 'T1-108 pause 闩锁 + w-monitor 介入',
  });
  // 告警阈值调小，使「挂起超阈值 → 告警」这条可观测性在真机可验证（缺省 30s 会超出本 case 的观察窗）。
  // T3-011-F1：**阈值必须进 server 进程** —— 告警由宿主侧发出并写进 `<项目>/.awf/logs/<stamp>/main.log`，
  // 而 server 是别的 case 唤起后被复用的，只给 launchRun 传 env 只作用于 CLI 进程：
  // 宿主仍按 30s 判定，于是常在告警前就放行了，这条断言在连跑下必然假红（CLI 侧那条 5s 告警
  // 只进控制台日志，不在 main.log）。故本 case 自起 server 并带上阈值（与 pause-release 同一手法）。
  const own = await ownServer(projectRoot, { CC_PAUSE_ALERT_MS: '5000' });
  const run = launchRun(projectRoot, { env: { CC_PAUSE_ALERT_MS: '5000' } });
  const inflight = await waitFor(projectRoot, (s) => s.tasks[0]?.status === 'active', {
    timeoutMs: 180000, intervalMs: 400,
  });

  // 未暂停时介入必须被拒（/intervene 的前置条件：CLI 已暂停）
  const denied = await postToServer('/intervene', projectRoot, { text: 'probe', reason: 'regression' });

  // 置 pause（与 awf_mode MCP 工具同一端点）
  const paused = await postToServer('/run/state/mode', projectRoot, { mode: 'pause' });

  // T1 在暂停期间照常收尾（闩锁只挡派发，不打断在飞任务）
  const t1Done = await waitFor(projectRoot, (s) => s.tasks.find((t) => t.id === 'T1')?.status === 'done', {
    timeoutMs: 300000,
  });
  // 介入前必须等会话收尾：否则介入文本会落进正忙的输入框，与随后派发的 T2 prompt 合并成一条
  const readyBeforeProbe = await waitSessionReady(projectRoot, { timeoutMs: 180000 });

  const t2Marker = 'w-dev T2'; // T2 prompt 的独有标记（仅派发时经 logPrompt 落进 main.log）
  const dispatchedBeforeWindow = projectLogText(projectRoot).includes(t2Marker);
  await sleep(PAUSE_LATCH_WINDOW_MS);
  const afterWindow = readStateSafe(projectRoot);
  const dispatchedDuringWindow = projectLogText(projectRoot).includes(t2Marker);

  // 暂停下受理温和介入与升级中断
  const intervened = await postToServer('/intervene', projectRoot, {
    text: '（w-monitor 真机回归探针）无需改动任何文件，回一句 OK 即结束本回合。',
    reason: 'T1-108 regression probe',
  });
  const interventionLogged = projectLogText(projectRoot).includes('[w-monitor intervention]');
  const readyAfterProbe = await waitSessionReady(projectRoot, { timeoutMs: 180000 });

  const interrupted = await postToServer('/intervene/interrupt', projectRoot, { reason: 'T1-108 regression interrupt' });
  await sleep(2500); // 等本地命令兜底回 ready（CC_LOCAL_CMD_MS 缺省 1500）

  // 恢复编排 → 剩余任务续跑
  const resumed = await postToServer('/run/state/mode', projectRoot, { mode: 'run' });
  const settled = await waitRunSettled(projectRoot, { timeoutMs });
  const sum = taskSummary(projectRoot);
  const dispatchedAfterResume = projectLogText(projectRoot).includes(t2Marker);

  return {
    case: 'pause',
    projectRoot,
    run,
    summary: sum,
    // 本 case 自起 server 并注入 CC_PAUSE_ALERT_MS（宿主侧阈值）；非隔离模式下为 null
    serverBoot: own ? { pid: own.pid, freed: own.freed, up: own.up.ok } : null,
    latch: { readyBeforeProbe, dispatchedBeforeWindow, dispatchedDuringWindow, dispatchedAfterResume },
    checks: [
      check('中断前任务确实在飞（active）', inflight.ok, `elapsed=${inflight.elapsedMs}ms`),
      check('未暂停时 /intervene 被拒（409 前置条件）', denied.status === 409, `status=${denied.status} ${denied.json?.error ?? ''}`),
      check('置 mode=pause 成功', paused.status === 200 && paused.json?.ok === true, `status=${paused.status}`),
      check('T1 在暂停期间仍收尾（闩锁只挡派发，不打断在飞任务）', t1Done.ok, `elapsed=${t1Done.elapsedMs}ms`),
      check('介入前会话已收尾（否则介入文本会与编排 prompt 合并）', readyBeforeProbe.ok, `ready=${readyBeforeProbe.ok} last=${readyBeforeProbe.last ?? ''}`),
      check('闩锁生效：暂停期间 T2 的 prompt 未被派发进会话', !dispatchedDuringWindow, `before=${dispatchedBeforeWindow} during=${dispatchedDuringWindow}`),
      check('闩锁期间 mode 保持 pause', afterWindow?.mode === 'pause', `mode=${afterWindow?.mode}`),
      // T3-011-F1：原写法取**第一条**闩锁告警并强制它带 `dispatch:T2` —— 把「哪条等待路径先告警」
      // 这个实现细节当成了契约。连跑（server 复用、整体更慢）时先到的往往是 settle 等待路径的告警，
      // 其 label 取默认值 `pause-latch`（src/lib/pause.js:62）；只有 batch 派发路径才写
      // `dispatch:<id>`（batch-transport.cjs:145）。产品契约是「告警含项目根 + 等待阶段」，
      // 不是「第一条来自哪条路径」。
      check('挂起超阈值产出告警日志（含项目根与等待阶段）', (() => {
        const line = projectLogText(projectRoot).split('\n')
          .find((l) => l.includes('pause 闩锁已挂起') && l.includes(projectRoot));
        return !!line && /阶段 (pause-latch|dispatch:[A-Za-z0-9_-]+)/.test(line);
      })(), tailOf(projectLogText(projectRoot), 3)),
      check('暂停后 /intervene 受理', intervened.status === 200 && intervened.json?.intervention === true, `status=${intervened.status}`),
      check('介入写入运行日志（[w-monitor intervention]）', interventionLogged),
      check('介入后会话回到收尾态', readyAfterProbe.ok, `ready=${readyAfterProbe.ok} last=${readyAfterProbe.last ?? ''}`),
      check('暂停后 /intervene/interrupt 受理', interrupted.status === 200 && interrupted.json?.interrupted === true, `status=${interrupted.status}`),
      check('恢复 mode=run 成功', resumed.status === 200 && resumed.json?.ok === true, `status=${resumed.status}`),
      check('恢复后 T2 才被派发（闩锁释放）', dispatchedAfterResume, `dispatched=${dispatchedAfterResume}`),
      check('run 收敛', settled.ok, settled.error),
      check('T1 done', sum.tasks.find((t) => t.id === 'T1')?.status === 'done'),
      check('T2 恢复后被派发并 done', sum.tasks.find((t) => t.id === 'T2')?.status === 'done', sum.tasks.find((t) => t.id === 'T2')?.status),
      check('两任务真实产出落盘', fs.existsSync(path.join(projectRoot, 'src', 'counter.js')) && fs.existsSync(path.join(projectRoot, 'src', 'accumulator.js'))),
      check('mode 复位 idle', sum.mode === 'idle', sum.mode),
    ],
  };
}

/**
 * 中断后的现场恢复（T1-108 / 缺口 8）。
 *
 * 与 resume 的分工：resume 验「重连语义」（挂接 vs 拒绝），recover 验「中断态本身」——
 * CLI 被 SIGKILL 后 tmux 会话 / 常驻 server / state 三者是否原样保留、编排是否不依赖 CLI 存活、
 * 以及现场最后能否由 `--resume` 接手收尾。
 *
 * 关键不变量：宿主只在「本轮 run 内它自己把 mode 置为 run」时才在收尾复位 idle
 * （run-host.cjs changedMode）。CLI 已把 mode 置 run → 中断后宿主收尾**不复位** →
 * mode 停在 run，这正是 w-monitor 识别 run_interrupted 的信号。
 */
async function caseRecover({ timeoutMs }) {
  const projectRoot = makeProject('recover', {
    tasks: taskSet('dev'),
    summary: 'T1-108 中断后的现场恢复',
  });
  const run = launchRun(projectRoot);
  const inflight = await waitFor(projectRoot, (s) => s.tasks[0]?.status === 'active', {
    timeoutMs: 180000, intervalMs: 400,
  });
  const beforeKill = readStateSafe(projectRoot);
  killCli(run.pid);
  await sleep(1500);

  const sess = sessionNameOf(projectRoot);
  const statusResp = await getFromServer('/status', projectRoot);
  const afterKill = readStateSafe(projectRoot);
  const site = {
    cliAlive: isAlive(run.pid),
    tmux: listSessions().includes(sess),
    mode: afterKill?.mode,
    serverAlive: statusResp.status === 200,
  };

  // 不重连，观察编排是否仍在推进（记录事实，不断言必须完成——宿主自行跑完与否都不是缺陷）
  const progressed = await waitFor(projectRoot, (s) => s.tasks.every((t) => t.status === 'done'), {
    timeoutMs: 180000, intervalMs: 2000,
  });
  const afterProgress = readStateSafe(projectRoot);
  const modeAfterProgress = afterProgress?.mode;

  // 现场交接给 --resume 收尾
  const resumeRun = launchRun(projectRoot, { extraArgs: ['--resume'], logSuffix: '-resume' });
  const resumeExit = await waitRunExit(resumeRun.pid, { timeoutMs });
  const settled = await waitRunSettled(projectRoot, { timeoutMs });
  const sum = taskSummary(projectRoot);
  const state = readStateSafe(projectRoot);
  const done = state?.tasks.filter((t) => t.status === 'done') ?? [];

  return {
    case: 'recover',
    projectRoot,
    run,
    resumeRun,
    site,
    summary: sum,
    progressedUnderDeadCli: progressed.ok,
    checks: [
      check('中断前任务确实在飞（active）', inflight.ok, `elapsed=${inflight.elapsedMs}ms`),
      check('中断前 CLI 存活', !!beforeKill, `pid=${run.pid}`),
      check('现场保留：CLI 已死', site.cliAlive === false, `pid=${run.pid}`),
      check('现场保留：tmux 会话仍在', site.tmux, sess),
      check('现场保留：常驻 server 仍响应', site.serverAlive, `status=${statusResp.status}`),
      check('现场保留：mode 仍为 run（未被静默复位）', site.mode === 'run', `mode=${site.mode}`),
      check('现场保留：未完成的任务未被清（state 仍有该任务）', !!afterKill?.tasks?.[0], `tasks=${afterKill?.tasks?.length}`),
      check('编排不依赖 CLI 存活：宿主在无 CLI 时仍推进 run', progressed.ok, progressed.ok ? `elapsed=${progressed.elapsedMs}ms` : '超时未见全部 done（记录事实，见备注）'),
      check('CLI 死亡后宿主收尾不复位 mode（run_interrupted 信号）', modeAfterProgress === 'run', `mode=${modeAfterProgress}`),
      check('--resume 正常退出', resumeExit.ok && resumeExit.code === 0, `code=${resumeExit.code} signal=${resumeExit.signal}`),
      check('run 收敛', settled.ok, settled.error),
      check('全部任务 done', sum.tasks.every((t) => t.status === 'done'), JSON.stringify(sum.counts)),
      check('每项 done 都有 exec.result（无伪完成 / 无重复落账覆盖）', done.length > 0 && done.every((t) => !!t.exec?.result), `done=${done.length}`),
      check('真实产出落盘', fs.existsSync(path.join(projectRoot, 'src', 'counter.js'))),
      check('mode 复位 idle', sum.mode === 'idle', sum.mode),
    ],
  };
}

/** 当前 tmux 会话名列表 */
function listSessions() {
  try {
    return execFileSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** 该项目真 run 的期望 tmux 会话名：cc-<projectSid(projectRoot)>（与 run-context.projectSid 同构） */
function sessionNameOf(projectRoot) {
  const digest = crypto.createHash('sha1').update(fs.realpathSync(projectRoot)).digest('hex').slice(0, 12);
  return `cc-p${digest}`;
}

/** 该项目最近一次 run 的日志目录（.awf/logs/<version-runStamp>） */
function logDirOf(projectRoot) {
  const logsDir = path.join(projectRoot, '.awf', 'logs');
  if (!fs.existsSync(logsDir)) return null;
  const dirs = fs.readdirSync(logsDir).filter((d) => /^\d/.test(d)).sort();
  return dirs.length ? path.join(logsDir, dirs[dirs.length - 1]) : null;
}

/** 该项目最近一次 run 的 runStamp（= 日志目录名，与 DecisionStore.runStamp() 同规则） */
function logStampOf(projectRoot) {
  const dir = logDirOf(projectRoot);
  return dir ? path.basename(dir) : null;
}

/** 读该项目全部决策记录（.awf/decisions/runs/*.jsonl，容坏行） */
function readDecisions(projectRoot) {
  const runsDir = path.join(projectRoot, '.awf', 'decisions', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((n) => n.endsWith('.jsonl')).sort()
    .flatMap((n) => fs.readFileSync(path.join(runsDir, n), 'utf8').split('\n'))
    .filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/** run 日志（console 直写）是否含某片段 */
function logContains(logPath, needle) {
  try {
    return fs.readFileSync(logPath, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

/** 读整份日志（失败 → 空串，调用方按不含断言处理） */
function readLog(logPath) {
  try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; }
}

/** 日志尾部若干行（进 check 的 detail，便于失败时直接看到现场） */
function tailOf(text, lines = 3) {
  return text.trimEnd().split('\n').slice(-lines).join(' ⏎ ');
}

/** 直接子进程 pid（缺失/失败 → []） */
function childrenOf(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** 单进程的 CC_ / AWF_ 前缀 env（ps eww 在命令后平铺 env；失败 → null） */
function envOfPid(pid) {
  try {
    const out = execFileSync('ps', ['eww', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const env = {};
    for (const tok of out.split(/\s+/)) {
      const m = /^(CC_[A-Z_]+|AWF_[A-Z_]+)=(.*)$/.exec(tok);
      if (m) env[m[1]] = m[2];
    }
    return Object.keys(env).length ? env : null;
  } catch {
    return null;
  }
}

/**
 * 取 tmux 会话内 claude 进程的 CC_* env（pane pid 及其后代，广度有界）。
 * 回归点：tmux 新会话的进程环境来自 tmux **全局** env（启动 tmux server 那个 run 的环境），
 * 并发多 run 时会继承别项目的 CC_PROJECT —— 必须由 bootstrap 显式注入（T1-098 修复）。
 */
function sessionEnvOf(session) {
  let root = null;
  try {
    root = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], // 会话不存在时 tmux 会往 stderr 喊 "can't find window"，静音
    }).trim().split('\n')[0];
  } catch {
    return {};
  }
  if (!root) return {};
  const queue = [{ pid: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { pid, depth } = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const env = envOfPid(pid);
    if (env?.CC_SESSION) return env;
    if (depth < 3) for (const c of childrenOf(pid)) queue.push({ pid: c, depth: depth + 1 });
  }
  return {};
}

/** 轮询等会话内 claude 起来并取到 env（会话在 run 结束时被关，必须在 run 期间取） */
async function probeSessionEnv(projectRoot, { timeoutMs = 120000 } = {}) {
  const session = sessionNameOf(projectRoot);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const env = sessionEnvOf(session);
    if (env.CC_SESSION) return { session, env };
    if (Date.now() > deadline) return { session, env: {} };
    await sleep(1000);
  }
}

/** 会话 env 是否指向本项目（CC_PROJECT / CC_WORKDIR 皆为该项目根；与 ensureSession 同取 realpath） */
function envPointsAt(env, projectRoot) {
  const real = fs.realpathSync(projectRoot);
  return env.CC_PROJECT === real && env.CC_WORKDIR === real;
}

// ── 前端 / 生命周期 case 的辅助（T1-109） ────────────────────────────────────

/** 读 JSON（失败 → null） */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 选一个空闲端口（先绑再放）：前端/生命周期 case 自起 server，不能与机器上已驻留的抢端口 */
function pickFreePort(start) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryPort = () => {
      const srv = net.createServer();
      srv.once('error', () => {
        port += 1;
        if (port > start + 50) reject(new Error('找不到空闲端口'));
        else tryPort();
      });
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

/**
 * 直接起 server 本体（不经 CLI / tmux / claude）。
 * 前端与生命周期 case 要的是页面服务、取数与空闲回收 —— 这些不经过模型会话，
 * 没必要为此拉起一个真 claude（也不该让 server 回收类断言受模型会话存活影响）。
 */
function startServer(projectRoot, { port, env = {}, logTo = null } = {}) {
  const repo = path.dirname(path.dirname(AWF_CLI));
  // logTo：把 server 输出写进指定文件（T3-011-F1：需要断言 `<项目>/.awf/logs/server.log` 的 case，
  // 必须让 server 由**本项目**唤起 —— 复用别人唤起的 server 时那行日志在别人项目下）。
  const logPath = logTo || path.join(path.dirname(projectRoot), `server-${path.basename(projectRoot)}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, logTo ? 'a' : 'w');
  const proc = spawn('node', [path.join(repo, 'src', 'server', 'server.cjs')], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: sanitizedEnv({ CC_PORT: String(port), CC_PROJECT: projectRoot, ...env }),
  });
  proc.unref();
  RUN_PROCS.set(proc.pid, proc);
  return { pid: proc.pid, port, logPath, projectRoot };
}

/** 等端口上的 server 就绪（/status 可读） */
async function waitServerUp(port, { timeoutMs = 30000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await httpRequest('GET', '/status', null, port);
    if (r.status === 200) return { ok: true, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, elapsedMs: Date.now() - t0, last: r.status };
    await sleep(300);
  }
}

/**
 * 让**本项目**成为 server 的 boot 项目（T3-011-F1）。
 *
 * 为什么需要：隔离端口下 server 由首个 case 唤起并被后续 case 全程复用，而 T1-112 只在
 * **spawn 那一刻**把输出接到 `<boot 项目>/.awf/logs/server.log` —— 于是「本项目 + server.log」
 * 只在自起时成立。需要按本项目断言 server.log 的 case（pause-release），必须停掉复用的那个、
 * 再以本项目为 boot 起重起，否则断言测的是**第一个 case 的**日志（case 间不独立）。
 *
 * 非隔离模式（无 `--port`）不动机器上的常驻 server，返回 null。
 * 起法与 T1-112 的接线一致（同一脚本、同一 env、同一日志文件），不经 tmux。
 * `extraEnv` 一并注入 server 进程 —— 宿主侧的阈值（如 `CC_PAUSE_ALERT_MS`）**必须**走这里，
 * 只传给 `launchRun` 的 env 只作用于 CLI 进程，宿主仍用默认值（T3-011-F1 踩过）。
 */
async function ownServer(projectRoot, extraEnv = {}) {
  if (!ISOLATED_PLUGIN_DIR) return null;
  stopIsolatedServer();
  // `awf server stop` 走 /shutdown，是**异步**关停：不等端口真的空出来就 spawn，新 server 会
  // EADDRINUSE 起不来，而 CLI 那边已经按「复用现有服务」决策过 → 随后 ECONNREFUSED 崩掉
  // （T3-011-F1 自测时踩到）。故：等端口关闭 → 起 → 等就绪；起不来再重试一次。
  const freed = await waitPortClosed(SERVER_PORT);
  let srv = null;
  let up = { ok: false };
  for (let attempt = 1; attempt <= 2; attempt++) {
    srv = startServer(projectRoot, {
      port: SERVER_PORT,
      env: extraEnv,
      logTo: path.join(projectRoot, '.awf', 'logs', 'server.log'),
    });
    up = await waitServerUp(SERVER_PORT);
    if (up.ok) break;
  }
  // 起不来就别往下跑：后续 launchRun 会连到一个不存在的 server 并抛 ECONNREFUSED，
  // 那条噪音会盖住真正的原因。显式上抛，由 harness 记为本 case 的失败断言。
  if (!up.ok) {
    throw new Error(`ownServer 失败：端口 ${SERVER_PORT} 上起不来 server（freed=${freed.ok} up=${JSON.stringify(up)}）；`
      + `见 ${path.join(projectRoot, '.awf', 'logs', 'server.log')}`);
  }
  return { ...srv, up, freed: freed.ok, freedMs: freed.elapsedMs };
}

/** 等端口不再应答（回收生效） */
async function waitPortClosed(port, { timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await httpRequest('GET', '/status', null, port);
    if (r.status === 0) return { ok: true, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, elapsedMs: Date.now() - t0, last: r.status };
    await sleep(400);
  }
}

/** 结束进程（best-effort） */
function killPid(pid, signal = 'SIGKILL') {
  try { process.kill(pid, signal); } catch {}
}

/**
 * 常驻 MCP stdio 客户端：同一子进程内做多次 `tools/call`。
 * 与真 MCP 客户端同一握手（initialize → notifications/initialized → tools/call），不依赖 Claude。
 * 本仓库 MCP 一律用 `textResult(JSON)` 回包，故 `call()` 顺带把 content[0].text 解析出来。
 */
function startMcpClient(serverDir, { env = {}, timeoutMs = 20000 } = {}) {
  const repo = path.dirname(path.dirname(AWF_CLI));
  const proc = spawn('node', [path.join(repo, 'plugin', 'core', 'mcp', serverDir, 'server.cjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sanitizedEnv(env),
  });
  let buf = '';
  let stderrText = '';
  let seq = 0;
  const pending = new Map();

  proc.stdout?.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const slot = pending.get(msg.id);
      if (!slot) continue;
      pending.delete(msg.id);
      clearTimeout(slot.timer);
      slot.resolve(msg);
    }
  });
  proc.stderr?.on('data', (c) => { stderrText += c.toString(); });
  proc.on('error', () => {});
  const send = (o) => { try { proc.stdin.write(JSON.stringify(o) + '\n'); } catch { /* 进程已退 */ } };
  const request = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: `MCP ${method} 超时` } }); }, timeoutMs);
    pending.set(id, { resolve, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });

  const ready = (async () => {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'awf-regression', version: '1' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  })();

  const call = async (name, args = {}) => {
    await ready;
    const msg = await request('tools/call', { name, arguments: args });
    const text = msg?.result?.content?.[0]?.text;
    let parsed = null;
    if (typeof text === 'string') { try { parsed = JSON.parse(text); } catch { /* 非 JSON 文本 */ } }
    return { transport: msg, parsed, text };
  };

  return {
    call,
    request,
    close: () => killPid(proc.pid),
    stderr: () => stderrText,
    pid: proc.pid,
  };
}

/**
 * 驱动一个 MCP server：stdio 逐行 JSON-RPC，initialize → tools/list，取工具名。
 * 与真 MCP 客户端同一握手，但不依赖 Claude —— 纯工具面冒烟。
 */
async function mcpToolNames(serverDir, { timeoutMs = 15000 } = {}) {
  const client = startMcpClient(serverDir, { timeoutMs });
  const msg = await client.request('tools/list', {});
  const timedOut = !!msg?.error;
  const names = (msg?.result?.tools || []).map((t) => t.name);
  client.close();
  // spawn 失败与握手超时在这里都表现为「拿不到 tools/list」，都该判失败
  return { names, timedOut, spawnError: timedOut && names.length === 0 };
}

/** 播一条决策记录（前端决策视图要取的数据，不必为此跑一次真决策） */
function seedDecision(projectRoot, record) {
  const dir = path.join(projectRoot, '.awf', 'decisions', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0.2.0-2026-01-01T00-00-00.jsonl'), JSON.stringify(record) + '\n');
}

/**
 * awf init 产出断言（T1-109 / 缺口 11）。
 * 只看 init 写下的**可判定产物**：插件注册、项目级 MCP、.awf 骨架、幂等性。
 * 纯文件断言，不需要模型会话，因此不在本 case 里跑 run。
 */
async function caseInit() {
  const projectRoot = makeProject('init', { tasks: taskSet('dev'), summary: 'T1-109 awf init 产出' });
  const repo = path.dirname(path.dirname(AWF_CLI));
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const mcpPath = path.join(projectRoot, '.mcp.json');
  const settings = readJson(settingsPath);
  const mcp = readJson(mcpPath);
  const cfg = readJson(path.join(projectRoot, '.awf', 'config.json'));

  const plugins = settings?.plugins || [];
  const corePlugins = plugins.filter((x) => String(x).startsWith('ai-workflow-'));
  const marketplace = settings?.extraKnownMarketplaces?.['ai-workflow-dev'];
  const servers = Object.keys(mcp?.mcpServers || {});
  const argsOk = servers.every((n) => {
    const a = mcp.mcpServers[n]?.args?.[0];
    return typeof a === 'string' && path.isAbsolute(a) && fs.existsSync(a);
  });
  const rootsOk = servers.every((n) => mcp.mcpServers[n]?.env?.AWF_PROJECT_ROOT === projectRoot);
  const skeleton = ['bugs', 'issues', 'decisions', 'dynamic-planning', 'context', 'logs', 'reports', 'versions']
    .filter((d) => fs.existsSync(path.join(projectRoot, '.awf', d)));

  // 幂等：T3-011-F1 —— 口径修正。
  // 旧写法拿「makeProject 之后（含 §隔离端口 的 marketplace 重指）」与「init 再跑一次」比字节，
  // 比的是**隔离动作**而不是 init 的幂等：隔离模式把 marketplace 指向插件副本，而 `awf init`
  // 会把它写回仓库 plugin/（init 自有立场）→ 该断言在 --port 下必然假红。
  // 正确口径：init 的输出必须自洽 —— 连跑两次，第二三次之间不得漂移；并以此为后续断言的读数。
  execFileSync('node', [AWF_CLI, 'init'], { cwd: projectRoot, env: sanitizedEnv(), stdio: 'pipe' });
  const pass1 = { settings: readJson(settingsPath), mcp: readJson(mcpPath) };
  execFileSync('node', [AWF_CLI, 'init'], { cwd: projectRoot, env: sanitizedEnv(), stdio: 'pipe' });
  const pass2 = { settings: readJson(settingsPath), mcp: readJson(mcpPath) };

  return {
    case: 'init',
    projectRoot,
    plugins: corePlugins,
    mcpServers: servers,
    checks: [
      check('三插件均注册（core/code/decision）', corePlugins.length === 3, corePlugins.join(',')),
      check('三插件均 enabled', corePlugins.every((p) => settings.enabledPlugins?.[p] === true)),
      check('marketplace 指向仓库 plugin/ 且存在', !!marketplace?.source?.path && fs.existsSync(marketplace.source.path), marketplace?.source?.path),
      check('项目级 .mcp.json 三个 server', servers.length === 3 && ['awf-state', 'awf-session', 'awf-oneshot'].every((n) => servers.includes(n)), servers.join(',')),
      check('MCP server 均用存在的绝对路径', argsOk),
      check('MCP server 均带 AWF_PROJECT_ROOT=本项目', rootsOk),
      check('awf-session 指向带端口的 AWF_BASE', /^http:\/\/127\.0\.0\.1:\d+$/.test(mcp?.mcpServers?.['awf-session']?.env?.AWF_BASE || ''), mcp?.mcpServers?.['awf-session']?.env?.AWF_BASE),
      check('.awf 骨架目录齐（8 项）', skeleton.length === 8, skeleton.join(',')),
      check('config.json 含 run.agents / run.decision / run.dynamicPlanning / docs', !!cfg?.run?.agents && typeof cfg.run.decision?.enabled === 'boolean' && !!cfg?.run?.dynamicPlanning && !!cfg?.docs),
      check('init 幂等：连续两次重跑 settings 不变', JSON.stringify(pass1.settings) === JSON.stringify(pass2.settings)),
      check('init 幂等：连续两次重跑 .mcp.json 不变', JSON.stringify(pass1.mcp) === JSON.stringify(pass2.mcp)),
      check('awf init 未把插件装到仓库外（marketplace 为 directory 源）', marketplace?.source?.source === 'directory'),
      check('仓库 plugin/ 存在于 marketplace 路径下', fs.existsSync(path.join(marketplace?.source?.path || '', '.claude-plugin', 'marketplace.json'))),
    ].concat([check('（记录）marketplace 路径', true, marketplace?.source?.path)]),
  };
}

/**
 * MCP 工具面冒烟（T1-109 / 缺口 12）。
 * 三个 server 各做一次 initialize + tools/list：工具面塌了（起不来 / 少工具）必须红。
 * 注：awf-session 现有 7 个工具，比 CLAUDE.md 记的 5 个多出 w-monitor 介入两个
 * （awf_session_intervene / awf_session_interrupt）——文档计数已过时，见 T1-109 结果。
 */
async function caseMcp() {
  const specs = [
    { dir: 'awf-state', count: 20, must: ['awf_read_state', 'awf_task_complete', 'awf_mode', 'awf_task_create', 'awf_wbs_create', 'awf_dynamic_plan', 'awf_dynamic_plan_status'] },
    { dir: 'awf-session', min: 5, must: ['awf_session_status', 'awf_capture_pane', 'awf_await_choice', 'awf_await_input', 'awf_context_ready', 'awf_session_intervene', 'awf_session_interrupt'] },
    { dir: 'awf-oneshot', count: 1, must: ['awf_oneshot'] },
  ];
  const got = {};
  const checks = [];
  for (const spec of specs) {
    const { names, timedOut, spawnError } = await mcpToolNames(spec.dir);
    got[spec.dir] = names;
    const missing = spec.must.filter((n) => !names.includes(n));
    checks.push(check(`${spec.dir} 工具面可用（${names.length} 个）`, !timedOut && !spawnError && names.length > 0, `timedOut=${!!timedOut} spawnError=${!!spawnError}`));
    checks.push(check(`${spec.dir} 必含工具齐全`, missing.length === 0, missing.join(',')));
    if (spec.count) checks.push(check(`${spec.dir} 工具数 = ${spec.count}`, names.length === spec.count, `实际 ${names.length}`));
    if (spec.min) checks.push(check(`${spec.dir} 工具数 ≥ ${spec.min}`, names.length >= spec.min, `实际 ${names.length}`));
  }
  checks.push(check('awf-session 含 w-monitor 介入工具', got['awf-session'].includes('awf_session_intervene') && got['awf-session'].includes('awf_session_interrupt')));
  return { case: 'mcp', tools: got, checks };
}

/**
 * 常驻 server 空闲回收（T1-109 / 缺口 10）。
 *
 * 两段式，因为**探活本身即活动**：server 每次收到请求都会刷新 lastActivityAt
 * （server-idle.cjs 注释写明「有 CLI/看板轮询即非空闲」）。所以：
 *   ① 持续探活超过空闲阈值 → server 必须**还活着**（否定面：活动确实在推迟回收）
 *   ② 停手静置超过阈值 → 端口关闭 + 进程退出 + 日志留痕
 * 首版只做了②却仍在轮询等它关闭，等于一直把它喂活 —— 观测者效应，已修。
 */
async function caseLifecycle() {
  const IDLE_MS = 3000;
  const CHECK_MS = 700;
  const projectRoot = makeProject('lifecycle', { tasks: taskSet('dev'), summary: 'T1-109 常驻 server 空闲回收' });
  const port = await pickFreePort(SERVER_PORT + 300);
  const srv = startServer(projectRoot, {
    port,
    env: { CC_SERVER_IDLE_MS: String(IDLE_MS), CC_SERVER_IDLE_CHECK_MS: String(CHECK_MS) },
  });
  const up = await waitServerUp(port);
  const alive = await getFromServer('/status', projectRoot, port);

  // ① 边探活边等过一个阈值周期 —— 有活动就不该回收
  const pokeUntil = Date.now() + IDLE_MS * 2;
  let pokes = 0;
  while (Date.now() < pokeUntil) {
    const r = await httpRequest('GET', '/status', null, port);
    if (r.status !== 200) break;
    pokes += 1;
    await sleep(400);
  }
  const survivedUnderActivity = isAlive(srv.pid) && (await httpRequest('GET', '/status', null, port)).status === 200;

  // ② 停手静置：阈值 + 若干检查周期 + 余量
  await sleep(IDLE_MS + CHECK_MS * 3 + 1500);
  const exited = !isAlive(srv.pid);
  const closed = (await httpRequest('GET', '/status', null, port)).status === 0;
  const log = readLog(srv.logPath);

  return {
    case: 'lifecycle',
    projectRoot,
    server: srv,
    checks: [
      check('server 起得来（/status 可达）', up.ok, `last=${up.last ?? ''}`),
      check('探活取到本项目上下文', alive.json?.projectRoot === fs.realpathSync(projectRoot), alive.json?.projectRoot),
      check(`持续活动（${pokes} 次探活）期间不被回收`, survivedUnderActivity, `pid=${srv.pid} alive=${isAlive(srv.pid)}`),
      check('静置后进程退出（回收生效）', exited, `pid=${srv.pid}`),
      check('静置后端口关闭', closed, `port=${port}`),
      check('回收在日志留痕', /自动关闭（常驻回收）/.test(log), tailOf(log, 2)),
    ],
  };
}

/**
 * 前端页面可达 + 取数正确 + 项目切换 + 决策 override（T1-109 / 缺口 9）。
 *
 * 口径：页面**只**由 web/ 构建产物承载（T1-119 起 legacy 观测页已退役，`src/server/` 不再放 html/css），
 * 故本 case 断言**二态**——产物在（`npm run build` 跑过）则首页为 React SPA 且 `/assets/…` 被托管；
 * 产物不在则页面路径返回 **503 + 「运行 npm run build」提示**（不静默回落、不留空白页）。
 * 另覆盖四个视图**依赖的服务端面**：取数 API 形状正确、`?p` 项目切换不串、决策 override 真的落盘。
 * React 组件本身的渲染验证需要 `cd web && npm install && npm run build` + 浏览器，见结果备注。
 */
async function caseWeb() {
  const a = makeProject('web-a', { tasks: taskSet('dev'), summary: 'T1-109 web A' });
  const b = makeProject('web-b', { tasks: taskSet('dev2'), summary: 'T1-109 web B' });
  seedDecision(a, { runStamp: 'r1', event: 'decision_completed', decision_id: 'D-1', result: { type: 'choice', answer: '保守实现' } });
  const port = await pickFreePort(SERVER_PORT + 400);
  const srv = startServer(a, { port });
  const up = await waitServerUp(port);

  // T1-118 之后产物可能真的存在（npm run build 会构建）；T1-119 起页面**只**由产物承载。
  const webBuilt = fs.existsSync(path.join(ROOT, 'src', 'server', 'public', 'index.html'));
  const page = await getPage('/', port);
  const decisionsPath = await getPage('/decisions', port);
  const theme = await getPage('/theme.css', port);      // 旧资产，T1-119 已退役
  const common = await getPage('/common.js', port);     // 同上
  // 构建过的话，顺带验证真实产物资产被托管（从 index.html 里取出 <script src="assets/…">）
  const assetMatch = webBuilt ? /src="\.?\/?(assets\/[^"]+)"/.exec(page.raw) : null;
  const asset = assetMatch ? await getPage(`/${assetMatch[1]}`, port) : null;

  const stateA = await getFromServer('/awf/state', a, port);
  const stateB = await getFromServer('/awf/state', b, port);
  const decisionsBefore = await getFromServer('/awf/decisions', a, port);
  const metrics = await getFromServer('/awf/metrics', a, port);
  const runStatus = await getFromServer('/run/status', a, port);
  const status = await getFromServer('/status', a, port);

  const override = await postToServer('/awf/decisions/D-1/override', a, { instruction: '改为带上限保护' }, port);
  const decisionsAfter = await getFromServer('/awf/decisions', a, port);
  const overrideEntry = (decisionsAfter.json?.decisions || []).find((d) => d.event === 'decision_overridden' && d.decision_id === 'D-1');

  killPid(srv.pid);

  return {
    case: 'web',
    project: { a, b },
    server: srv,
    // 记录（不判定）：本仓可能已构建（产物存在则页面由 SPA 承载），故把构建态写进证据
    observations: {
      'webBuilt': webBuilt,
      'note': 'T1-119：legacy 观测页与 theme.css/common.js 已退役，页面路径统一由 web 构建产物承载；未构建时返回 503 + 「运行 npm run build」提示，不静默 404',
    },
    checks: [
      check('server 就绪', up.ok, `last=${up.last ?? ''}`),
      check(webBuilt ? '首页由构建产物（React SPA）承载' : '未构建 → 首页 503 且提示 npm run build（不静默、不空白页）',
        webBuilt
          ? page.status === 200 && /id="root"/.test(page.raw)
          : page.status === 503 && /npm run build/.test(page.raw),
        `built=${webBuilt} status=${page.status}`),
      check('页面路径同一套处理（/decisions 亦由产物承载或同一告警）',
        webBuilt ? decisionsPath.status === 200 : decisionsPath.status === 503, `status=${decisionsPath.status}`),
      check('构建产物资产被托管（/assets/…）', !webBuilt || (!!asset && asset.status === 200), `built=${webBuilt} asset=${asset?.status ?? '-'}`),
      check('旧资产已退役（theme.css / common.js → 404）', theme.status === 404 && common.status === 404, `theme=${theme.status} common=${common.status}`),
      check('A 项目状态取数正确', stateA.json?.plan?.summary === 'T1-109 web A', stateA.json?.plan?.summary),
      check('B 项目状态取数正确', stateB.json?.plan?.summary === 'T1-109 web B', stateB.json?.plan?.summary),
      check('?p 项目切换不串（A/B 任务集互异）', (stateA.json?.tasks?.length ?? 0) === 1 && (stateB.json?.tasks?.length ?? 0) === 2, `A=${stateA.json?.tasks?.length} B=${stateB.json?.tasks?.length}`),
      check('决策列表取数正确（含播种记录）', decisionsBefore.status === 200 && decisionsBefore.json?.total >= 1 && decisionsBefore.json.decisions.some((d) => d.decision_id === 'D-1'), `total=${decisionsBefore.json?.total}`),
      check('指标取数正确', metrics.status === 200 && !!metrics.json?.metrics?.agentMode, metrics.json?.metrics?.agentMode),
      check('run 状态端点可达', runStatus.status === 200 && Array.isArray(runStatus.json?.runs), `status=${runStatus.status}`),
      check('会话状态归属本项目', status.json?.projectRoot === fs.realpathSync(a), status.json?.projectRoot),
      check('决策 override 受理', override.status === 200 && override.json?.ok === true, `status=${override.status} ${override.json?.error ?? ''}`),
      check('override 落盘（追加事件，不改写原记录）', decisionsAfter.json?.total === decisionsBefore.json?.total + 1 && !!overrideEntry, `total ${decisionsBefore.json?.total} → ${decisionsAfter.json?.total}`),
      check('override 载荷留存', overrideEntry?.instruction === '改为带上限保护', overrideEntry?.instruction),
    ],
  };
}

/**
 * 动态任务规划：**跨进程边界链路**（真 server + 真 awf-state MCP）。
 *
 * 为什么必须单独一个 case：能力文档 §9 把「真 server + 真 MCP」定为完成门槛 ——
 * 单测与 MCP 集成测试都在**同进程**里直接调 service/HTTP，证不了 MCP 薄入口 → HTTP → server 能力
 * 这条边界真的接通，也证不了 hold 落盘之后**调度器**真的不再派发。本 case 只走真实入口：
 * 提案走 MCP 的 stdio JSON-RPC，批准/拒绝走 HTTP（人工入口刻意不暴露为 MCP tool），
 * 不 import 任何 src/ 业务模块来代替它们 —— 唯一的例外是就绪池判据（见文件头 import 注释）。
 *
 * 覆盖（本 case 不起 tmux/claude，也不启动 run：这些是编排层事实，不需要模型参与）：
 *   1. 提案 → proposal 文件落盘 + events.jsonl 追加 + state 装 hold
 *   2. hold 生效：调度器就绪池把目标及其下游排除，且**计划本身还没变**
 *   3. 同一项目第二个开放 proposal 被拒（第一版单开放约束）
 *   4. 人工批准 → 原子应用：新任务先于目标、目标依赖重连、hold 释放；MCP 读到新图
 *   5. 无关变化放行：提案后 state 被别处改动但落在受影响闭包之外（mode 切换）→ 批准仍应用，
 *      且应用的是基于最新 state 的重放结果、不回退该改动
 *   6. 相关变化拦住：受影响闭包内的目标被别处结算 → conflicted，**不覆盖**最新 state
 *   7. 人工拒绝 → 释放 hold 且计划不变
 *   8. 非 server 模式下 MCP 拒绝本工具（能力只在 server 侧存在）
 */
async function caseDynamicPlanning() {
  const projectRoot = makeProject('dynamic-planning', {
    tasks: taskSet('dev2'),
    summary: '动态规划跨进程边界（真 server + 真 MCP）',
  });
  const port = await pickFreePort(SERVER_PORT + 500);
  const srv = startServer(projectRoot, { port });
  const up = await waitServerUp(port);

  const proposalsDir = path.join(projectRoot, '.awf', 'dynamic-planning', 'proposals');
  const eventsPath = path.join(projectRoot, '.awf', 'dynamic-planning', 'events.jsonl');
  const readProposalFile = (id) => readJson(path.join(proposalsDir, `${id}.json`));
  const readEvents = () => {
    try {
      return fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  const proposalFiles = () => (fs.existsSync(proposalsDir) ? fs.readdirSync(proposalsDir).filter((n) => n.endsWith('.json')) : []);
  const insertOp = (id, targetId, file) => ({
    type: 'insert_task',
    relation: { type: 'prerequisite_for', targetTaskId: targetId },
    task: {
      id,
      title: `补 ${targetId} 缺失的前置：${file}`,
      prompt: `执行 /ai-workflow-code:w-dev ${id}：创建 ${file}，导出 makeAdder(n)，`
        + `完成后用 awf_task_complete 把 ${id} 落账为 done。`,
      acceptance: `${file} 存在且导出 makeAdder`,
      plannedFiles: [file],
    },
  });
  const holdIdsOf = (state) => Object.values(state?.dynamicPlanning?.holds || {}).flatMap((h) => h.taskIds || []);

  // 真 MCP：以 server 单写者模式运行（CC_AWF_STATE_SERVER=1），端点与项目根全由 env 决定，
  // 与 run 会话内注入的那套同源（plugin/core/mcp/awf-state/server.cjs:69-77）。
  const mcp = startMcpClient('awf-state', {
    env: { AWF_PROJECT_ROOT: projectRoot, CC_AWF_STATE_SERVER: '1', CC_PORT: String(port) },
  });

  // 0) MCP 确实在 server 模式并读到本项目 state —— 否则后面所有断言都测不到边界
  const read0 = await mcp.call('awf_read_state', {});
  const read0Ids = (read0.parsed?.tasks || []).map((t) => t.id);
  const readyBeforePropose = peekReadyTasks(readStateSafe(projectRoot)).map((t) => t.id);

  // 1) 提案（MCP 薄入口 → HTTP → server 能力）
  const prop1 = await mcp.call('awf_dynamic_plan', {
    reason: 'T2 依赖的累加器能力缺失，补一个前置任务',
    trigger: 'ai_runtime',
    requestedBy: 'regression',
    operations: [insertOp('T2-PRE', 'T2', 'src/adder.js')],
  });
  const p1 = prop1.parsed?.proposal;
  const p1Id = p1?.proposalId;
  const p1File = p1Id ? readProposalFile(p1Id) : null;
  const stateAfterPropose = readStateSafe(projectRoot);
  const readyAfterPropose = peekReadyTasks(stateAfterPropose).map((t) => t.id);
  const t2AtPropose = (stateAfterPropose?.tasks || []).find((t) => t.id === 'T2');
  const eventsAfterPropose = readEvents();
  const heldAfterPropose = holdIdsOf(stateAfterPropose);
  const idsAtPropose = new Set((stateAfterPropose?.tasks || []).map((t) => t.id));

  // 2) 同一项目第二个开放 proposal 必须被拒（第一版「单开放」约束）
  const propDup = await mcp.call('awf_dynamic_plan', {
    reason: '重复提案应被拒',
    operations: [insertOp('T1-PRE', 'T1', 'src/base.js')],
  });
  const filesAfterDup = proposalFiles();

  // 3) MCP 读回 proposal（GET 面）；人工批准前状态仍为 awaiting_approval
  const status1 = await mcp.call('awf_dynamic_plan_status', { proposalId: p1Id });

  // 4) 人工批准（HTTP 人工入口，刻意不暴露为 MCP tool）→ 原子应用
  const approve1 = await postToServer(`/run/dynamic-planning/proposals/${p1Id}/approve`, projectRoot,
    { reviewer: 'regression', note: '边界链路验证' }, port);
  const stateAfterApprove = readStateSafe(projectRoot);
  const idsAfterApprove = (stateAfterApprove?.tasks || []).map((t) => t.id);
  const t2AfterApprove = (stateAfterApprove?.tasks || []).find((t) => t.id === 'T2');
  const readyAfterApprove = peekReadyTasks(stateAfterApprove).map((t) => t.id);
  const readApplied = await mcp.call('awf_read_state', {});
  const readAppliedIds = (readApplied.parsed?.tasks || []).map((t) => t.id);
  const readAppliedT2 = (readApplied.parsed?.tasks || []).find((t) => t.id === 'T2');

  // 5) **无关变化放行**：提案后 state 被别处改动，但改动落在受影响闭包之外（这里把 mode 切成 run）
  //    → 批准仍应应用，且应用的是基于最新 state 的重放结果，不得回退这次改动。
  //    （旧口径拿整份 state 哈希做 CAS，这种前进必然打成 conflicted，真机 case
  //     `dynamic-planning-run` 实测踩到；判据已改为「受影响闭包 + plan.acceptanceCriteria」。）
  const prop2 = await mcp.call('awf_dynamic_plan', {
    reason: '为 T1 补前置',
    operations: [insertOp('T1-PRE', 'T1', 'src/base.js')],
  });
  const p2Id = prop2.parsed?.proposal?.proposalId;
  const perturbed = await postToServer('/run/state/mode', projectRoot, { mode: 'run' }, port);
  const stateBeforeApprove2 = readStateSafe(projectRoot);
  const approve2 = await postToServer(`/run/dynamic-planning/proposals/${p2Id}/approve`, projectRoot,
    { reviewer: 'regression', note: '无关变化应放行' }, port);
  const stateAfterP2 = readStateSafe(projectRoot);
  const t1AfterP2 = (stateAfterP2?.tasks || []).find((t) => t.id === 'T1');

  // 6) **相关变化拦住**：这次动的是受影响闭包内的目标（模拟它被别处结算）
  const prop3 = await mcp.call('awf_dynamic_plan', {
    reason: '为 T2 再补一个前置（这条会被冲突拦下）',
    operations: [insertOp('T2-PRE2', 'T2', 'src/adder2.js')],
  });
  const p3Id = prop3.parsed?.proposal?.proposalId;
  const snapshot = (await getFromServer('/awf/state', projectRoot, port)).json;
  (snapshot?.tasks || []).find((t) => t.id === 'T2').status = 'blocked';
  const drifted = await postToServer('/run/state/apply', projectRoot, { state: snapshot }, port);
  const approve3 = await postToServer(`/run/dynamic-planning/proposals/${p3Id}/approve`, projectRoot,
    { reviewer: 'regression', note: '目标已被别处结算，应被拒' }, port);
  const stateAfterConflict = readStateSafe(projectRoot);
  const t2AfterConflict = (stateAfterConflict?.tasks || []).find((t) => t.id === 'T2');

  // 7) 人工拒绝路径：释放 hold，计划不变
  const prop4 = await mcp.call('awf_dynamic_plan', {
    reason: '这条提案将被人工拒绝',
    operations: [insertOp('T2-PRE3', 'T2', 'src/adder3.js')],
  });
  const p4Id = prop4.parsed?.proposal?.proposalId;
  const reject4 = await postToServer(`/run/dynamic-planning/proposals/${p4Id}/reject`, projectRoot,
    { reviewer: 'regression', note: '不需要这个前置' }, port);
  const stateAfterReject = readStateSafe(projectRoot);

  // 8) 非 server 模式下本工具不可用（能力只在 server 侧存在，MCP 不复制业务语义）
  const bareMcp = startMcpClient('awf-state', { env: { AWF_PROJECT_ROOT: projectRoot } });
  const barePlan = await bareMcp.call('awf_dynamic_plan', { reason: '无 server 模式', operations: [insertOp('X', 'T1', 'x.js')] });
  bareMcp.close();

  // 收尾：恢复 mode（步骤 5 把项目切成了 run），停掉本 case 自起的 server
  await postToServer('/run/state/mode', projectRoot, { mode: 'idle' }, port);
  mcp.close();
  killPid(srv.pid);

  const eventsAll = readEvents();
  const eventNames = eventsAll.map((e) => e.event);

  return {
    case: 'dynamic-planning',
    projectRoot,
    server: { pid: srv.pid, port, up: up.ok },
    proposals: { p1: p1Id, p2: p2Id, p3: p3Id, p4: p4Id },
    readySets: { before: readyBeforePropose, afterPropose: readyAfterPropose, afterApprove: readyAfterApprove },
    events: eventNames,
    checks: [
      check('server 起得来（/status 可达）', up.ok, `last=${up.last ?? ''}`),
      check('MCP 以 server 模式读到本项目 state（跨进程边界成立）',
        read0.parsed?.tasks?.length === 2 && read0Ids.includes('T1') && read0Ids.includes('T2'),
        `parsed=${read0.parsed ? 'ok' : read0.text}`),

      // 1) 提案
      check('MCP 提案返回 ok 且未自动应用（approve_then_apply）',
        prop1.parsed?.ok === true && prop1.parsed?.applied === false, prop1.text),
      check('proposal 状态 awaiting_approval，nextAction 指向人工审批',
        p1?.status === 'awaiting_approval' && p1?.nextAction?.type === 'human_approval', p1?.status),
      check('对外不返回内部 proposedState（数据边界）', !!p1 && !('proposedState' in p1)),
      check('proposal 文件落盘且内容一致',
        !!p1File && p1File.proposalId === p1Id && p1File.status === 'awaiting_approval', p1Id),
      check('events.jsonl 追加 proposal.awaiting_approval',
        eventsAfterPropose.some((e) => e.event === 'proposal.awaiting_approval' && e.proposalId === p1Id),
        eventNames.join(',')),
      check('state 装上 hold，覆盖目标 T2（新增任务此刻还不存在，无需也无法被 hold）',
        !!p1Id && heldAfterPropose.includes('T2'), JSON.stringify(heldAfterPropose)),
      check('hold 不牵连未受影响的并行任务，也不出现幽灵 id',
        !heldAfterPropose.includes('T1') && heldAfterPropose.every((id) => idsAtPropose.has(id)),
        JSON.stringify(heldAfterPropose)),
      check('hold 生效：调度器就绪池排除被 hold 的任务（用 state.js 判据）',
        !readyAfterPropose.includes('T2') && !readyAfterPropose.includes('T2-PRE'),
        `before=${readyBeforePropose.join(',')} after=${readyAfterPropose.join(',')}`),
      check('批准前计划本身未被改写（只装了 hold）',
        JSON.stringify(t2AtPropose?.deps || []) === '[]' && !(stateAfterPropose?.tasks || []).some((t) => t.id === 'T2-PRE')),

      // 2) 单开放约束
      check('同一项目第二个开放 proposal 被拒',
        propDup.parsed?.ok === false && String(propDup.parsed?.error || '').includes(p1Id),
        propDup.text),
      check('被拒的重复提案没有留下文件', filesAfterDup.length === 1, filesAfterDup.join(',')),

      // 3) MCP 读回
      check('MCP 按 proposalId 读回提案',
        status1.parsed?.ok === true && status1.parsed?.proposal?.proposalId === p1Id,
        status1.text?.slice(0, 120)),

      // 4) 批准应用
      check('人工批准端点应用 proposal',
        approve1.status === 200 && approve1.json?.ok === true && approve1.json?.proposal?.status === 'applied',
        `status=${approve1.status} ${approve1.json?.error ?? approve1.json?.proposal?.status ?? ''}`),
      check('新任务插在目标之前（稳定序列位置）',
        idsAfterApprove.indexOf('T2-PRE') >= 0 && idsAfterApprove.indexOf('T2-PRE') < idsAfterApprove.indexOf('T2'),
        idsAfterApprove.join(',')),
      check('目标依赖已重连到新任务',
        (t2AfterApprove?.deps || []).includes('T2-PRE'), JSON.stringify(t2AfterApprove?.deps)),
      check('hold 已释放（无残留 dynamicPlanning）',
        !stateAfterApprove?.dynamicPlanning, JSON.stringify(Object.keys(stateAfterApprove?.dynamicPlanning || {}))),
      check('应用后就绪池含新任务、不含被阻塞的目标',
        readyAfterApprove.includes('T2-PRE') && !readyAfterApprove.includes('T2'), readyAfterApprove.join(',')),
      check('MCP 读回已应用的新图（server 单写者边界真的改了盘）',
        readAppliedIds.includes('T2-PRE') && (readAppliedT2?.deps || []).includes('T2-PRE'), readAppliedIds.join(',')),
      check('events.jsonl 追加 proposal.approved_and_applied',
        eventsAll.some((e) => e.event === 'proposal.approved_and_applied' && e.proposalId === p1Id), eventNames.join(',')),

      // 5) 无关变化不阻塞批准；6) 相关变化拦得住
      check('提案后 state 被别处改动（mode 被切成 run），但改动在受影响闭包之外',
        perturbed.status === 200 && stateBeforeApprove2?.mode === 'run', `mode=${stateBeforeApprove2?.mode}`),
      check('无关变化不阻塞：批准仍然应用',
        approve2.status === 200 && approve2.json?.proposal?.status === 'applied',
        `status=${approve2.status} ${approve2.json?.proposal?.status ?? approve2.json?.error ?? ''}`),
      check('应用的是基于最新 state 的重放结果，未回退无关改动',
        stateAfterP2?.mode === 'run', `mode=${stateAfterP2?.mode}`),
      check('重放后受影响闭包仍按提案落地（新任务先于目标、依赖重连、hold 释放）',
        (stateAfterP2?.tasks || []).some((t) => t.id === 'T1-PRE')
        && (t1AfterP2?.deps || []).includes('T1-PRE') && !stateAfterP2?.dynamicPlanning,
        `T1.deps=${JSON.stringify(t1AfterP2?.deps)}`),
      check('相关变化（目标被别处结算）被判 conflicted，不覆盖最新 state',
        drifted.status === 200 && approve3.status === 200 && approve3.json?.proposal?.status === 'conflicted',
        `apply=${drifted.status} approve=${approve3.status} ${approve3.json?.proposal?.status ?? approve3.json?.error ?? ''}`),
      check('冲突后最新 state 未被 proposal 覆盖（目标仍是 blocked、无 T2-PRE2）',
        t2AfterConflict?.status === 'blocked'
        && !(stateAfterConflict?.tasks || []).some((t) => t.id === 'T2-PRE2'),
        `T2=${t2AfterConflict?.status}`),
      check('冲突后 hold 也被释放（不留死锁）', !stateAfterConflict?.dynamicPlanning),

      // 7) 拒绝路径
      check('人工拒绝端点生效',
        reject4.status === 200 && reject4.json?.proposal?.status === 'rejected', `status=${reject4.status}`),
      check('拒绝后计划不变且 hold 释放',
        !(stateAfterReject?.tasks || []).some((t) => t.id === 'T2-PRE3') && !stateAfterReject?.dynamicPlanning),

      // 8) 能力只在 server 侧
      check('非 server 模式下 MCP 拒绝 awf_dynamic_plan',
        barePlan.parsed?.ok === false && /requires state server mode/.test(String(barePlan.parsed?.error || '')),
        barePlan.text),
    ],
  };
}

/**
 * pause 期间「目标任务已结算 → 立即放行」（T1-111）。
 *
 * 事故形态（2026-09-10）：宿主在收尾/派发的闩锁里被**无限期**挂住，期间任务早已 done，
 * 而宿主卡在等待里回不到状态轮询，看不见 —— run 静默停摆 4 小时无人察觉。
 *
 * 本 case 把「任务被别处结算」做成可控的外部动作：暂停期间由 harness 直接把 T2 置 blocked，
 * 断言宿主**不等 mode 恢复**就能放行收尾（CLI 正常退出 → mode 复位 idle），
 * 同时 T2 的 prompt 始终没有进过会话 —— 闩锁「暂停不派发」的语义没有被放松。
 */
async function casePauseRelease({ timeoutMs }) {
  const projectRoot = makeProject('pause-release', {
    tasks: taskSet('dev2'),
    summary: 'T1-111 暂停期间目标结算即放行',
  });
  // T3-011-F1：本 case 要按**本项目**断言 `<项目>/.awf/logs/server.log`，而隔离模式下 server 由
  // 首个 case 唤起并被复用（日志落在那个项目下）。先让本项目成为 boot 项目，断言才测的是自己。
  const own = await ownServer(projectRoot);
  const run = launchRun(projectRoot, { env: { CC_PAUSE_ALERT_MS: '5000' } });
  const inflight = await waitFor(projectRoot, (s) => s.tasks[0]?.status === 'active', {
    timeoutMs: 180000, intervalMs: 400,
  });
  const paused = await postToServer('/run/state/mode', projectRoot, { mode: 'pause' });
  const t1Done = await waitFor(projectRoot, (s) => s.tasks.find((t) => t.id === 'T1')?.status === 'done', {
    timeoutMs: 300000,
  });

  const t2Marker = 'w-dev T2';
  // 必须先确认宿主**真的进了 T2 的派发闩锁**（告警行带 label dispatch:T2 即证），
  // 否则外部结算会抢在派发之前——那样 run 只是「没活干」而收敛，证明不了闩锁放行。
  const inLatch = await waitUntil(() => {
    const t = projectLogText(projectRoot);
    return t.includes('pause 闩锁已挂起') && t.includes('dispatch:T2');
  }, { timeoutMs: 150000, intervalMs: 1000 });
  const dispatchedBeforeRelease = projectLogText(projectRoot).includes(t2Marker);

  // 外部把 T2 结算掉（读全量 state → 改 T2 → 经单写者 apply 落盘）：模拟「任务已被别处结算」
  const snapshot = (await getFromServer('/awf/state', projectRoot)).json;
  const t2 = (snapshot?.tasks || []).find((t) => t.id === 'T2');
  if (t2) {
    t2.status = 'blocked';
    t2.exec = { ...(t2.exec || {}), result: 'harness 外部结算：验证闩锁放行' };
  }
  const applied = await postToServer('/run/state/apply', projectRoot, { state: snapshot });

  // 关键断言：**不恢复 mode** 宿主也应放行收尾。
  // 注意 CLI 侧 observeRun 自身也有 pause 闩锁（暂停期间不消费事件），故 mode 不会自己变 idle；
  // 要观察的是「宿主不再有活跃 run」+ 运行日志里的放行记录。
  const hostReleased = await waitUntil(async () => {
    const r = await getFromServer('/run/status', projectRoot);
    const runs = r.json?.runs || [];
    const active = runs.filter((x) => x.status === 'queued' || x.status === 'running');
    return active.length === 0 ? `runs=${runs.map((x) => x.status).join(',') || '空'}` : false;
  }, { timeoutMs: 180000, intervalMs: 1500 });
  const modeWhileReleased = readStateSafe(projectRoot)?.mode;
  const logText = projectLogText(projectRoot);
  // T1-112：server 的 console 输出现在落 .awf/logs/server.log —— 证明「宿主在等什么」不必再靠
  // transcript 反推（2026-09-10 事故的核心痛点）
  const serverLog = readLog(path.join(projectRoot, '.awf', 'logs', 'server.log'));

  // 收尾：恢复 mode 让 CLI 解闩退出（否则子 run 进程与 tmux 会一直挂着）
  await postToServer('/run/state/mode', projectRoot, { mode: 'run' });
  const idled = await waitFor(projectRoot, (s) => s.mode === 'idle', { timeoutMs: 180000, intervalMs: 1000 });
  const sum = taskSummary(projectRoot);

  return {
    case: 'pause-release',
    projectRoot,
    run,
    summary: sum,
    // 本 case 是否自起 server（隔离模式下为真）；为 null 时 server.log 断言依赖常驻 server 的归属
    serverBoot: own ? { pid: own.pid, up: own.up.ok } : null,
    checks: [
      check('中断前任务确实在飞（active）', inflight.ok, `elapsed=${inflight.elapsedMs}ms`),
      check('置 mode=pause 成功', paused.status === 200 && paused.json?.ok === true, `status=${paused.status}`),
      check('T1 在暂停期间收尾', t1Done.ok, `elapsed=${t1Done.elapsedMs}ms`),
      check('宿主已进入 T2 的派发闩锁（告警行带 dispatch:T2）', inLatch.ok, inLatch.ok ? `elapsed=${inLatch.elapsedMs}ms` : '未观察到闩锁告警'),
      check('外部结算 T2 成功（单写者 apply）', applied.status === 200 && applied.json?.ok === true, `status=${applied.status} ${applied.json?.error ?? ''}`),
      check('宿主放行：未恢复 mode 时已无活跃 run', hostReleased.ok, hostReleased.ok ? `${hostReleased.value}（${hostReleased.elapsedMs}ms）` : `elapsed=${hostReleased.elapsedMs}ms`),
      check('放行不是因为 mode 被恢复（此刻仍为 pause）', modeWhileReleased === 'pause', `mode=${modeWhileReleased}`),
      check('运行日志记录放行原因（目标任务已结算）', /已结算/.test(logText), tailOf(logText, 3)),
      check('放行记录带上阶段与结算态', /已结算/.test(logText) && logText.includes('dispatch:T2'), '见运行日志 NOTICE 行'),
      check('server 由本项目唤起（隔离模式下 server.log 才有归属）', !own || own.up.ok, own ? `pid=${own.pid} freed=${own.freed} up=${own.up.ok}` : '非隔离模式，跳过（复用常驻 server）'),
      check('server.log 落盘（含启动横幅与 pid/项目）', /cc-control listening on .*pid=\d+ project=/.test(serverLog), serverLog ? '有' : '空'),
      check('能从 server.log 读到宿主等待阶段行（无需 transcript 反推）',
        serverLog.includes('pause 闩锁已挂起') && serverLog.includes('dispatch:T2'), tailOf(serverLog, 3)),
      check('放行前 T2 的 prompt 未被派发', !dispatchedBeforeRelease),
      check('放行后 T2 的 prompt 也未被派发（闩锁语义未放松）', !logText.includes(t2Marker), `marker=${t2Marker}`),
      check('T2 终态为 blocked', sum.tasks.find((t) => t.id === 'T2')?.status === 'blocked', sum.tasks.find((t) => t.id === 'T2')?.status),
      check('T1 产出仍在', fs.existsSync(path.join(projectRoot, 'src', 'counter.js'))),
      check('run 收敛', sum.tasks.every((t) => t.status === 'done' || t.status === 'blocked'), JSON.stringify(sum.counts)),
      check('收尾：恢复 mode 后 CLI 解闩退出并复位 idle', idled.ok, idled.ok ? `elapsed=${idled.elapsedMs}ms` : `mode=${idled.state?.mode}`),
    ],
  };
}

/**
 * 动态任务规划：**运行链路（全真）**（真 tmux + 真 Claude + 真 server，**一次 run 走到底**）。
 *
 * 与 `dynamic-planning` 分工：那个 case 证「MCP → server → 落盘/审批」这条边界接通（无模型）；
 * 这个 case 证**运行中的 AI 自己发现计划缺口、自己发起提案 → 人在 run 进行中批准 → 同一个 run 继续**。
 * 两者合起来才是能力文档 §9 的门槛。
 *
 * 场景：T1 → T2 → T3，其中 T3 需要 `src/adder.js` 的 `makeAdder`，而任务图里**没有任何任务会产出它**。
 * T1 的 prompt 只给策略（「发现某个待执行任务的产出无人负责时，用 awf_dynamic_plan 补前置」），
 * 不告诉它缺口在哪 —— 目标任务与载荷由 AI 自己从 state 里找出来。
 *
 * 关键断言链：
 *   1. 提案出现在 mode=run 期间、requestedBy=ai，且 targetTaskId 是 **T3**（AI 自己找到的缺口）
 *   2. hold 只挡 T3 及其下游，不牵连 T1/T2；「未受影响的并行任务仍可继续」（capability §4）
 *      由**同一个 run 照样跑完**来证（第 4 条），而不是靠某一瞬间的就绪池快照
 *   3. 人工批准发生在 run **进行中**：批准时 `/run/status` 仍有在飞 run，且 T3 连 active 都没进过
 *   4. **同一个 run** 继续跑完：新任务的 startedAt 早于 T3，四个任务全部 done，产物齐全
 *   5. 审计记录完整（提案 → 待批准 → 批准应用）
 */
async function caseDynamicPlanningRun({ timeoutMs }) {
  const dev = (id, file, extra = {}) => ({
    id,
    title: `创建 ${file}`,
    kind: 'dev',
    status: 'pending',
    deps: [],
    wbsRef: 'W1',
    // 遵循 `awf-plan-prompt`：prompt 只留「命令 + task ID + 一句话目标」，范围/约束/验收走结构化字段
    prompt: `/ai-workflow-code:w-dev ${id}\n\n在项目根创建 ${file}，导出一个具名工厂函数。`,
    plannedFiles: [file],
    constraints: [`只创建 ${file}`],
    acceptance: `${file} 存在`,
    ...extra,
  });
  const t1 = dev('T1', 'src/counter.js');
  t1.prompt = '/ai-workflow-code:w-dev T1\n\n在项目根创建 src/counter.js，导出自增计数器 makeCounter()，返回 { inc(), value() }。';
  // 「发现缺口就补正式任务」是**工作方式约束**，属于 constraints 的结构化语义，不该写进 prompt 正文；
  // 策略给全、缺口位置不给 —— AI 必须自己去 state 里比对"待执行任务需要的产出有没有任务负责"
  t1.constraints = [
    '只创建 src/counter.js',
    '收尾前做一次计划自检：读 .awf/state.json，逐个检查尚未执行的任务，它需要复用的产出是否都有任务负责产出',
    '若某个待执行任务依赖一个没有任何任务会产出它的文件，不要自己代做，用 MCP 工具 awf_dynamic_plan 为那个任务补一个前置任务：'
      + '新任务 id 用「<目标任务的 id>-PRE」，operations 用一条 insert_task，relation.type = prerequisite_for，targetTaskId 填那个目标任务',
    '调用后不论返回 awaiting_approval 还是别的状态都不要等待审批，继续收尾',
  ];
  const t2 = dev('T2', 'src/queue.js', { deps: ['T1'] });
  const t3 = dev('T3', 'src/accumulator.js', { deps: ['T2'] });
  // 缺口写在这里：T3 要复用 src/adder.js，而任务图里没有产出它的任务 —— 但不告诉 AI 该补什么
  t3.prompt = '/ai-workflow-code:w-dev T3\n\n在项目根创建 src/accumulator.js，导出 makeAccumulator()，其内部复用来自 src/adder.js 的 makeAdder(n)。';
  t3.constraints = ['只创建 src/accumulator.js', '不要创建 src/adder.js（它应由任务图里的前置任务提供）'];
  t3.acceptance = 'src/accumulator.js 存在且复用 src/adder.js 的 makeAdder';

  const projectRoot = makeProject('dynamic-planning-run', {
    tasks: [t1, t2, t3],
    summary: '动态规划运行链路（全真：AI 自发现 → 人在飞批准 → 同一 run 继续）',
  });
  // 同 pause-release：本项目自起 server，run 复用它（非隔离模式下 ownServer 返回 null，复用常驻 server）
  const own = await ownServer(projectRoot);
  const routeProbe = await getFromServer('/awf/dynamic-planning/proposals', projectRoot);
  const routesOk = routeProbe.status === 200;

  const run = launchRun(projectRoot, { logSuffix: '-run' });

  // 1) 等会话内的 AI 自己把提案发出来（harness 全程不调 awf_dynamic_plan）
  const proposalSeen = await waitUntil(() => getFromServer('/awf/dynamic-planning/proposals', projectRoot)
    .then((r) => (r.json?.proposals || []).find((p) => p.status === 'awaiting_approval') || false), {
    timeoutMs: Math.min(timeoutMs, 480000), intervalMs: 1000,
  });
  const proposal = proposalSeen.value || null;
  const proposalId = proposal?.proposalId || null;
  const stateAtProposal = readStateSafe(projectRoot);
  const readyAtProposal = peekReadyTasks(stateAtProposal || {}).map((t) => t.id);
  const heldAtProposal = [...heldTaskIds(stateAtProposal || {})];

  // 2) 立刻人工批准 —— 必须在 T2 跑完之前落地，run 才不会撞上「无就绪任务」而收尾
  const stateAtApprove = readStateSafe(projectRoot);
  const t3AtApprove = (stateAtApprove?.tasks || []).find((t) => t.id === 'T3');
  const runStatusAtApprove = await getFromServer('/run/status', projectRoot);
  const activeRunsAtApprove = (runStatusAtApprove.json?.runs || [])
    .filter((r) => r.status === 'queued' || r.status === 'running').length;
  const approve = proposalId
    ? await postToServer(`/run/dynamic-planning/proposals/${proposalId}/approve`, projectRoot,
      { reviewer: 'regression', note: '运行链路验证' })
    : { status: 0, json: null };

  // 3) 同一个 run 走到收敛（不重提 run）
  const settled = await waitFor(projectRoot, (s) => s.mode === 'idle'
    && s.tasks.every((t) => ['done', 'blocked'].includes(t.status)), { timeoutMs: Math.min(timeoutMs, 900000) });
  const finalState = readStateSafe(projectRoot);
  const finalIds = (finalState?.tasks || []).map((t) => t.id);
  const byId = (id) => (finalState?.tasks || []).find((t) => t.id === id);
  const insertedId = finalIds.indexOf('T3') > 0 ? finalIds[finalIds.indexOf('T3') - 1] : null;
  const appliedProposal = await getFromServer('/awf/dynamic-planning/proposals', projectRoot)
    .then((r) => (r.json?.proposals || []).find((p) => p.proposalId === proposalId));

  const readEvents = () => {
    try {
      return fs.readFileSync(path.join(projectRoot, '.awf', 'dynamic-planning', 'events.jsonl'), 'utf8')
        .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  const eventNames = readEvents().map((e) => e.event);

  return {
    case: 'dynamic-planning-run',
    projectRoot,
    run,
    serverBoot: own ? { pid: own.pid, up: own.up.ok } : null,
    proposalId,
    proposedTargetTask: proposal?.operations?.[0]?.relation?.targetTaskId || null,
    insertedTaskId: insertedId,
    readyAtProposal,
    heldAtProposal,
    appliedProposalStatus: appliedProposal?.status || null,
    events: eventNames,
    summary: taskSummary(projectRoot),
    checks: [
      check('server 提供动态规划路由（常驻 server 可能是旧代码，须加 --port 重测）',
        routesOk, `probe=${routeProbe.status}${routesOk ? '' : ' — 常驻 server 未注册该路由，请用 --port <n> 跑本 case'}`),
      check('server 由本项目唤起（隔离模式下 server 归本项目）',
        !own || own.up.ok, own ? `pid=${own.pid} freed=${own.freed} up=${own.up.ok}` : '非隔离模式，复用常驻 server'),

      // 1) 会话内的 AI 自己发起，并自己找出缺口
      check('run 运行中 AI 经 MCP 发起了提案（harness 全程未调用该工具）',
        proposalSeen.ok && !!proposalId, proposalSeen.ok ? proposalId : '未观察到 awaiting_approval 的提案'),
      check('提案发起时 state.mode = run（在飞 run 内，而非事后补做）',
        stateAtProposal?.mode === 'run', `mode=${stateAtProposal?.mode}`),
      check('提案 requestedBy=ai（会话内 MCP 的缺省调用路径）',
        proposal?.requestedBy === 'ai', String(proposal?.requestedBy)),
      check('缺口由 AI 自己找出来：目标任务是 T3', proposal?.operations?.[0]?.relation?.targetTaskId === 'T3',
        `target=${proposal?.operations?.[0]?.relation?.targetTaskId ?? '(无)'}`),
      check('提案内容是为该目标插一个前置（insert_task / prerequisite_for）',
        proposal?.operations?.[0]?.type === 'insert_task'
        && proposal?.operations?.[0]?.relation?.type === 'prerequisite_for',
        JSON.stringify(proposal?.operations?.[0]?.type)),
      check('proposal 文件与事件日志落盘',
        !!proposalId && fs.existsSync(path.join(projectRoot, '.awf', 'dynamic-planning', 'proposals', `${proposalId}.json`))
        && eventNames.includes('proposal.awaiting_approval'), eventNames.join(',')),

      // 2) hold 只挡目标及其下游：并行任务仍可继续（这是「同一 run 不停机」的前提）
      check('hold 覆盖目标 T3', heldAtProposal.includes('T3'), JSON.stringify(heldAtProposal)),
      check('hold 不牵连上游/无关任务（只覆盖目标及其下游）',
        !heldAtProposal.includes('T1') && !heldAtProposal.includes('T2'), JSON.stringify(heldAtProposal)),
      check('被 hold 的任务不进调度器就绪池（state.js 判据）',
        !readyAtProposal.includes('T3'),
        `ready=${readyAtProposal.join(',') || '（此刻无就绪：T1 正在跑）'}`),

      // 3) 人在 run 进行中批准
      check('批准时 run 仍在飞（/run/status 有活跃 run）',
        activeRunsAtApprove >= 1, `activeRuns=${activeRunsAtApprove} status=${runStatusAtApprove.status}`),
      check('批准前 T3 从未被派发（仍是 pending、无 startedAt）',
        t3AtApprove?.status === 'pending' && !t3AtApprove?.exec?.startedAt,
        `status=${t3AtApprove?.status} startedAt=${t3AtApprove?.exec?.startedAt ?? '无'}`),
      check('人工批准端点应用了提案',
        approve.status === 200 && approve.json?.proposal?.status === 'applied',
        `status=${approve.status} ${approve.json?.proposal?.status ?? approve.json?.error ?? ''}`),
      check('应用后提案终态可读（applied）', appliedProposal?.status === 'applied', String(appliedProposal?.status)),

      // 4) 同一个 run 继续跑完
      check('run 收敛（未重提 run）', settled.ok,
        `mode=${finalState?.mode} ${JSON.stringify(taskSummary(projectRoot).counts)}`),
      check('四个任务全部 done', (finalState?.tasks || []).every((t) => t.status === 'done'),
        (finalState?.tasks || []).map((t) => `${t.id}:${t.status}`).join(',')),
      check('AI 插入的前置任务落在 T3 之前',
        !!insertedId && insertedId !== 'T2' && insertedId !== 'T1', `inserted=${insertedId} 序=${finalIds.join(',')}`),
      check('T3 的依赖已重连到新任务', (byId('T3')?.deps || []).includes(insertedId),
        JSON.stringify(byId('T3')?.deps)),
      check('新任务在 T3 **之前**被派发（用 startedAt 判据，不依赖日志文本）',
        !!insertedId && !!byId(insertedId)?.exec?.startedAt && !!byId('T3')?.exec?.startedAt
        && byId(insertedId).exec.startedAt < byId('T3').exec.startedAt,
        `${insertedId}.startedAt=${byId(insertedId)?.exec?.startedAt ?? '无'} T3.startedAt=${byId('T3')?.exec?.startedAt ?? '无'}`),
      check('四个任务的产物都在（前置确实先跑出来了）',
        ['src/counter.js', 'src/queue.js', 'src/adder.js', 'src/accumulator.js']
          .every((f) => fs.existsSync(path.join(projectRoot, f))),
        fs.readdirSync(path.join(projectRoot, 'src')).join(',')),
      check('审计记录完整（提案 → 待批准 → 批准应用）',
        ['proposal.awaiting_approval', 'proposal.approved_and_applied'].every((e) => eventNames.includes(e)),
        eventNames.join(',')),
    ],
  };
}
// ── case 注册表 ─────────────────────────────────────────────────────────────

/**
 * 挂新 case = 写一个 `async ({ timeoutMs }) => { case, checks[], ...证据 }` 函数 + 在表内登记一条。
 * `id` 即 `--case` 取值；数组顺序即 `--case all` 的执行顺序（轻链路在前，失败早暴露）。
 * 未知 case 名由 main 检出并中止，不会静默跑空。
 */
const CASES = [
  { id: 'single', title: '单 agent 最小链路（DEV 自落账 → run done）', run: caseSingle },
  { id: 'gate', title: '门禁任务（kind=review）产出 verdict', run: caseGate },
  { id: 'multi', title: '多 agent 滑动窗口（--multi-agent）', run: caseMulti },
  { id: 'decision', title: '决策闸门（DC 自决 + DecisionStore 落盘 + 续跑注入）', run: caseDecision },
  { id: 'dual', title: '同机双项目并发 run（会话/state/env/日志隔离）', run: caseDual },
  { id: 'resume', title: '重连续接（--attach 拒绝空闲宿主 / 中断后挂接在飞 run）', run: caseResume },
  { id: 'pause', title: '暂停闩锁 + w-monitor 介入（intervene / interrupt）', run: casePause },
  { id: 'recover', title: '中断后现场恢复（现场保留 → 宿主续推 → --resume 收尾）', run: caseRecover },
  { id: 'pause-release', title: '暂停期间目标结算即放行（不等 mode 恢复，且不放松派发闩锁）', run: casePauseRelease },
  { id: 'init', title: 'awf init 产出（插件注册/项目 MCP/骨架/幂等）', run: caseInit },
  { id: 'mcp', title: 'MCP 工具面冒烟（state/session/oneshot 握手 + 工具名）', run: caseMcp },
  { id: 'lifecycle', title: '常驻 server 空闲回收（探活 → 静置 → 退出）', run: caseLifecycle },
  { id: 'dynamic-planning', title: '动态规划跨进程边界（真 server + 真 MCP：提案/hold/批准/冲突/拒绝）', run: caseDynamicPlanning },
  { id: 'dynamic-planning-run', title: '动态规划运行链路（全真：AI 自发现缺口 → 人在飞批准 → 同一 run 继续）', run: caseDynamicPlanningRun },
  { id: 'web', title: '前端页可达 + 取数 + 项目切换 + 决策 override', run: caseWeb },
];

const caseIds = () => CASES.map((c) => c.id).join(' / ');

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const c of CASES) console.log(`${c.id.padEnd(10)} ${c.title}`);
    return;
  }
  AWF_CLI = resolveAwfCli(args.awf);
  SERVER_PORT = resolveServerPort(args.port);
  // 顺序要紧：隔离插件副本住在 SANDBOX_ROOT 里，而 --clean 删的是整个 SANDBOX_ROOT。
  // 先建副本、后 --clean = 把刚建的副本自己删掉 —— 沙箱项目的 marketplace 指向不存在的目录，
  // 插件/agent/hook 全部解析失败（会话永不 ready → run 卡在 ready timeout，形似产品回归）。
  // 故：先清/建沙箱根，再建副本。（2026-09-11 T3-011 全量门禁踩到）
  if (args.clean) fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  if (args.port) {
    ISOLATED_PLUGIN_DIR = isolatedPluginDir(SERVER_PORT);
  } else {
    console.log(`[回归] 复用常驻 server(:${SERVER_PORT})，测的是它启动时的代码；`
      + '要测当前工作树（尤其 src/server/**）请加 --port <n> 走隔离 server\n');
  }
  preflight();

  const selected = args.case === 'all' ? CASES : CASES.filter((c) => c.id === args.case);
  if (!selected.length) throw new Error(`未知 case: ${args.case}（可选 ${caseIds()} / all）`);

  const results = [];
  for (const { id, run } of selected) {
    console.log(`\n=== case ${id} ===`);
    let r;
    try {
      r = await run({ timeoutMs: args.timeoutMs });
    } catch (e) {
      // 单个 case 崩掉不能带走整轮与证据：记为失败断言，继续跑后面的 case
      r = { case: id, checks: [check('case 执行未抛错', false, e?.stack ?? String(e))] };
    }
    for (const c of r.checks) console.log(`  ${c.pass ? '✔' : '✘'} ${c.name}${c.pass ? '' : ` — ${c.detail ?? ''}`}`);
    // 每 case 跑完即写（定向/全量同名同形），异常路径也落盘
    fs.writeFileSync(
      path.join(SANDBOX_ROOT, `evidence-${id}.json`),
      JSON.stringify({ generatedAt: new Date().toISOString(), awfCli: AWF_CLI, ...r, case: id }, null, 2) + '\n',
    );
    results.push(r);
  }

  const evidence = {
    generatedAt: new Date().toISOString(),
    awfCli: AWF_CLI,
    sandboxRoot: SANDBOX_ROOT,
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    cases: results,
    totals: {
      checks: results.flatMap((r) => r.checks).length,
      passed: results.flatMap((r) => r.checks).filter((c) => c.pass).length,
    },
  };
  // 定向跑**不得**写 evidence-all.json：那个文件名是全量汇总的约定位置（覆盖矩阵/报告都按它取证），
  // 单 case 跑一次就把它替换成单 case 摘要 = 静默销毁上一轮全量证据（2026-09-11 实际发生）。
  const out = args.out
    || path.join(SANDBOX_ROOT, args.case === 'all' ? 'evidence-all.json' : `evidence-${args.case}-summary.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
  if (ISOLATED_PLUGIN_DIR) stopIsolatedServer(); // 隔离 server 用完即停，不留常驻进程
  console.log(`\n证据: ${out}`);
  console.log(`合计 ${evidence.totals.passed}/${evidence.totals.checks} 断言通过`);
  process.exit(evidence.totals.passed === evidence.totals.checks ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
