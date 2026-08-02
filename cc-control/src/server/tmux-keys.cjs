'use strict';

/**
 * tmux-keys — 通过 tmux send-keys 控制交互式 UI（选项选择、自定义输入、多选）。
 * 供 CLI 端 auto-selector 调用，独立于 server HTTP 层。
 */

const { execSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按 1-based 序号选择选项。
 */
async function selectOption(session, index) {
  execSync(`tmux send-keys -t ${session} "${index}" Enter`, { stdio: 'ignore' });
}

/**
 * 导航到输入框并填入自定义文本。
 * 焦点默认在第一个选项，按 ↓ 跳过所有选项后到达输入框。
 */
async function inputCustom(session, text, optionsCount) {
  for (let i = 0; i < optionsCount; i++) {
    execSync(`tmux send-keys -t ${session} Down`, { stdio: 'ignore' });
    await sleep(150);
  }
  await sleep(400);

  for (const ch of text) {
    execSync(`tmux send-keys -t ${session} -l "${ch}"`, { stdio: 'ignore' });
    await sleep(80);
  }
  await sleep(200);

  execSync(`tmux send-keys -t ${session} Enter`, { stdio: 'ignore' });
}

/**
 * 多选：遍历选项，Space 勾选指定项，最后可选自定义输入。
 * @param {string} session
 * @param {number[]} selectedIndices - 要选中的选项序号（0-based）
 * @param {number} optionsCount
 * @param {string} [customText] - 自定义输入文本（为空则选完直接确认）
 */
async function selectMulti(session, selectedIndices, optionsCount, customText) {
  const selected = new Set(selectedIndices);

  for (let i = 0; i < optionsCount; i++) {
    if (selected.has(i)) {
      execSync(`tmux send-keys -t ${session} Space`, { stdio: 'ignore' });
      await sleep(150);
    }
    execSync(`tmux send-keys -t ${session} Down`, { stdio: 'ignore' });
    await sleep(150);
  }

  if (customText) {
    execSync(`tmux send-keys -t ${session} Space`, { stdio: 'ignore' });
    await sleep(300);
    for (const ch of customText) {
      execSync(`tmux send-keys -t ${session} -l "${ch}"`, { stdio: 'ignore' });
      await sleep(80);
    }
    await sleep(200);
  }

  execSync(`tmux send-keys -t ${session} Enter`, { stdio: 'ignore' });
}

module.exports = { selectOption, inputCustom, selectMulti };
