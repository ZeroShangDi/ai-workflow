import { spawn, execSync } from 'child_process';
import { getPaths } from '../lib/paths.js';
import { getStatus, sleep, SERVER_PORT } from '../lib/session/client.js';
import { logger } from '../lib/ui/log.js';

/**
 * awf server — tmux-http 服务生命周期管理
 */
export async function serverCommand(action) {
  const paths = getPaths();

  switch (action) {
    case 'start': {
      const running = await checkServer();
      if (!running) {
        logger.info('启动 tmux-http ...');
        const proc = spawn('node', [paths.tmuxServer], {
          stdio: 'ignore',
          detached: true,
          cwd: paths.projectRoot,
          env: { ...process.env, CC_PORT: String(SERVER_PORT), CC_PROJECT: process.cwd() },
        });
        proc.unref();

        for (let i = 0; i < 30; i++) {
          await sleep(500);
          if (await checkServer()) break;
        }
      }

      // 同时确保 tmux session 存在
      const bootstrap = paths.bootstrapScript;
      const session = process.env.CC_SESSION || 'cc';
      try {
        execSync(`tmux has-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
      } catch {
        logger.info('创建 tmux session...');
        execSync(`bash "${bootstrap}"`, { stdio: 'inherit', cwd: process.cwd() });
      }

      logger.success(`环境就绪: server ${SERVER_PORT}, session '${session}'`);
      logger.info('  awf run    启动工作流');
      logger.info('  awf attach 观看对话');
      return;
    }

    case 'stop': {
      const session = process.env.CC_SESSION || 'cc';
      try {
        execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
      } catch {}

      execSync(`lsof -ti:${SERVER_PORT} | xargs kill 2>/dev/null`, { stdio: 'ignore' });
      logger.success('已停止');
      break;
    }

    case 'status': {
      const running = await checkServer();
      if (running) {
        logger.success(`tmux-http 运行中: http://localhost:${SERVER_PORT}`);
      } else {
        logger.info('tmux-http 未运行');
      }
      break;
    }

    default:
      logger.error(`未知操作: ${action}，可用: start | stop | status`);
      process.exit(1);
  }
}

/** 检查 server 是否可连通（返回 true/false，不抛异常） */
async function checkServer() {
  const status = await getStatus(SERVER_PORT);
  return status?.state != null;
}
