import { spawn, execSync } from 'child_process';
import { getStatus, sleep } from '../lib/session/client.js';
import { logger } from '../lib/ui/log.js';
import { buildRunContext, projectSid } from '../lib/run-context.cjs';

/**
 * awf server — tmux-http 服务生命周期管理（路径/会话名/端口经 run-context 装配）
 */
export async function serverCommand(action) {
  // 会话名按项目唯一化（单 server 多项目：不同目录不共用 `cc` 而互相 kill）
  const ctx = buildRunContext({ projectRoot: process.cwd(), sid: projectSid(process.cwd()) });

  switch (action) {
    case 'start': {
      // T1-063+：存在即复用（单 server 多项目）；他项目 server 占用也复用（经 ?p 路由到本项目）
      const existing = await getStatus(ctx.port);
      if (existing?.state) {
        logger.info(existing.projectRoot === ctx.projectRoot
          ? 'tmux-http 已运行 → 复用'
          : `tmux-http 已运行（${existing.projectRoot} 驻留）→ 复用（单 server 多项目，本项目经 ?p 路由）`);
      } else {
        logger.info('启动 tmux-http ...');
        const proc = spawn('node', [ctx.serverScriptPath], {
          stdio: 'ignore',
          detached: true,
          cwd: ctx.projectRoot,
          env: { ...process.env, CC_PORT: String(ctx.port), CC_PROJECT: ctx.projectRoot },
        });
        proc.unref();

        for (let i = 0; i < 30; i++) {
          await sleep(500);
          const s = await getStatus(ctx.port);
          if (s?.state) break;
        }
        if (!(await getStatus(ctx.port))?.state) {
          logger.error('tmux-http 启动超时（端口可能被非 awf 进程占用）');
          return;
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

      // T1-064：优先请求常驻 server 优雅关闭（/shutdown）；失败（无 server/旧版）再 kill-by-port
      const shut = await requestShutdown(ctx.port);
      if (!shut) {
        execSync(`lsof -ti:${ctx.port} | xargs kill 2>/dev/null`, { stdio: 'ignore' });
      }
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

/** 请求常驻 server 优雅关闭（POST /shutdown）；失败/超时返回 false */
async function requestShutdown(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
