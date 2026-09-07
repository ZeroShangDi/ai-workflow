import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServerApp } from '../../src/server/app.cjs';

// server 控制平面应用骨架（W1-026 / W3-003 bootstrap 接缝）：boot 装配 + 优雅关闭 + 健康 + config 装载。
// 行为不变：只装配 run-context/store/config，不重写既有 server.cjs/cli run。

const tmpDirs = [];
function tmpProject(runConfigText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-app-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  if (runConfigText !== undefined) fs.writeFileSync(path.join(root, '.awf', 'config.json'), runConfigText);
  return root;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('createServerApp — boot 装配', () => {
  it('ctx/store 装配（每 run sid）', () => {
    const app = createServerApp({ projectRoot: '/p', sid: 'run1' });
    expect(app.ctx.runDir).toBe('/p/.awf/runs/run1');
    expect(app.ctx.runSessionName).toBe('cc-run1');
    expect(app.stores.state.filePath).toBe('/p/.awf/runs/run1/state.json');
  });

  it('健康状态含 ok/pid/projectRoot/sid/port', () => {
    const app = createServerApp({ projectRoot: '/p', sid: 'r' });
    const h = app.health();
    expect(h.ok).toBe(true);
    expect(h.pid).toBe(process.pid);
    expect(h.projectRoot).toBe('/p');
    expect(h.sid).toBe('r');
    expect(h.port).toBe(8787);
    expect(typeof h.uptimeMs).toBe('number');
  });
});

describe('config 装载', () => {
  it('infra：plugin/config.json 单源经 config-loader（port/engineDir/marketplace）', () => {
    const app = createServerApp({ projectRoot: '/p' });
    const infra = app.config.infra();
    expect(infra.port).toBe(8787);
    expect(infra.engineDir).toBe('core');
    expect(Array.isArray(infra.marketplace.plugins)).toBe(true);
  });

  it('run：.awf/config.json 可选（缺失 → null，存在 → 解析）', () => {
    const root = tmpProject(JSON.stringify({ run: { agents: { max: 3 } } }));
    expect(createServerApp({ projectRoot: root }).config.run()).toEqual({ run: { agents: { max: 3 } } });
    expect(createServerApp({ projectRoot: tmpProject() }).config.run()).toBeNull();
  });
});

describe('优雅关闭', () => {
  it('onShutdown 注册，shutdown 逆序执行', () => {
    const app = createServerApp({ projectRoot: '/p' });
    const order = [];
    app.onShutdown(() => order.push(1));
    app.onShutdown(() => order.push(2));
    expect(app.shutdown()).toEqual([]);
    expect(order).toEqual([2, 1]);
  });

  it('单项异常被吞并返回错误列表', () => {
    const app = createServerApp({ projectRoot: '/p' });
    app.onShutdown(() => { throw new Error('boom'); });
    const errs = app.shutdown();
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('boom');
  });

  it('onShutdown 非函数抛错', () => {
    const app = createServerApp({ projectRoot: '/p' });
    expect(() => app.onShutdown('x')).toThrowError(/须为函数/);
  });
});
