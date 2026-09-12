'use strict';
/**
 * server/config.cjs — 控制平面运行期常量单源
 *
 * 原散在 server.cjs 顶部的四个超时/延迟阈值。集中在此，便于单测覆盖与运行期调整，
 * 也让「等多久算超时」这类判断只有一个出处。
 */

module.exports = {
  /** 等会话 ready / 自结算的变化窗口阈值（ms） */
  READY_TIMEOUT_MS: Number(process.env.CC_READY_TIMEOUT_MS || 120000),
  /** 注文本与回车之间的间隔（tmux 注入节奏） */
  ENTER_DELAY_MS: Number(process.env.CC_ENTER_DELAY_MS || 200),
  /** 本地 slash 命令（无 Stop hook）兜底回 ready 的时间（ms） */
  LOCAL_CMD_FALLBACK_MS: Number(process.env.CC_LOCAL_CMD_MS || 1500),
  /** 人工决策应答后兜底回 ready 的时间（ms；人思考无上限，故很长） */
  DECISION_FALLBACK_MS: Number(process.env.CC_DECISION_FALLBACK_MS || 300000),
};
