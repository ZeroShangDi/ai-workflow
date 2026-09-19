'use strict';
/**
 * server/config.cjs — 控制平面运行期常量单源（平台无关的就绪/超时阈值）
 *
 * 原散在 server.cjs 顶部的超时阈值。集中在此，便于单测覆盖与运行期调整，
 * 也让「等多久算超时」这类判断只有一个出处 —— 谁想改阈值只有这一个文件可改。
 *
 * 全部支持环境变量覆盖（CC_*），缺省值即下方字面量；这里的常量是**装配期**读取的
 * 一次性快照，不随运行期变化（进程内不再重新读取 env）。
 *
 * 三个阈值都服务于**会话就绪/兜底**语义（session.waitReady、executor 自结算循环、
 * api 的兜底定时器）。
 *
 * `ENTER_DELAY_MS`（注文本与回车之间的节奏）**不在这里**：它是平台机制细节，T-P1-02 已
 * 下沉进 host 适配器（`server/adapters/cc/host.cjs` 的 `sendPrompt`，env 仍是 CC_ENTER_DELAY_MS）。
 */

module.exports = {
  /**
   * 等会话 ready / 自结算的变化窗口阈值（ms），缺省 2 分钟。
   * 两处语义共享同一个值：
   *   - session.waitReady(timeout)：会话从 busy 回到 ready 的最长等待；
   *   - executor 自结算循环：会话已 idle 但任务未落账时，累计「无变化」多久后交收尾协商。
   * 共用一个值是有意的 —— 「人/会话 卡住多久算异常」在全链路保持同一标准。
   */
  READY_TIMEOUT_MS: Number(process.env.CC_READY_TIMEOUT_MS || 120000),
  /**
   * 本地 slash 命令（/clear 等，无 Stop hook 回执）兜底回 ready 的时间（ms）。
   * 本地命令不产生 Stop 事件，会话态会一直卡在 busy；靠这个定时器强制放回 ready。
   */
  LOCAL_CMD_FALLBACK_MS: Number(process.env.CC_LOCAL_CMD_MS || 1500),
  /**
   * 人工决策应答后兜底回 ready 的时间（ms；人思考无上限，故很长，缺省 5 分钟）。
   * /respond 注入答案后起这个兜底：会话若迟迟不回 Stop，也不能把人锁在 busy 上。
   */
  DECISION_FALLBACK_MS: Number(process.env.CC_DECISION_FALLBACK_MS || 300000),
};
