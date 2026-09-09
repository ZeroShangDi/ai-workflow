import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRunRegistry } = require('../../src/lib/run-registry.cjs');

// T1-068：registry 多槽 + per-run adapter 绑定 + run-context 多实例（W1-005 按 sid 多开）。

describe('createRunRegistry（多 run 槽 / per-run adapter 绑定）', () => {
  function makeFactory() {
    const optsSeen = [];
    return {
      optsSeen,
      factory: ({ sessionName, bus }) => { optsSeen.push({ sessionName, bus }); return { sessionName, tag: 'fake-adapter' }; },
    };
  }

  it('per-sid 槽：context 多实例（runSessionName=cc-<sid>/runDir 隔离）+ adapter 按 sid 绑定 + 缓存', () => {
    const { factory, optsSeen } = makeFactory();
    const reg = createRunRegistry({ projectRoot: '/p', adaptersFactory: factory });
    const a = reg.slot('a');
    const b = reg.slot('b');

    expect(a.ctx.runSessionName).toContain('cc-');
    expect(a.ctx.runSessionName.endsWith('-a')).toBe(true);
    expect(b.ctx.runSessionName.endsWith('-b')).toBe(true);
    expect(a.ctx.runSessionName).not.toBe(b.ctx.runSessionName);
    expect(a.ctx.runDir).not.toBe(b.ctx.runDir); // 每 run 目录 .awf/runs/<sid>/
    // adapter 绑定到各自会话名
    expect(a.adapters.sessionName).toBe(a.ctx.runSessionName);
    expect(b.adapters.sessionName).toBe(b.ctx.runSessionName);
    expect(optsSeen.map((o) => o.sessionName)).toEqual([a.ctx.runSessionName, b.ctx.runSessionName]);
    // 二次取同一槽 → 同一实例（不重复装配）
    expect(reg.slot('a')).toBe(a);
    expect(reg.size).toBe(2);
    // per-run 状态机隔离实例
    expect(a.sm).not.toBe(b.sm);
  });

  it('缺省 sid（null）→ 单 run 现状槽（无 per-run 目录）', () => {
    const { factory } = makeFactory();
    const reg = createRunRegistry({ projectRoot: '/p', adaptersFactory: factory });
    const d = reg.slot();
    expect(d.sid).toBe(null);
    expect(d.ctx.runDir).toBeUndefined();
    expect(d.adapters.sessionName).toBe(d.ctx.runSessionName);
    expect(reg.slot(null)).toBe(d); // null 与缺省同槽
  });

  it('list/has/remove/reset 槽管理', () => {
    const reg = createRunRegistry({ projectRoot: '/p', adaptersFactory: makeFactory().factory });
    reg.slot('a'); reg.slot('b'); reg.slot('c');
    expect(reg.has('a')).toBe(true);
    expect(reg.list().map((x) => x.sid)).toEqual(['a', 'b', 'c']);
    expect(reg.remove('b')).toBe(true);
    expect(reg.remove('b')).toBe(false);
    expect(reg.has('b')).toBe(false);
    expect(reg.size).toBe(2);
    reg.reset();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  it('projectRoot 贯通 buildRunContext（run-context 多实例）', () => {
    const reg = createRunRegistry({ projectRoot: '/myproj', adaptersFactory: makeFactory().factory });
    expect(reg.slot('x').ctx.projectRoot).toBe('/myproj');
    expect(reg.projectRoot).toBe('/myproj');
  });
});
