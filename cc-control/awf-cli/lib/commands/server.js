import { spawn } from 'child_process';
import http from 'http';
import { getPaths } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

const SERVER_PORT = 8787;

/**
 * awf server — tmux-http 服务生命周期管理
 */
export async function serverCommand(action) {
  const paths = getPaths();

  switch (action) {
    case 'start': {
      const running = await check();
      if (running) {
        logger.info(`tmux-http 已在运行 (port ${SERVER_PORT})`);
        return;
      }

      logger.info('启动 tmux-http ...');
      const proc = spawn('node', [paths.tmuxServer], {
        stdio: 'inherit',
        detached: true,
        cwd: paths.tmuxHttp,
        env: { ...process.env, CC_PORT: String(SERVER_PORT) },
      });
      proc.unref();

      for (let i = 0; i < 30; i++) {
        await sleep(500);
        if (await check()) {
          logger.success(`tmux-http 已启动: http://localhost:${SERVER_PORT}`);
          return;
        }
      }
      logger.error('启动超时');
      process.exit(1);
    }

    case 'stop': {
      const running = await check();
      if (!running) {
        logger.info('tmux-http 未运行');
        return;
      }

      // 调用 shutdown endpoint，或直接 kill
      try {
        await fetch(`http://127.0.0.1:${SERVER_PORT}/shutdown`, { method: 'POST' });
      } catch {
        // server.js 没有 shutdown endpoint，用 kill
      }

      const { execSync } = await import('child_process');
      execSync(`lsof -ti:${SERVER_PORT} | xargs kill 2>/dev/null`, { stdio: 'ignore' });
      logger.success('tmux-http 已停止');
      break;
    }

    case 'status': {
      const running = await check();
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

async function check() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${SERVER_PORT}/status`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
