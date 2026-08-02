/**
 * Auto-selector — 异步智能选择 AskUserQuestion 的答案。
 * 纯决策逻辑，tmux 交互委托给 src/server/tmux-keys.cjs。
 * 当前策略：等 5 秒后单选/多选均默认选第一项。
 */

const DEFAULT_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} decision - { multiSelect, options, question, header }
 * @returns {object} 选择方案
 */
export async function autoSelect(decision) {
  const timeout = DEFAULT_TIMEOUT_MS;

  if (decision.multiSelect && decision.options?.length > 0) {
    console.log(`     ⏳ ${timeout / 1000}s 后默认选第一项...`);
    await sleep(timeout);
    console.log(`     ✔ 自动选择: ${decision.options[0]}`);
    return { multiSelect: true, selected: [0], customInput: '' };
  }

  console.log(`     ⏳ ${timeout / 1000}s 后默认选第一项...`);
  await sleep(timeout);

  const label = decision.options?.[0] || '';
  console.log(`     ✔ 自动选择: ${label}`);
  return { index: 1, label };
}
