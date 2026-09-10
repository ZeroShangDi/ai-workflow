import { spawn } from 'child_process';
import { logger } from '../lib/ui/log.js';
import { SERVER_PORT } from '../lib/session/client.js';

/**
 * awf open — 打开可视化页面（dashboard / tree）
 *
 * T1-066：移除 open tree 的 CLI 端 HTML 渲染（renderTree / .awf/w-tree.html 生成）。
 * T1-093：web 构建产物由 server 静态托管（React SPA 承载 root），tree 指向其 WBS-Tree 视图
 * （?view=wbs-tree），dashboard 指向 SPA 承载的 root。
 * T1-094：ui.html（调试/控制页）已废弃删除，不再作为 open 目标。
 * 多项目：URL 带 ?p=<cwd>，页面按本项目作用域取数（缺 p 会落到 server 的 boot 项目）。
 */
export async function openCommand(target) {
  const project = process.cwd();
  const scope = `p=${encodeURIComponent(project)}`;
  const url = `http://localhost:${SERVER_PORT}`;
  switch (target) {
    case 'tree': {
      const targetUrl = `${url}/?view=wbs-tree&${scope}`;
      logger.info(`打开 WBS-Tree（web 视图）: ${targetUrl}`);
      openBrowser(targetUrl);
      break;
    }

    case 'dashboard': {
      const targetUrl = `${url}/?${scope}`;
      logger.info(`打开 dashboard: ${targetUrl}`);
      openBrowser(targetUrl);
      break;
    }

    default:
      logger.error(`未知目标: ${target}，可用: tree | dashboard`);
      process.exit(1);
  }
}

/** 跨平台打开浏览器 */
function openBrowser(target) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [target], { stdio: 'ignore', detached: true }).unref();
}
