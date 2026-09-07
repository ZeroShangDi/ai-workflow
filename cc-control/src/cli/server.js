import { spawn, execSync } from 'child_process';
import { getStatus, sleep } from '../lib/session/client.js';
import { logger } from '../lib/ui/log.js';
import { buildRunContext } from '../lib/run-context.cjs';

/**
 * awf server — tmux-http 服务生命周期管理（路径/会话名/端口经 run-context 装配）
 */
export async function serverCommand(action) {
  const ctx = buildRunContext({ projectRoot: process.cwd() });

  switch (action) {
    case 'start': {
      const running = await checkServer(ctx.port);
      if (!running) {
        logger.info('启动 tmux-http ...');
        const proc = spawn('node', [ctx.serverScriptPath], {
          stdio: 'ignore',
          detached: true,
          cwd: ctx.infraRoot,
          env: { ...process.env, CC_PORT: String(ctx.port), CC_PROJECT: ctx.projectRoot },
        });
        proc.unref();

        for (let i = 0; i < 30; i++) {
          await sleep(500);
          if (await checkServer(ctx.port)) break;
        }
      }

      // 同时确保 tmux session 存在
      const bootstrap = ctx.bootstrapScriptPath;
      const session = ctx.runSessionName;
      try {
        execSync(`tmux has-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
      } catch {
        logger.info('创建 tmux session...');
        execSync(`bash "${bootstrap}"`, { stdio: 'inherit', cwd: process.cwd() });
      }

      logger.success(`环境就绪: server ${ctx.port}, session '${session}'`);
      logger.info('  awf run    启动工作流');
      logger.info('  awf attach 观看对话');
      return;
    }

    case 'stop': {
      const session = ctx.runSessionName;
      try {
        execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
      } catch {}

      execSync(`lsof -ti:${ctx.port} | xargs kill 2>/dev/null`, { stdio: 'ignore' });
      logger.success('已停止');
      break;
    }

    case 'status': {
      const running = await checkServer(ctx.port);
      if (running) {
        logger.success(`tmux-http 运行中: http://localhost:${ctx.port}`);
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
async function checkServer(port) {
  const status = await getStatus(port);
  return status?.state != null;
}
