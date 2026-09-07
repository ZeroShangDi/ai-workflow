import { planEntry } from '../lib/plugin-bridge.js';
// import { setupVersion } from '../lib/version.js'; // 版本处理暂时禁用
import { logger } from '../lib/ui/log.js';
import { launchInteractiveClaude } from '../adapters/interactive.cjs';

/**
 * awf plan — 启动规划会话
 *
 * 流程：
 *   1. 选择/确认版本号，写入 state.json（暂时禁用）
 *   2. 安装 profile settings（已移至 init 阶段，本地注册）
 *   3. 拼接 prompt，spawn claude 进入交互式对话
 */
export async function planCommand(description, options) {
  const cwd = process.cwd();

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
  await launchInteractiveClaude({ cwd, prompt });
  logger.success('规划会话结束');
}

// 安装/注册逻辑已迁移至 src/lib/profile.js（本地注册实现）
