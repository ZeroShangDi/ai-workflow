import { planEntry } from '../lib/plugin-bridge.js';
// import { setupVersion } from '../lib/version.js'; // 版本处理暂时禁用
import { logger } from '../lib/ui/log.js';
import { archiveOldStateForPlan } from '../lib/state.js';
import { interactive } from '../adapters/ports.cjs'; // 端口经契约取用（T1-117）

/**
 * awf plan — 启动规划会话
 *
 * 流程：
 *   0. 非 resume：若存在残留旧 state（非 run/pause），先归档 .awf/versions/state-<ts>.json
 *      并重置为空 plan 模板（T1-104）——避免新规划叠加到旧任务上；run 模式不触发。
 *   1. 选择/确认版本号，写入 state.json（暂时禁用）
 *   2. 安装 profile settings（已移至 init 阶段，本地注册）
 *   3. 拼接 prompt，spawn claude 进入交互式对话
 */
export async function planCommand(description, options) {
  const cwd = process.cwd();

  // 0. 非 resume：残留旧 state → 归档 + 重置为空 plan 模板（run/pause 不触发）
  if (!options?.resume) {
    const r = archiveOldStateForPlan(cwd);
    if (r.action === 'archived') logger.info(`检测到旧 plan 状态，已归档：${r.archivedPath}`);
    else if (r.action === 'run-active') logger.info('检测到 run 运行中（mode=run/pause），跳过 plan 重置');
  }

  // 1. 版本号（暂时禁用）
  // await setupVersion(cwd);

  // 2. 安装 profile → 已移至 init 阶段做本地注册

  // 3. 发起交互式对话（入口提示词由插件 prompts.json 声明，见 plugin-bridge）
  await spawnClaude(cwd, await planEntry(description, options.resume));
}

// ── plan 专用 helper ──

/** spawn Claude Code 交互式进程（claude 字面在 interactive adapter，cli 零字面） */
async function spawnClaude(cwd, prompt) {
  logger.info('启动规划会话...');
  logger.info(`  ${prompt}\n`);
  await interactive.launchDialog({ cwd, prompt });
  logger.success('规划会话结束');
}

// 安装/注册逻辑已迁移至 src/lib/profile.js（本地注册实现）
