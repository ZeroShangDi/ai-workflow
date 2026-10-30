'use strict';
/**
 * probe.cjs — cc probe 端口（w-monitor 外部会话侦查）
 *
 * w-monitor 在不介入会话的前提下侦查外部 cc：会话是否存在 + 其状态（server /status 的
 * ready/busy/decisionPending 等）。createProbe({ host, status }) 组装结构化报告；
 * host/status 可注入（host 经 createHost/cc-<sid>，status 经 server 查询）。
 */

/**
 * @param {{ host?: object, status?: Function }} deps
 *   host    tmux host 端口（提供会话是否存在）；无则降级到「有无 sessionName」的弱判断
 *   status  异步查会话状态的函数（生产经 server /status）；无则 state 停在 unknown/present
 * @returns {{ inspect(): Promise<{ ok, session, state, capturedAt }> }}
 */
function createProbe({ host, status } = {}) {
  return {
    /**
     * 侦查：返回 { ok, session, state, capturedAt }；host/status 缺失按缺省判断。
     * ok 恒为 true —— 侦查本身没有「失败」态，信息不足用 state 表达（'unknown'），
     * 这样调用方（w-monitor）拿到的永远是结构化快照，不用区分异常路径。
     */
    async inspect() {
      // 会话是否存在：优先真查（host.hasSession）；退化形态（只给了会话名、没有查询方法）按「存在」处理
      const hasSession = typeof host?.hasSession === 'function' ? host.hasSession() : (host?.sessionName ? true : false);
      let state = 'unknown';
      if (typeof status === 'function') {
        try {
          const st = await status();
          state = st?.state || 'unknown';
        } catch {
          // 查状态失败不冒泡：侦查是只读观测，拿不到就记 unknown
          state = 'unknown';
        }
      } else if (host?.hasSession === undefined && host?.sessionName) {
        // 没有状态查询能力、但知道了会话名 → 只能表达到「存在」这一档
        state = 'present';
      }
      return { ok: true, session: hasSession, state, capturedAt: new Date().toISOString() };
    },
  };
}

module.exports = { createProbe };
