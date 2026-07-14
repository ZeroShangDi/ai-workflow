import { spawn } from 'child_process';
import http from 'http';
import { getPaths } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

const SERVER_PORT = 8787;

/**
 * awf run — 启动自治开发工作流
 * 1. 确保 tmux-http 服务在线
 * 2. 注入 /awf-run 上下文启动 Claude Code
 */
export async function runCommand(task, options) {
  const { auto, resume } = options;
  const paths = getPaths();

  // 1. 确保 server 在线
  const serverRunning = await checkServer();
  if (!serverRunning) {
    logger.info('tmux-http 未运行，正在启动...');
    await startServer(paths);
  }
  logger.success('tmux-http 已就绪');

  // 2. 构建 prompt
  let prompt = '/awf-run';
  if (auto) prompt += ' --auto';
  if (resume) prompt += ' --resume';
  if (task) prompt += ` ${task}`;

  logger.info(`启动工作流: ${prompt}\n`);

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
        logger.success('工作流结束');
      } else {
        logger.warn(`claude 退出，code: ${code}`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      reject(new Error(`无法启动 claude: ${err.message}`));
    });
  });
}

async function checkServer() {
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

async function startServer(paths) {
  const proc = spawn('node', [paths.tmuxServer], {
    stdio: 'ignore',
    detached: true,
    cwd: paths.tmuxHttp,
    env: { ...process.env, CC_PORT: String(SERVER_PORT) },
  });
  proc.unref();

  // 等待 server 就绪
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await checkServer()) return;
  }
  throw new Error('tmux-http 启动超时');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
