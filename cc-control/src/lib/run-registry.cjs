'use strict';
/**
 * run-registry.cjs — 多 run 槽注册表（T1-068：registry 多槽 + per-run adapter 绑定 + context 多实例）
 *
 * 现状 server.cjs 承载单 run（无 sid，模块顶层一个 ctx/会话）。多 run（sid 隔离）后每个
 * run 需独立的上下文（路径/会话名/端口 per run）与独立 adapter 绑定（host tmux 会话名
 * cc-<sid> 等）。本模块把「sid → { ctx, adapters, sm }」的装配收拢为注册表：
 *   - slot(sid)：惰性装配并缓存该 sid 的槽（缺省 sid=null 映射单 run 现状，runSessionName
 *     回落基础会话名）；同一 sid 二次取同一实例（多开不串）。
 *   - ctx：buildRunContext({ sid, projectRoot, env }) —— W1-005 装配器按 sid 真正多开
 *     （runDir/.awf/runs/<sid>/ 派生、runSessionName=cc-<sid>）。
 *   - adapters：per-run cc adapter 绑定（默认 createCcAdapters({ sessionName: ctx.runSessionName })，
 *     可注入工厂/测试夹具），使 host/hook 等作用于该 run 自己的会话。
 *   - sm：per-run 状态机实例（缺省 createStateMachine({sid})，可注入共享 createStateMachineRegistry）。
 *
 * T1-069 起把 tmux/socket/目录按 cc-<sid> 接入、T1-070 每 run settings 渲染 __SID__、
 * T1-071 /hook 按 sid 路由 —— 本模块为其提供按 sid 取槽的装配面。不改写现有 server 单槽。
 */

const { buildRunContext, ensureRunLayoutSync } = require('./run-context.cjs');
const { createCcAdapters } = require('../adapters/ports.cjs');
const { createStateMachine } = require('../server/statemachine.cjs');

const DEFAULT_KEY = '__default__';

/**
 * @param {{ projectRoot?: string, env?: object,
 *   adaptersFactory?: Function, smFactory?: Function, bus?: object }} opts
 *   adaptersFactory  默认 createCcAdapters（per-run sessionName 绑定）；测试注入夹具工厂
 *   smFactory        默认 (sid) => createStateMachine({ sid })
 * @returns {object} registry
 */
function createRunRegistry({
  projectRoot,
  env,
  adaptersFactory = createCcAdapters,
  smFactory = (sid) => createStateMachine({ sid }),
  bus,
} = {}) {
  const slots = new Map(); // key(sid) → { sid, ctx, adapters, sm }

  function key(sid) {
    return sid == null ? DEFAULT_KEY : String(sid);
  }

  function build(sid) {
    const ctx = buildRunContext({ sid, projectRoot, env });
    const adapters = adaptersFactory({ sessionName: ctx.runSessionName, bus });
    const sm = smFactory(sid == null ? null : sid);
    return { sid: sid == null ? null : String(sid), ctx, adapters, sm };
  }

  return {
    projectRoot,

    /** 取（惰性建）某 sid 的 run 槽；sid 缺省 → 单 run 现状槽 */
    slot(sid) {
      const k = key(sid);
      let s = slots.get(k);
      if (!s) {
        s = build(sid == null ? null : sid);
        slots.set(k, s);
      }
      return s;
    },

    has(sid) { return slots.has(key(sid)); },

    /**
     * 物化该 sid 的 per-run 目录布局（T1-069：目录按 .awf/runs/<sid>/ 命名接入）。
     * 无 sid（单 run 现状槽）不派生 per-run 目录 → 返回 []。
     * @returns {string[]} 已确保存在的目录
     */
    ensureLayout(sid) {
      const s = this.slot(sid);
      return ensureRunLayoutSync(s.ctx);
    },

    /** 已装配槽摘要（sid/会话名/每 run 目录） */
    list() {
      return [...slots.values()].map((s) => ({
        sid: s.sid,
        sessionName: s.ctx.runSessionName,
        runDir: s.ctx.runDir || null,
        projectRoot: s.ctx.projectRoot,
      }));
    },

    remove(sid) {
      const k = key(sid);
      if (!slots.has(k)) return false;
      slots.delete(k);
      return true;
    },

    reset() { slots.clear(); },

    get size() { return slots.size; },
  };
}

module.exports = { createRunRegistry, DEFAULT_KEY };
