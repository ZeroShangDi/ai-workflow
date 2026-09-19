import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES, VIEWS, getRoute } from '../../web/src/app/routes.js';
import { readRoute } from '../../web/src/app/router.js';

const require = createRequire(import.meta.url);
const { TARGETS } = require('../../cli/commands/open.cjs');
const { createStaticHost } = require('../../server/web/static.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PUBLIC = path.join(ROOT, 'server', 'web', 'public');

/**
 * 三个 CLI 入口页（U4：先做空页面）+ 路由不静默回退。
 *
 * 背景：`awf open dashboard|tree|ui` 打开的是 `/dashboard` `/tree` `/ui`。路由表里没有这些 key 时
 * `getRoute()` 会**回退到第一页（项目）** —— 用户以为打开了新页面，看到的却是别处界面，
 * 而 CLI 与日志都不会有任何异常（典型的假成功）。这里把「入口 → 页面」的对应关系钉住。
 */

describe('web 路由 · CLI 入口页不静默回退', () => {
  it('open 的三个 target 都对应真实登记的路由 key（不是回退到第一页）', () => {
    for (const [target, pathname] of Object.entries(TARGETS)) {
      const key = pathname.replace(/^\//, '');
      const route = ROUTES.find((r) => r.key === key);
      expect(route, `${target} → ${pathname} 未登记路由`).toBeTruthy();
      expect(getRoute(key).key).toBe(key);
      expect(readRoute({ pathname, search: '' }).view).toBe(key);
    }
  });

  it('三个入口是**占位页**（U4：先建空页面，不冒充完整业务 UI）', () => {
    for (const key of ['dashboard', 'tree', 'ui']) {
      const route = getRoute(key);
      expect(route.placeholder, key).toBe(true);
      expect(route.hidden, key).toBe(true);       // 不挤进主导航：入口由 CLI 提供
      expect(route.label, key).toBeTruthy();
    }
  });

  it('未登记的 view 仍然回退到第一页 —— 但三个 CLI 入口不在其列（上一条已钉）', () => {
    expect(getRoute('no-such-page').key).toBe(ROUTES[0].key);
    expect(VIEWS.every((r) => !r.hidden)).toBe(true);
    expect(VIEWS.some((r) => ['dashboard', 'tree', 'ui'].includes(r.key))).toBe(false);
  });
});

// 产物是**构建出来的**（`server/web/public/` 在 .gitignore 里，不进 git）：
// 没有产物就跳过（构建由 `npm run build` / prepack 负责），有产物就必须是新的 —— 后者才是
// 「改了源码忘了重新构建」这条真缺陷的护栏。
const BUILT = fs.existsSync(path.join(PUBLIC, 'index.html'));

describe.skipIf(!BUILT)('web 产物 · 入口页真的在构建产物里', () => {
  it('server 的静态托管把 /dashboard /tree /ui 交给 SPA 壳（不是 404/503）', () => {
    const host = createStaticHost({ root: PUBLIC, aliases: { '/': 'index.html' }, spa: 'index.html' });
    for (const pathname of Object.values(TARGETS)) {
      const file = host.resolve(pathname);
      expect(file, pathname).toBeTruthy();
      expect(path.basename(file), pathname).toBe('index.html');
    }
  });

  it('构建产物里含占位页文案（改了源码没重新构建 → 这里红）', () => {
    const dir = path.join(PUBLIC, 'assets');
    const hit = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
      .some((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('完整业务 UI 待逐页指导后实现'));
    expect(hit).toBe(true);
  });

  it('产物不比路由源码旧（改完源码要重新构建）', () => {
    const builtAt = fs.statSync(path.join(PUBLIC, 'index.html')).mtimeMs;
    for (const rel of ['web/src/app/routes.js', 'web/src/pages/Placeholder/index.jsx']) {
      const src = fs.statSync(path.join(ROOT, rel)).mtimeMs;
      expect(builtAt, `${rel} 比构建产物新 —— 需要重新构建（node scripts/build-web.mjs）`).toBeGreaterThan(src);
    }
  });
});
