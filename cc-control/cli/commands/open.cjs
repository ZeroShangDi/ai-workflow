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

function openCommand(target, { browser = 'open' } = {}) {
  const ctx = buildContext(process.cwd());
  const pathname = TARGETS[target];
  if (!pathname) {
    console.error(`未知页面：${target}（可用 ${Object.keys(TARGETS).join(' | ')}）`);
    process.exit(2);
  }
  const url = `http://localhost:${ctx.port}${pathname}?p=${encodeURIComponent(ctx.projectRoot)}`;
  spawn(browser, [url], { stdio: 'ignore', detached: true }).unref();
  console.log(url);
}

module.exports = { openCommand, TARGETS };
