import path from 'path';
import { spawn } from 'child_process';
import { pluginCmd } from '../lib/paths.js';
// import { setupVersion } from '../lib/version.js'; // 版本处理暂时禁用
import { logger } from '../lib/ui/log.js';

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

  // 3. 发起交互式对话
  await spawnClaude(cwd, buildPlanPrompt(description, options.resume));
}

// ── plan 专用 helper ──

/** 拼接 plan 阶段发送给 Claude Code 的 prompt 字符串 */
function buildPlanPrompt(description, resume) {
  if (resume) return `${pluginCmd('w-plan')} --resume 请恢复上次规划会话，继续对齐需求`;
  if (description) return `${pluginCmd('w-plan')} ${description}`;
  return `${pluginCmd('w-plan')} 请开始需求规划`;
}

/** spawn Claude Code 交互式进程 */
function spawnClaude(cwd, prompt) {
  return new Promise((resolve, reject) => {
    logger.info('启动规划会话...');
    logger.info(`  ${prompt}\n`);

    const proc = spawn('claude', [
      '--settings', path.join(cwd, '.claude', 'settings.json'),
      '--dangerously-skip-permissions',
      prompt,
    ], { stdio: 'inherit', cwd });

    proc.on('close', (code) => {
      if (code === 0 || code === null) { logger.success('规划会话结束'); resolve(); }
      else reject(new Error(`claude 异常退出，code: ${code}`));
    });
    proc.on('error', (err) => reject(new Error(`无法启动 claude: ${err.message}`)));
  });
}

// 安装/注册逻辑已迁移至 src/lib/profile.js（本地注册实现）
