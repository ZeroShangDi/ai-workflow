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
 *   npm run test:real -- --case single
 *   npm run test:real -- --case gate
 *   npm run test:real -- --case multi
 *   npm run test:real -- --case decision
 *   npm run test:real -- --case dual
 *   npm run test:real -- --case all --out /tmp/evidence.json
 *   （等价直跑：node tests/regression/fullflow-regression.mjs --case all）
 *
 * 选项：
 *   --awf <path>   指定 awf CLI 入口（默认用本仓库 src/awf.js；传另一工作副本的 src/awf.js 可钉住被回归链路）
 *   --keep         保留沙箱目录（默认保留，证据留存）；--clean 跑前先删
 *   --timeout <ms> 单 case 超时（默认 10 分钟）
 *   --out <path>   证据 JSON 输出路径
 *
 * 注意：本脚本从「另一个 run 的会话内」执行时，父 run 会把 CC_SESSION 等变量 export 给
 * 本进程；子 run 必须用 sanitizedEnv() 剔除，否则子 run 会话名与共享 server 的装配不一致。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// 产物落仓库 sandbox/ 下（gitignore 的产物区）：源码入库、生成物不入库
const SANDBOX_ROOT = process.env.AWF_REGRESSION_ROOT || path.join(ROOT, 'sandbox', 'regression');

// ── CLI 参数 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { case: 'single', awf: null, timeoutMs: 10 * 60 * 1000, clean: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--case') out.case = argv[++i];
    else if (a === '--awf') out.awf = argv[++i];
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
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
  const cfgPath = path.join(projectRoot, '.awf', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.run.agents.max = agentsMax;
  cfg.run.decision.enabled = decision;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  seedState(projectRoot, tasks, summary);
  return projectRoot;
}

let AWF_CLI = null;

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

/** 启动 `awf run`（后台进程），返回 { proc, logPath, projectRoot } */
function launchRun(projectRoot, { multiAgent = false } = {}) {
  const logPath = path.join(path.dirname(projectRoot), `run-${path.basename(projectRoot)}.log`);
  const args = [AWF_CLI, 'run'];
  if (multiAgent) args.push('--multi-agent');
  const fd = fs.openSync(logPath, 'w');
  const proc = spawn('node', args, {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: sanitizedEnv({
      PATH: `${openShimDir()}${path.delimiter}${process.env.PATH}`,
      CC_SERVER_IDLE_MS: '0', // 回归期间不自动回收常驻 server
    }),
  });
  proc.unref();
  return { pid: proc.pid, logPath, projectRoot };
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
  return {
    case: 'decision',
    projectRoot,
    run,
    settled,
    sessionEnv: env,
    summary: sum,
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
      check('决策落本次 run 的 runStamp（per-run 隔离）', completed.length > 0 && completed.every((r) => r.runStamp === stamp), `${stamp} vs ${completed.map((r) => r.runStamp).join(',')}`),
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

// ── main ───────────────────────────────────────────────────────────────────

const CASES = { single: caseSingle, gate: caseGate, multi: caseMulti, decision: caseDecision, dual: caseDual };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  AWF_CLI = resolveAwfCli(args.awf);
  if (args.clean) fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });

  const names = args.case === 'all' ? Object.keys(CASES) : [args.case];
  const results = [];
  for (const name of names) {
    const fn = CASES[name];
    if (!fn) throw new Error(`未知 case: ${name}（可选 ${Object.keys(CASES).join(' / ')} / all）`);
    console.log(`\n=== case ${name} ===`);
    const r = await fn({ timeoutMs: args.timeoutMs });
    for (const c of r.checks) console.log(`  ${c.pass ? '✔' : '✘'} ${c.name}${c.pass ? '' : ` — ${c.detail ?? ''}`}`);
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
  const out = args.out || path.join(SANDBOX_ROOT, `evidence-${args.case}.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`\n证据: ${out}`);
  console.log(`合计 ${evidence.totals.passed}/${evidence.totals.checks} 断言通过`);
  process.exit(evidence.totals.passed === evidence.totals.checks ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
