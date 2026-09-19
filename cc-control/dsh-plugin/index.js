/**
 * awf-dsh — AWF 的 DSH 插件（host 半侧）
 *
 * 职责：把 AWF 发来的指令落到 DSH 运行时（建/找会话、派发、打断、快照、一次性调用、装配），
 * 并把平台事件回传给 AWF。**调度判断不在这一侧**（任务挑选、阶段链、门禁归 AWF 宿主）。
 *
 * 装配形态（Cordis）：ESM，具名导出 `name` / `inject` / `apply`。
 *   - `inject` 只列真正必需的服务；其余按 op 用 `ctx.get(name)` 惰性取，
 *     这样缺某个能力时是**该 op 显式失败**，而不是整个插件装不起来。
 *   - 通道启动放进 `ctx.effect(...)`：卸载时自动断开（不留野连接）。
 *
 * 配置（profile 的 patch 行 `config`，或环境变量）：
 *   awfBase   AWF server 基址（也读 `AWF_DSH_BASE`）—— 缺它则插件不启动通道并**明确告警**
 *   webUrl    打开页面用的基址（缺省按 webPort 拼）
 *   provider / model  一次性调用用的模型（缺省走平台默认）
 *
 * 见 docs/discuss/dsh-adapter-execution.md §2.7 与 §2.5（U16 批准策略的正确接线）。
 */

import { createBridgeClient } from './lib/bridge-client.js';
import { createOps } from './lib/ops.js';

export const name = 'awf-dsh';

/** 只依赖 timer（重连退避用）；其余服务按需 `ctx.get`，缺失时对应 op 显式失败 */
export const inject = ['timer'];

/** 插件版本（握手时带给 AWF，供其版本可识别） */
const PLUGIN_VERSION = '0.0.1';

export function apply(ctx, config = {}) {
  const log = (level, msg) => {
    const line = `[awf-dsh][${level}] ${msg}`;
    if (level === 'info') console.log(line); else console.error(line);
  };

  const awfBase = config.awfBase || process.env.AWF_DSH_BASE;
  if (!awfBase) {
    // 明确告警而不是静默：没配 AWF 地址，插件装上了也驱动不了任何东西
    log('warn', '未配置 awfBase（config.awfBase 或 AWF_DSH_BASE）—— 指令通道不启动');
    return;
  }

  // client 后建、ops 先用：事件上报经闭包取 client（避免构造循环）
  let client = null;
  const { dispatch, noteApproval, createdByAwf, inFlight } = createOps({
    ctx,
    config,
    log,
    onEvent: (event, facts) => client?.emitEvent(event, facts),
  });
  client = createBridgeClient({
    awfBase,
    pluginVersion: PLUGIN_VERSION,
    dispatch,
    log,
  });

  // ── U16 批准策略：**先只记录 + 委派**，不自动批准 ──
  // 理由：在实测搞清「workspace-write 预设下到底什么操作会请求批准」之前，自动批准可能把沙箱边界一起放开。
  // 平台应答者缝见 docs/discuss/dsh-adapter-execution.md §2.5：返回 'allowed-once' 即认领，`next()` 委派给
  // 下一个应答者（UI/人工；无应答者时平台 fail closed = 拒绝）。
  ctx.on('approval/request', (req, next) => {
    const sessionId = req?.agent?.session?.header?.id ?? null;
    const ours = sessionId !== null && createdByAwf.has(sessionId);
    noteApproval(req, { sessionId, ours });
    client?.emitEvent({
      type: 'approval.requested',
      sessionId,
      ours,
      toolName: req?.toolName ?? null,
      reason: req?.reason ?? null,
    });
    log('info', `批准请求（${ours ? 'AWF 会话' : '非 AWF 会话'}）：tool=${req?.toolName ?? '?'} reason=${String(req?.reason ?? '').slice(0, 120)}`);
    return next();
  });

  // ── 回合边界 → AWF（订阅会话事件 firehose）──
  ctx.on('session/event', createTurnReporter({
    createdByAwf,
    inFlight,
    emit: (event, facts) => client?.emitEvent(event, facts),
  }));

  ctx.effect(() => {
    client.start();
    log('info', `指令通道启动：${awfBase}（profile=${process.env.DSH_HOME || '?'}）`);
    return () => {
      client.stop();
      log('info', '指令通道已停止');
    };
  }, 'awf-dsh: bridge client');
}

/**
 * 会话事件 → AWF 事件的翻译器（可单测的纯逻辑）。
 *
 * 只报 **AWF 自己创建的会话**（`createdByAwf`）：
 *   turn/start → `turn.started`（平台开始跑这一轮）
 *   turn/end   → `session.ready`（这一轮结束；AWF 的 busy→ready 靠这条）
 * 「平台受理回执」（prompt 的 accepted）与「回合结束」是两件事，分开上报。
 * @param {{createdByAwf: Set<string>, inFlight: Set<string>, emit: Function, log?: Function}} deps
 * @returns {(session: object, event: object) => void}
 */
export function createTurnReporter({ createdByAwf, inFlight, emit, log = () => {} }) {
  return (session, event) => {
    const sessionId = session?.header?.id ?? null;
    if (!sessionId) return;
    if (!createdByAwf.has(sessionId)) return; // 非 AWF 会话：不碰它的状态
    const cwd = session?.header?.cwd ?? null;
    if (event?.type === 'turn/start') {
      inFlight.add(sessionId);
      emit({ type: 'turn.started', sessionId, cwd }, { ready: false, sessionExists: true, sessionId, cwd });
      return;
    }
    if (event?.type === 'turn/end') {
      inFlight.delete(sessionId);
      emit(
        { type: 'session.ready', sessionId, cwd, reason: event?.data?.reason ?? null },
        { ready: true, sessionExists: true, sessionId, cwd },
      );
      return;
    }
    log('info', `忽略会话事件 ${event?.type}`);
  };
}

/** 供测试/诊断：不做装配，只暴露客户端工厂 */
export { createBridgeClient };
