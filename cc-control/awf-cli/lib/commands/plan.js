import { spawn } from 'child_process';
import { getPaths } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

/**
 * awf plan — 启动规划会话
 * 将描述注入 /w-plan 上下文，启动 Claude Code 交互
 */
export async function planCommand(description, options) {
  const { resume } = options;
  const paths = getPaths();

  const prompt = resume
    ? '/w-plan --resume 请恢复上次规划会话，继续对齐需求'
    : description
      ? `/w-plan ${description}`
      : '/w-plan 请开始需求规划';

  logger.info('启动规划会话...');
  logger.info(`  ${prompt}\n`);

  const args = [
    '--settings', paths.ccSettings,
    '--dangerously-skip-permissions',
    prompt,
  ];

  const proc = spawn('claude', args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  await new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0 || code === null) {
        logger.success('规划会话结束');
        resolve();
      } else {
        reject(new Error(`claude 异常退出，code: ${code}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`无法启动 claude: ${err.message}`));
    });
  });
}
