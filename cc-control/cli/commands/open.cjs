'use strict';
/**
 * cli/commands/open.cjs — 打开可视化页面（纯外部动作，无业务逻辑）
 *
 * 带 `?p=` 作用域：单 server 多项目，不带就会落到 server 的 boot 项目。
 */

const { spawn } = require('node:child_process');
const { buildContext } = require('../lib/context.cjs');

/** 页面别名 → 路径（server 静态托管按此映射） */
const TARGETS = { dashboard: '/dashboard', tree: '/tree', ui: '/ui' };

/** 环境就绪后打开项目页面；无头环境/浏览器命令缺失时保留地址，不阻断工作流。 */
async function openPage(ctx, target, { browser = process.env.AWF_BROWSER || 'open' } = {}) {
  const url = `http://localhost:${ctx.port}${TARGETS[target]}?p=${encodeURIComponent(ctx.projectRoot)}`;
  console.log(url);
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(browser, [url], { stdio: 'ignore', detached: true });
      proc.once('error', reject);
      proc.once('spawn', () => { proc.unref(); resolve(); });
    });
    return true;
  } catch (error) {
    console.warn(`  无法自动打开浏览器，请手动打开上面的地址：${error.message}`);
    return false;
  }
}

function openCommand(target, options = {}) {
  const ctx = buildContext(process.cwd());
  const pathname = TARGETS[target];
  if (!pathname) {
    console.error(`未知页面：${target}（可用 ${Object.keys(TARGETS).join(' | ')}）`);
    process.exit(2);
  }
  return openPage(ctx, target, options);
}

module.exports = { openCommand, openPage, TARGETS };
