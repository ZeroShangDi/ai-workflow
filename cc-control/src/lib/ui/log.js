import { CYAN, DIM, GREEN, YELLOW, RED, RESET } from './colors.js';

const LABEL_W = 16;

/**
 * 打印分区标题
 */
export function logSection(title) {
  console.log(`${DIM}  ▸ ${title}${RESET}`);
}

/**
 * 打印单行步骤结果
 * @param {string} label - 步骤标签（左对齐，16 字符宽度）
 * @param {'ok'|'warn'|'skip'|'error'} status
 * @param {string} msg
 */
export function logStep(label, status, msg) {
  const prefix = `     ${DIM}${label.padEnd(LABEL_W)}${RESET}`;
  switch (status) {
    case 'ok':
      console.log(`${prefix}${GREEN}✔ ${msg}${RESET}`);
      break;
    case 'warn':
      console.log(`${prefix}${YELLOW}⚠ ${msg}${RESET}`);
      break;
    case 'skip':
      console.log(`${prefix}${DIM}• ${msg}${RESET}`);
      break;
    case 'error':
      console.log(`${prefix}${RED}✘ ${msg}${RESET}`);
      break;
  }
}

/** 多 Agent 任务状态行：用前置图标表现同一任务的生命周期。 */
export function logTask(taskId, title, status) {
  const task = `${DIM}[${taskId}]${RESET} ${title || '未命名任务'}`;
  switch (status) {
    case 'active':
      console.log(`     ${CYAN}●${RESET} ${task}`);
      break;
    case 'done':
      console.log(`     ${GREEN}✓${RESET} ${task}`);
      break;
    case 'blocked':
      console.log(`     ${YELLOW}⚠${RESET} ${task}`);
      break;
  }
}

/**
 * 统一日志输出对象，供简单消息使用
 */
export const logger = {
  /** 次要信息 */
  info(msg) {
    console.log(`${DIM}  ${msg}${RESET}`);
  },
  /** 成功确认 */
  success(msg) {
    console.log(`${GREEN}✔ ${msg}${RESET}`);
  },
  /** 警告提示 */
  warn(msg) {
    console.log(`${YELLOW}⚠ ${msg}${RESET}`);
  },
  /** 错误信息（输出到 stderr） */
  error(msg) {
    console.error(`${RED}✘ ${msg}${RESET}`);
  },
};
