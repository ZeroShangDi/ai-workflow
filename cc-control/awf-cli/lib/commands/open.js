import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { getPaths } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

const SERVER_PORT = 8787;

/**
 * awf open — 打开可视化页面
 */
export async function openCommand(target) {
  const paths = getPaths();

  switch (target) {
    case 'tree': {
      // 读取 awf-state.json 的 WBS，渲染 w-tree 模板
      const statePath = path.join(process.cwd(), '.awf', 'state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf-8'));

      if (!state.wbs) {
        logger.error('尚未规划，请先执行 awf plan');
        process.exit(1);
      }

      const html = renderTree(state);
      const outPath = path.join(process.cwd(), '.awf', 'w-tree.html');
      await fs.writeFile(outPath, html);
      await openBrowser(outPath);
      logger.success(`任务树已打开: ${outPath}`);
      break;
    }

    case 'ui':
    case 'dashboard': {
      const url = `http://localhost:${SERVER_PORT || 8787}`;
      logger.info(`打开 dashboard: ${url}`);
      await openBrowser(url);
      break;
    }

    default:
      logger.error(`未知目标: ${target}，可用: tree | ui | dashboard`);
      process.exit(1);
  }
}

function renderTree(state) {
  // 加载模板并替换数据
  const template = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>任务树 — AI Workflow</title>
<style>
  :root { --bg: #1a1a2e; --card: #16213e; --accent: #0f3460; --text: #eee; --done: #4caf50; --active: #ff9800; --pending: #666; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, sans-serif; padding: 24px; }
  h1 { margin-bottom: 16px; }
  .tree { padding-left: 20px; }
  .node { padding: 4px 0; cursor: pointer; }
  .node::before { content: attr(data-status); margin-right: 8px; }
  .node[data-status="✓"] { color: var(--done); }
  .node[data-status="●"] { color: var(--active); }
  .node[data-status="○"] { color: var(--pending); }
  .desc { font-size: 12px; color: #888; margin-left: 24px; }
</style>
</head>
<body>
<h1>任务树</h1>
<div class="tree" id="tree"></div>
<script>
const data = ${JSON.stringify(state.wbs, null, 2)};
function render(nodes, el) {
  nodes.forEach(n => {
    const div = document.createElement('div');
    div.className = 'node';
    div.setAttribute('data-status', n.done ? '✓' : n.status === 'active' ? '●' : '○');
    div.textContent = n.name;
    if (n.desc) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = n.desc; div.appendChild(d); }
    el.appendChild(div);
    if (n.children) render(n.children, el);
  });
}
render(data.children || data, document.getElementById('tree'));
</script>
</body>
</html>`;
  return template;
}

async function openBrowser(target) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [target], { stdio: 'ignore', detached: true }).unref();
}
