import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';

export async function attachCommand() {
  const session = process.env.CC_SESSION || 'cc';
  try {
    execSync(`tmux has-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    logger.error(`tmux session '${session}' 不存在，请先执行 awf run`);
    process.exit(1);
  }
  logger.info(`接入 session '${session}'（Ctrl-B D 脱离）...`);
  execSync(`tmux attach -t ${session}`, { stdio: 'inherit' });
}
