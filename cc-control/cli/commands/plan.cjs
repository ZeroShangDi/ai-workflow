'use strict';
/**
 * cli/commands/plan.cjs — awf plan（只编排）
 *
 * 三步，全是调用：
 *   ① 非 resume 时归档残留的旧 state 并重置为空 plan 模板（run/pause 中不触发）；
 *   ② 取入口提示词（由插件 `prompts.json` 声明，CLI 不写死任何命令字面）；
 *   ③ 经 `interactive` 端口直开 cc 交互式对话（`claude` 字面只在 adapters）。
 *
 * 与旧 CLI 的差别只有调用方式：新树里 `state.js` / `prompts.js` 是 ESM，本命令是 CJS，
 * 故用动态 import（与 `server/runtime/index.cjs` 同一手法）。
 */

const { interactive } = require('../../server/adapters/ports.cjs');

async function planCommand(description, options = {}) {
  const projectRoot = process.cwd();

  if (!options.resume) {
    const { archiveOldStateForPlan } = await import('../../server/shared/state.js');
    const r = archiveOldStateForPlan(projectRoot);
    if (r.action === 'archived') console.log(`检测到旧 plan 状态，已归档：${r.archivedPath}`);
    else if (r.action === 'run-active') console.log('检测到 run 运行中（mode=run/pause），跳过 plan 重置');
  }

  const { planEntry } = await import('../../server/shared/prompts.js');
  const prompt = await planEntry(description, options.resume);

  console.log('启动规划会话…');
  await interactive.launchDialog({ cwd: projectRoot, prompt });
  console.log('规划会话结束');
}

module.exports = { planCommand };
