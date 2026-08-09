/**
 * 终端 ANSI 转义序列，用于彩色输出
 * init.js / run.js / plan.js 共用
 */

/** 青色 — 标题、主要信息 */
export const CYAN = '\x1b[36m';
/** 绿色 — 成功状态 */
export const GREEN = '\x1b[32m';
/** 黄色 — 警告状态 */
export const YELLOW = '\x1b[33m';
/** 红色 — 错误状态 */
export const RED = '\x1b[31m';
/** 灰色/暗色 — 次要信息、前缀 */
export const DIM = '\x1b[2m';
/** 重置所有样式 */
export const RESET = '\x1b[0m';
