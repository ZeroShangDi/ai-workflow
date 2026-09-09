import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rt = require('../../src/lib/runtime-config.cjs');

// T1-096：运行期常量单源（plugin/config.json 默认 + CC_* env 覆盖，strict 校验）直接单测。
// env 显式注入，避免依赖 process.env / 真实端口占用。

describe('runtime-config 单源解析', () => {
  it('缺省 env → 回落 plugin/config.json 单源默认', () => {
    const { port, session } = rt.readRuntimeConfig({});
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
    expect(typeof session).toBe('string');
    expect(session.length).toBeGreaterThan(0);
  });

  it('CC_PORT / CC_SESSION 覆盖 config 默认', () => {
    const { port, session } = rt.readRuntimeConfig({ CC_PORT: '9876', CC_SESSION: 'cc-r9' });
    expect(port).toBe(9876);
    expect(session).toBe('cc-r9');
  });

  it('别名函数委托一致', () => {
    expect(rt.getServerPort({ CC_PORT: '9999' })).toBe(9999);
    expect(rt.getSessionName({ CC_SESSION: 's-x' })).toBe('s-x');
    expect(rt.getServerPort({})).toBe(rt.readRuntimeConfig({}).port);
  });

  it('env 非法（strict）→ 抛错；port 越界 → 抛错', () => {
    expect(() => rt.readRuntimeConfig({ CC_PORT: 'abc' })).toThrow();
    expect(() => rt.readRuntimeConfig({ CC_PORT: '70000' })).toThrow();
    expect(() => rt.readRuntimeConfig({ CC_SESSION: '' })).toThrow();
  });

  it('runtimeConfigPath 指向 plugin/config.json（绝对路径，不受 cwd 影响）', () => {
    expect(rt.runtimeConfigPath().endsWith('plugin/config.json')).toBe(true);
    expect(rt.runtimeConfigPath()).toMatch(/^\//);
  });
});
