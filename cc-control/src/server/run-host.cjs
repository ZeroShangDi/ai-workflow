'use strict';
/**
 * run-host.cjs — server 侧常驻 run host（编排宿主机；可启动/停止、可注入测试）
 *
 * 现状：run 编排（任务选择/阶段推进/多 agent 调度）**已整体在本模块**，CLI 只是
 * 「提交 run → 订阅事件/状态 → 应答 → 收尾」的薄入口（`src/cli/run.js`）；多 agent 传输
 * 在 `src/server/batch-transport.cjs`（承自重构前的 `cli/run-batch.js`，该模块已删除）。
 *
 * 宿主基座的能力面（T1-105 起逐项落地，现均已接线）：
 *   - 常驻：createRunHost(...) 产出进程内宿主，start()/stop() 管理宿主生命周期；
 *   - 可注入：run-driver（阶段链/门禁锚点）、run-scheduler（多 agent）、state 原语、
 *     per-task executor（模型通道）全部经注入组装，宿主自身零 import 引擎层逻辑
 *     （CJS/ESM 边界照 run-batch 桥接法由装配方处理）；
 *   - 单 agent：宿主用 state.findNextTask 顺序选任务，用 run-driver.decideChain 标注
 *     任务阶段链，per-task 执行委托注入的 executor（settle 任务到 done/blocked），
 *     门禁经 run-driver.gateCompletionHook 锚点派生修复/复审；
 *   - 多 agent：cfg.agents.max > 1 → 宿主直接跑注入的 runScheduler（dispatch/
 *     waitAnyDone 传输由装配方提供，onTaskComplete 挂门禁锚点 + 事件/计数）；
 *   - 观测面：每 run 状态快照（snapshot）+ 按序事件轮询（pollEvents，afterSeq 游标），
 *     server 挂 /run/* 端点后即成为 CLI 订阅 run 的唯一入口。
 *
 * 已完成的迁入项（原「不做，保留给后续任务」）：CLI live driver 切换（T1-058）、剩余
 * state/gate 直写迁移（T1-061）、真 run/双 run 回归（T1-098）——均已落地。宿主在无人
 * submit 前保持空闲，零副作用。
 */

/** 宿主自身生命周期状态 */
const HOST_STATES = ['idle', 'running', 'stopped'];

/** run 生命周期状态 */
const RUN_STATES = ['queued', 'running', 'done', 'error', 'stopped'];

/** 单 run 状态机（宿主视角；running 可被 stop() 置 stopped，异常置 error） */
const RUN_TRANSITIONS = {
  queued: ['running'],
  running: ['done', 'error', 'stopped'],
};

/** 事件环上限（超限从头部裁剪；seq 单调不回退） */
const EVENT_RING_CAP = 10000;

/** 单 agent 任务推进上限（防死循环保险丝；任务数异常时中止 run） */
const MAX_TASK_STEPS = 5000;

/** 事件类型（对齐 events.cjs EVENT_DEFS 的重叠类型，供后续 bus/persist 接线复用） */
const HOST_EVENT_TYPES = [
  'run.submitted',
  'run.started',
  'run.phase',
  'run.stopped',
  'run.error',
  'task.started',
  'task.done',
  'task.blocked',
  'gate.fix',
];

function assertRunTransition(from, to, runId) {
  if (from === to) return;
  const allowed = RUN_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`run-host[${runId}]: 非法 run 迁移 ${from} → ${to}`);
  }
}

function assertState(hostState) {
  if (!HOST_STATES.includes(hostState)) throw new Error(`run-host: 未知宿主状态 ${hostState}`);
}

/** 由 state 计算任务计数 { total, done, blocked, active, pending } */
function countTasks(state) {
  const tasks = state?.tasks || [];
  const counts = { total: tasks.length, done: 0, blocked: 0, active: 0, pending: 0 };
  for (const t of tasks) {
    if (t.status === 'done') counts.done += 1;
    else if (t.status === 'blocked') counts.blocked += 1;
    else if (t.status === 'active') counts.active += 1;
    else counts.pending += 1;
  }
  return counts;
}

/**
 * 创建常驻 run host。
 *
 * @param {object} opts（全部依赖注入；缺省保守）
 *   - projectRoot: .awf 宿主（必填）
 *   - cfg: run 配置 { agents: { max,... } }（loadRunConfig 输出；缺省单 agent）
 *   - state: { loadState, saveState, markTaskActive, findNextTask, setWorkflowMode? }
 *   - chain: run-driver.cjs 导出（decideChain / gateCompletionHook 等）
 *   - handleGateCompletion: cli/gate-fix 门禁处理器（gateCompletionHook 内联消费）
 *   - scheduler: runScheduler 函数（batch 模式用；可后注入）
 *   - executor: 单 agent per-task 执行器 `runTask({ runId, projectRoot, taskId, task, chain })`
 *       → 将任务在 state 中 settle 为 done/blocked 并返回 { status?, error? }；不提供则
 *       单 agent submit 返回 409（通道未接线，T1-058 组装真实通道）
 *   - batch: 多 agent 传输 { dispatch(task), waitAnyDone(running) }（可后注入）
 *   - bus: events.cjs 总线（可选；宿主事件同时推送）
 *   - onEvent: (event) => void 外部订阅（可选）
 *   - logger / clock / sleep: 观测与等待原语
 * @returns {object} host
 */
function createRunHost(opts = {}) {
  const {
    projectRoot,
    cfg = { agents: { max: 1 } },
    state: stateApi = null,
    chain = null,
    handleGateCompletion = null,
    scheduler = null,
    executor = null,
    batch = null,
    bus = null,
    onEvent = null,
    logger = null,
    clock = () => new Date().toISOString(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  if (!projectRoot) throw new Error('run-host: projectRoot 必填');
  if (!stateApi?.loadState || !stateApi?.findNextTask) {
    throw new Error('run-host: state 原语未注入（loadState/findNextTask 必填）');
  }

  // ── 宿主状态 ──
  let hostState = 'idle';
  let stopping = false; // stop() 置位，当前 run 驱动器在安全点收尾
  let activeRunId = null; // 单写者：同一时刻只驱动一个 run

  // ── runs：runId → run 记录 ──
  const runs = new Map();
  // ── 事件环：{ seq, runId, type, at, payload } ──
  const eventRing = [];
  let seq = 0;
  const trimmedBase = { seq: 0 }; // 已裁剪事件的最小 seq（文档化，供 poll 语义说明）
  // 实时订阅者（T1-091：WS 推送等长连接消费；emit 同步扇出）
  const subscribers = new Set();

  function mode() {
    return (cfg?.agents?.max || 1) > 1 ? 'batch' : 'single';
  }

  // ── 事件发布 ──
  function emit(type, runId, payload) {
    const at = clock();
    const event = { seq: ++seq, runId, type, at, payload: payload || {} };
    eventRing.push(event);
    if (eventRing.length > EVENT_RING_CAP) {
      const drop = eventRing.length - EVENT_RING_CAP;
      eventRing.splice(0, drop);
      trimmedBase.seq = eventRing[0]?.seq ?? trimmedBase.seq;
    }
    try {
      bus?.emit({ type, at, runId: runId ?? null, payload: payload || {} });
    } catch { /* 总线韧性：单 handler 异常不影响宿主 */ }
    try { onEvent?.(event); } catch { /* 外部订阅异常不影响宿主 */ }
    for (const fn of subscribers) {
      try { fn(event); } catch { /* 单订阅者异常不影响宿主 */ }
    }
    logger?.({ type, runId, at, payload: payload || {} });
  }

  function hasActiveRun() {
    return activeRunId != null;
  }

  /** 新建 run 记录（不入队驱动；由 submitRun 负责 kick）。
   *  modeOverride：调用方显式指定 'single'|'batch'（如 CLI --multi-agent），缺省按 cfg.agents.max 判定 */
  function createRunRecord(runId, modeOverride = null) {
    const m = modeOverride === 'single' || modeOverride === 'batch' ? modeOverride : mode();
    return {
      runId,
      mode: m,
      status: 'queued',
      error: null,
      queuedAt: clock(),
      startedAt: null,
      finishedAt: null,
      updatedAt: clock(),
      counts: { total: 0, done: 0, blocked: 0, active: 0, pending: 0 },
      currentTaskId: null,
      currentTaskTitle: null,
      currentChain: null,
      currentStage: null,
      modeChanged: false,
    };
  }

  /** 由磁盘 state 刷新 run 的计数与阶段 */
  function refreshRunFromState(run) {
    const s = stateApi.loadState(projectRoot);
    if (!s) return;
    const counts = countTasks(s);
    run.counts = counts;
    run.updatedAt = clock();
    return s;
  }

  function taskById(run, id) {
    const s = stateApi.loadState(projectRoot);
    return s?.tasks?.find((t) => t.id === id) || null;
  }

  function setRunStatus(run, next, { error = null, at } = {}) {
    assertRunTransition(run.status, next, run.runId);
    run.status = next;
    run.error = error;
    run.updatedAt = at || clock();
    if (next === 'running' && !run.startedAt) run.startedAt = run.updatedAt;
    if (next === 'done' || next === 'error' || next === 'stopped') run.finishedAt = run.updatedAt;
  }

  // ── 门禁锚点：host 侧统一经 run-driver.gateCompletionHook（单/多 agent 收敛同一锚点） ──
  async function runGateHook(run, id, taskSnapshot) {
    if (!chain?.gateCompletionHook || typeof handleGateCompletion !== 'function') return false;
    const hook = chain.gateCompletionHook(projectRoot, { handleGateCompletion });
    const handled = await hook(id, taskSnapshot);
    if (handled) {
      emit('gate.fix', run.runId, { taskId: id, kind: taskSnapshot?.kind || null });
    }
    return handled;
  }

  /** 任务完成后统一收账：读真实 state → 事件/计数；门禁任务 blocked 走门禁锚点 */
  async function settleTaskCompletion(run, taskId, snapshot) {
    const current = taskById(run, taskId) || snapshot;
    const status = current?.status || 'unknown';
    const kind = current?.kind || snapshot?.kind || null;
    const verdict = current?.exec?.verdict || null;
    if (status === 'done') {
      emit('task.done', run.runId, { taskId, kind, verdict });
    } else if (status === 'blocked') {
      emit('task.blocked', run.runId, { taskId, kind, verdict });
      await runGateHook(run, taskId, current);
    }
    refreshRunFromState(run);
    run.currentTaskId = null;
    run.currentTaskTitle = null;
    run.currentStage = null;
    return current;
  }

  // ── 单 agent 驱动：顺序选任务 + run-driver 阶段链标注 + executor 结算 + 门禁 ──
  async function driveSingle(run) {
    let steps = 0;
    let lastPhase = null;
    while (!stopping) {
      const s = stateApi.loadState(projectRoot);
      if (!s) throw new Error(`state.json 不可读（${projectRoot}）`);
      // 阶段变化事件（CODE/REVIEW/… 与 state.currentState 对齐）
      const phase = s.currentState || 'RUN';
      if (phase !== lastPhase) {
        lastPhase = phase;
        emit('run.phase', run.runId, { phase });
      }
      if (s.currentState === 'FINISH') break;
      const task = stateApi.findNextTask(s);
      if (!task) break; // 无就绪任务：要么全 done，要么 blocked 需人工
      if (++steps > MAX_TASK_STEPS) {
        throw new Error(`单 agent 推进超过 ${MAX_TASK_STEPS} 步，疑似死循环（task=${task.id}）`);
      }
      if (typeof executor?.runTask !== 'function') {
        throw new Error('run-host: 单 agent 未接线 executor（模型通道待 T1-058 组装）');
      }

      // run-driver 阶段链：按任务复杂度/类型选链（gate/doc/commit 走保守链）并落快照/事件
      const ch = chain?.decideChain ? chain.decideChain(task) : { chain: null, stages: [task.kind || 'dev'] };
      run.currentTaskId = task.id;
      run.currentTaskTitle = task.title || null;
      run.currentChain = ch.stages;
      run.currentStage = ch.stages[0] || null;
      refreshRunFromState(run);

      // 与动态规划 hold 竞争时，只有拿到原子执行占用的调用者可以继续。
      // 失败说明任务已被调整、结算或挂起，重读 state 重新选择。
      if (stateApi.markTaskActive(projectRoot, task.id) === false) {
        run.currentTaskId = null;
        run.currentTaskTitle = null;
        run.currentChain = null;
        run.currentStage = null;
        continue;
      }
      emit('task.started', run.runId, {
        taskId: task.id,
        title: task.title || null,
        kind: task.kind || 'dev',
        chain: ch.stages,
        chainName: ch.chain,
      });

      let result = {};
      try {
        result = (await executor.runTask({
          runId: run.runId,
          projectRoot,
          taskId: task.id,
          task,
          taskIndex: steps, // 1-based：任务前上下文检查跳过首个（task-channel.maybeCompactContext）
          chain: ch.stages,
        })) || {};
      } catch (err) {
        emit('run.error', run.runId, { taskId: task.id, error: err.message });
        throw err;
      }
      if (result?.error) {
        throw new Error(`executor 执行任务 ${task.id} 失败: ${result.error}`);
      }
      await settleTaskCompletion(run, task.id, { ...task, status: result.status || null });
    }
  }

  // ── 多 agent 驱动：滑动窗口调度器（runScheduler），onTaskComplete 挂门禁锚点 ──
  async function driveBatch(run) {
    if (typeof scheduler !== 'function') throw new Error('run-host: 多 agent 未注入 scheduler（runScheduler）');
    if (!batch?.dispatch || !batch?.waitAnyDone) {
      throw new Error('run-host: 多 agent 未注入 batch 传输（dispatch/waitAnyDone）');
    }
    refreshRunFromState(run);
    const { dispatched } = await scheduler({
      projectRoot,
      cfg,
      dispatcher: {
        send: async (task) => {
          run.currentTaskId = task.id;
          run.currentTaskTitle = task.title || null;
          run.currentChain = chain?.decideChain ? chain.decideChain(task).stages : [task.kind || 'dev'];
          const accepted = await batch.dispatch(task);
          if (accepted === false) return false;
          emit('task.started', run.runId, {
            taskId: task.id,
            title: task.title || null,
            kind: task.kind || 'dev',
            chain: run.currentChain,
          });
          return true;
        },
      },
      waitAnyDone: async (running) => batch.waitAnyDone(running),
      onTaskComplete: async (id, taskSnapshot) => {
        await settleTaskCompletion(run, id, taskSnapshot);
      },
    });
    run.dispatched = dispatched;
  }

  /** run 驱动器：把 run 从 queued 推进到终态（done/error/stopped） */
  async function drive(run) {
    emit('run.started', run.runId, { mode: run.mode });
    setRunStatus(run, 'running');
    // run 模式：进入编排前把工作流 mode 置 run（若当前非 run）；结束时复位（若本宿主改动）
    let changedMode = false;
    try {
      const s0 = stateApi.loadState(projectRoot);
      if (s0 && s0.mode !== 'run' && stateApi.setWorkflowMode) {
        stateApi.setWorkflowMode(projectRoot, 'run');
        changedMode = true;
      }
      run.modeChanged = changedMode;
      if (run.mode === 'batch') await driveBatch(run);
      else await driveSingle(run);

      // FINISH 收尾：版本归档（迁自重构前 cli/run.js runLoop 末尾的 backupState）
      stateApi.backupState?.(projectRoot);

      const fin = stateApi.loadState(projectRoot);
      const finishState = fin?.currentState;
      setRunStatus(run, 'done');
      emit('run.stopped', run.runId, { status: 'done', currentState: finishState, counts: run.counts });
    } catch (err) {
      setRunStatus(run, 'error', { error: err.message });
      emit('run.error', run.runId, { error: err.message });
      emit('run.stopped', run.runId, { status: 'error', error: err.message });
    } finally {
      if (changedMode && stateApi.setWorkflowMode) {
        try { stateApi.setWorkflowMode(projectRoot, 'idle'); } catch { /* 忽略收尾失败 */ }
      }
      activeRunId = null;
      stopping = false;
    }
  }

  // ── host 公开面 ──
  const host = {
    projectRoot,
    get hostState() { return hostState; },

    /** 启动宿主（可重复；已在 running 则 no-op） */
    start() {
      assertState(hostState);
      if (hostState === 'running') return { ok: true, state: hostState };
      hostState = 'running';
      stopping = false;
      return { ok: true, state: hostState };
    },

    /** 停止宿主：置 stopping，当前 run 在安全点收尾后不再驱动 */
    stop() {
      if (hostState !== 'running') return { ok: true, state: hostState };
      stopping = true;
      hostState = 'stopped';
      return { ok: true, state: hostState };
    },

    /**
     * 提交一个 run（常驻宿主只同时驱动一个；已 running → 409）。
     * 驱动异步进行，本调用立即返回 { ok, runId, mode }。
     * @param {{ runId?: string, mode?: 'single'|'batch' }} spec
     */
    submitRun(spec = {}) {
      const runId = spec.runId || 'default';
      if (hostState === 'stopped') {
        return { ok: false, error: '宿主已停止（start() 后重试）', runId };
      }
      if (runs.has(runId) && ['queued', 'running'].includes(runs.get(runId).status)) {
        return { ok: false, error: `run ${runId} 已在 ${runs.get(runId).status}`, runId };
      }
      if (hasActiveRun()) {
        const cur = runs.get(activeRunId);
        return { ok: false, error: `宿主正在驱动 run ${activeRunId}（${cur?.status}）；常驻单槽需先完成/停止`, runId };
      }
      const run = createRunRecord(runId, spec.mode || null);
      runs.set(runId, run);
      emit('run.submitted', runId, { mode: run.mode });
      activeRunId = runId;
      // 异步推进，不阻塞 submit 调用
      setImmediate(() => { drive(run).catch((err) => { /* drive 已吞错置 error，这里兜底 */ console.error(`[run-host] drive ${runId}: ${err.message}`); }); });
      return { ok: true, runId, mode: run.mode };
    },

    /** 单 agent 通道是否可执行（未接 executor → false，供端点给出可读错误） */
    get singleReady() { return typeof executor?.runTask === 'function'; },

    /** run 状态快照；runId 缺省 → 全部 run 摘要 */
    snapshot(runId) {
      if (runId != null) {
        const run = runs.get(String(runId));
        if (!run) return { ok: false, error: `run ${runId} 不存在` };
        return { ok: true, run: summarize(run) };
      }
      return { ok: true, runs: [...runs.values()].map(summarize) };
    },

    /**
     * 轮询事件：afterSeq 之后的 run 事件（runId 过滤可选）。
     * @param {{ runId?: string, afterSeq?: number, limit?: number }} q
     */
    pollEvents(q = {}) {
      const after = Number.isInteger(q.afterSeq) && q.afterSeq >= 0 ? q.afterSeq : 0;
      // issue 004-1：`q.limit` 现在真的会被 /run/events 转发进来，故判据收紧为「正整数才采信」——
      // 裸 `q.limit || 200` 会让负数落到 slice(0, -n)（去掉尾部 n 条，与「取前 n 条」正好相反）。
      const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 200;
      let list = eventRing.filter((e) => e.seq > after);
      if (q.runId != null) list = list.filter((e) => e.runId === String(q.runId));
      if (list.length > limit) list = list.slice(0, limit);
      const last = list[list.length - 1];
      return {
        ok: true,
        events: list,
        afterSeq: last ? last.seq : after,
        tailSeq: eventRing.length ? eventRing[eventRing.length - 1].seq : trimmedBase.seq,
        trimmed: trimmedBase.seq,
      };
    },

    /**
     * 实时订阅：emit 后同步回调 event（含 runId 过滤判断由订阅方自行处理）。
     * @returns {Function} 取消订阅
     */
    subscribe(fn) {
      if (typeof fn !== 'function') throw new Error('run-host.subscribe: fn 须为函数');
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },

    /**
     * 外部发布：让 host 外代码（如 server 决策闸门）也把事件推入环 + 实时订阅。
     * runId 缺省取当前 active run（无则 null）。
     */
    publish(type, payload, { runId } = {}) {
      emit(type, runId !== undefined ? runId : (activeRunId ?? null), payload);
    },

    /** run 记录数（观测用） */
    get runCount() { return runs.size; },

    /** 重置宿主（测试/重开用）：清 runs 与事件环，复位为 idle */
    reset() {
      if (hasActiveRun()) return { ok: false, error: '有 run 正在驱动，无法 reset' };
      runs.clear();
      eventRing.length = 0;
      seq = 0;
      trimmedBase.seq = 0;
      hostState = 'idle';
      stopping = false;
      return { ok: true };
    },
  };

  function summarize(run) {
    return {
      runId: run.runId,
      mode: run.mode,
      status: run.status,
      error: run.error,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      updatedAt: run.updatedAt,
      counts: run.counts,
      currentTaskId: run.currentTaskId,
      currentTaskTitle: run.currentTaskTitle,
      currentChain: run.currentChain,
      currentStage: run.currentStage,
    };
  }

  return host;
}

module.exports = { createRunHost, HOST_STATES, RUN_STATES, countTasks };
