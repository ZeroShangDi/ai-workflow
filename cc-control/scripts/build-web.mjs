#!/usr/bin/env node
/**
 * build-web.mjs — web/（React+Vite）构建进 pipeline（T1-118）
 *
 * ## 为什么需要这一步
 * T1-093 把 **接线** 做完了：`vite.config.js` 的 `build.outDir` 指向 `src/server/public`、
 * server 端 SPA 托管也通了。但**没有任何环节会去构建** —— `scripts/build.sh` 不碰 web、
 * 没有 prepack、`web/node_modules` 从来没装上过。于是「接线在」而「产物不存在」，
 * 发布出去的 npm 包里根本没有前端。这正是 `.awf/issues/002` 说的那种落差：
 * 接线 ≠ 被触发，而**「被触发」不是任何人的任务**。
 *
 * ## 依赖缺失不静默跳过
 * - 正常：`cd web && npm run build` → 断言 `src/server/public/index.html` 存在
 * - 缺依赖：报错退出并给出修复命令（不猜、不自动装 —— 装依赖是使用者的决定）
 * - 显式跳过：`AWF_SKIP_WEB=1`（打印醒目警告）；`--required`（发布路径）忽略该开关
 *
 * 用法：
 *   node scripts/build-web.mjs             构建（AWF_SKIP_WEB=1 可跳过）
 *   node scripts/build-web.mjs --required  prepack 用：忽略跳过开关，产物必须存在
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const ARTIFACT = path.join(ROOT, 'src', 'server', 'public', 'index.html');
const required = process.argv.includes('--required');
const skipRequested = process.env.AWF_SKIP_WEB === '1' && !required;

if (!fs.existsSync(path.join(WEB, 'package.json'))) {
  console.error('[build-web] 找不到 web/package.json —— 仓库结构不对');
  process.exit(2);
}

const depsInstalled = fs.existsSync(path.join(WEB, 'node_modules', 'vite'));

if (!depsInstalled) {
  if (skipRequested) {
    console.warn('[build-web] ⚠ AWF_SKIP_WEB=1：跳过前端构建。');
    console.warn('[build-web] ⚠ 本次产物**不含前端**（server 将回落到旧页面），不要用于发布。');
    process.exit(0);
  }
  console.error('[build-web] ✘ 前端依赖未安装：web/node_modules 下找不到 vite，构建无法进行。');
  console.error('[build-web]   修复：cd web && npm install');
  console.error('[build-web]   （注意：web 的 devDependencies 曾存在 peer 冲突导致 install 直接失败，');
  console.error('[build-web]    见 T1-118：eslint-plugin-react-hooks 4.x 的 peer 上限是 eslint 8，需 >=5）');
  console.error('[build-web]   确需跳过：AWF_SKIP_WEB=1 npm run build —— 产物将不含前端');
  process.exit(1);
}

console.log('[build-web] 构建 web/ → src/server/public …');
try {
  execFileSync('npm', ['run', 'build'], { cwd: WEB, stdio: 'inherit' });
} catch (e) {
  console.error(`[build-web] ✘ 前端构建失败（exit ${e.status ?? '?'}）`);
  process.exit(1);
}

if (!fs.existsSync(ARTIFACT)) {
  console.error(`[build-web] ✘ 构建结束但产物缺失：${path.relative(ROOT, ARTIFACT)}`);
  console.error('[build-web]   检查 web/vite.config.js 的 build.outDir 是否仍指向 ../src/server/public');
  process.exit(1);
}

const bytes = fs.statSync(ARTIFACT).size;
console.log(`[build-web] ✓ 产物就绪：src/server/public/（index.html ${bytes}B）`);
