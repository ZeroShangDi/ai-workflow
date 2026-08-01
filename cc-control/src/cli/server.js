import { spawn, execSync } from 'child_process';
import http from 'http';
import path from 'path';
import { getPaths } from './paths.js';
import { logger } from './logger.js';

const SERVER_PORT = 8787;

/**
 * awf server — tmux-http 服务生命周期管理
 */
export async function serverCommand(action) {
  const paths = getPaths();

  switch (action) {
    case 'start': {
      const running = await check();
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
          if (await check()) break;
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
      // 清理 tmux session
      const session = process.env.CC_SESSION || 'cc';
      try {
        execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
      } catch {}

      // 清理 server
      execSync(`lsof -ti:${SERVER_PORT} | xargs kill 2>/dev/null`, { stdio: 'ignore' });
      logger.success('已停止');
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
