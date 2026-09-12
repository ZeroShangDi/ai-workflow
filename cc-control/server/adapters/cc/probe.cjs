'use strict';
/**
 * probe.cjs — cc probe 端口（w-monitor 外部会话侦查）
 *
 * w-monitor 在不介入会话的前提下侦查外部 cc：会话是否存在 + 其状态（server /status 的
 * ready/busy/decisionPending 等）。createProbe({ host, status }) 组装结构化报告；
 * host/status 可注入（host 经 createHost/cc-<sid>，status 经 server 查询）。
 */

function createProbe({ host, status } = {}) {
  return {
    /** 侦查：返回 { ok, session, state, capturedAt }；host/status 缺失按缺省判断 */
    async inspect() {
      const hasSession = typeof host?.hasSession === 'function' ? host.hasSession() : (host?.sessionName ? true : false);
      let state = 'unknown';
      if (typeof status === 'function') {
        try {
          const st = await status();
          state = st?.state || 'unknown';
        } catch {
          state = 'unknown';
        }
      } else if (host?.hasSession === undefined && host?.sessionName) {
        state = 'present';
      }
      return { ok: true, session: hasSession, state, capturedAt: new Date().toISOString() };
    },
  };
}

module.exports = { createProbe };
