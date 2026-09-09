import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isIdleDue, idleDefaultMs, IDLE_MS_DEFAULT } = require('../../src/lib/server-idle.cjs');

const ENV = 'CC_SERVER_IDLE_MS';

describe('server-idle（T1-064 空闲回收判定）', () => {
  afterEach(() => { delete process.env[ENV]; });

  it('isIdleDue：达阈值触发；阈值<=0 或非法 → 永不触发', () => {
    const now = 100_000;
    expect(isIdleDue({ now, lastActivityAt: 0, idleMs: 60_000 })).toBe(true);
    expect(isIdleDue({ now, lastActivityAt: 40_001, idleMs: 60_000 })).toBe(false);
    expect(isIdleDue({ now, lastActivityAt: 0, idleMs: 0 })).toBe(false);
    expect(isIdleDue({ now, lastActivityAt: 0, idleMs: undefined })).toBe(false);
    expect(isIdleDue({ now, lastActivityAt: NaN, idleMs: 60_000 })).toBe(false);
  });

  it('idleDefaultMs：默认 30min；env 覆盖；0 = 禁用', () => {
    expect(idleDefaultMs()).toBe(IDLE_MS_DEFAULT);
    process.env[ENV] = '5000';
    expect(idleDefaultMs()).toBe(5000);
    process.env[ENV] = '0';
    expect(idleDefaultMs()).toBe(0);
    process.env[ENV] = 'abc';
    expect(idleDefaultMs()).toBe(IDLE_MS_DEFAULT); // 非法回落默认
  });
});
