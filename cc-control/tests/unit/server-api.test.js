import { describe, it, expect } from 'vitest';
import { API_CATALOG, createRouter, assertHandlersComplete } from '../../src/server/api.cjs';

// server API 骨架（W1-027 / W3-003 api 分层接缝）：路由目录 + 分发器（legacy 与 /api/v1 别名语义一致）。

describe('createRouter — 分发', () => {
  const seen = [];
  const handlers = {
    status: () => 'status-ok',
    send: () => 'send-ok',
    respond: () => 'respond-ok',
    hook: () => 'hook-ok',
    awfDecisionsOverride: (ctx) => `override:${ctx.params.id}`,
  };
  const router = createRouter(handlers);

  it('legacy 路径命中对应 handler', () => {
    expect(router.dispatch('GET', '/status')).toBe('status-ok');
    expect(router.dispatch('POST', '/send', {})).toBe('send-ok');
    expect(router.dispatch('POST', '/hook')).toBe('hook-ok');
  });

  it('/api/v1 前缀别名命中同一 handler（迁移语义保留）', () => {
    expect(router.dispatch('GET', '/api/v1/status')).toBe('status-ok');
    expect(router.dispatch('POST', '/api/v1/send')).toBe('send-ok');
  });

  it('带尾斜杠归一化', () => {
    expect(router.dispatch('GET', '/status/')).toBe('status-ok');
  });

  it('override 前缀路由提取 params.id', () => {
    expect(router.dispatch('POST', '/awf/decisions/d1/override')).toBe('override:d1');
    expect(router.dispatch('POST', '/api/v1/awf/decisions/d1/override')).toBe('override:d1');
  });

  it('未挂接 handler 或未匹配 → undefined', () => {
    expect(router.dispatch('POST', '/status')).toBeUndefined(); // method 不符
    expect(router.dispatch('GET', '/nope')).toBeUndefined();
    expect(router.dispatch('GET', '/ui')).toBeUndefined(); // ui 未在 handlerMap
  });
});

describe('assertHandlersComplete — 接线自检', () => {
  it('缺漏端点抛错；allow 豁免后通过', () => {
    const partial = { status: () => {} };
    expect(() => assertHandlersComplete(partial)).toThrowError(/未挂接端点/);
    const allow = API_CATALOG.map((r) => r.name).filter((n) => n !== 'status');
    expect(() => assertHandlersComplete(partial, { allow })).not.toThrow();
  });

  it('目录名称唯一且覆盖 legacy/api 路径', () => {
    const names = API_CATALOG.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(API_CATALOG.length).toBeGreaterThan(15);
  });
});
