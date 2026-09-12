'use strict';
/**
 * server/config.cjs — 控制平面运行期常量单源
 *
 * 原散在 server.cjs 顶部的四个超时/延迟阈值。集中在此，便于单测覆盖与运行期调整，
 * 也让「等多久算超时」这类判断只有一个出处 —— 谁想改阈值只有这一个文件可改。
 *
 * 全部支持环境变量覆盖（CC_*），缺省值即下方字面量；这里的常量是**装配期**读取的
 * 一次性快照，不随运行期变化（进程内不再重新读取 env）。
 *
 * 这些阈值有两类消费方：
 *   ① 注入节奏（ENTER_DELAY_MS）—— 由 api/executor/channel 的 tmux 注文本原语用；
 *   ② 就绪/超时（其余三个）—— 由 session.waitReady、executor 自结算循环、api 的兜底定时器用。
 */

module.exports = {
  /**
   * 等会话 ready / 自结算的变化窗口阈值（ms），缺省 2 分钟。
   * 两处语义共享同一个值：
   *   - session.waitReady(timeout)：CC 从 busy 回到 ready 的最长等待；
   *   - executor 自结算循环：CC 已 idle 但任务未落账时，累计「无变化」多久后交收尾协商。
   * 共用一个值是有意的 —— 「人/CC 卡住多久算异常」在全链路保持同一标准。
   */
  READY_TIMEOUT_MS: Number(process.env.CC_READY_TIMEOUT_MS || 120000),
  /**
   * 注文本与回车之间的间隔（ms）。tmux send-keys 分两次（文本、回车），
   * 必须留出间隔让 CC 的输入框先收下文本，再单独收到回车 —— 同帧发送会丢回车。
   */
  ENTER_DELAY_MS: Number(process.env.CC_ENTER_DELAY_MS || 200),
  /**
   * 本地 slash 命令（/clear 等，无 Stop hook 回执）兜底回 ready 的时间（ms）。
   * 本地命令不产生 Stop 事件，会话态会一直卡在 busy；靠这个定时器强制放回 ready。
   */
  LOCAL_CMD_FALLBACK_MS: Number(process.env.CC_LOCAL_CMD_MS || 1500),
  /**
   * 人工决策应答后兜底回 ready 的时间（ms；人思考无上限，故很长，缺省 5 分钟）。
   * /respond 注入答案后起这个兜底：CC 若迟迟不回 Stop，也不能把人锁在 busy 上。
   */
  DECISION_FALLBACK_MS: Number(process.env.CC_DECISION_FALLBACK_MS || 300000),
};
