import { describe, it, expect } from 'vitest';
import { createProbe } from '../../src/adapters/probe.cjs';

describe('probe adapter（w-monitor 外部会话侦查）', () => {
  it('host.hasSession + status → 结构化报告', async () => {
    const probe = createProbe({
      host: { hasSession: () => true },
      status: async () => ({ state: 'ready', decisionPending: null }),
    });
    const r = await probe.inspect();
    expect(r.ok).toBe(true);
    expect(r.session).toBe(true);
    expect(r.state).toBe('ready');
    expect(typeof r.capturedAt).toBe('string');
  });

  it('无 status 时按 host 缺省判断；status 抛错 → state unknown', async () => {
    const p1 = createProbe({ host: { hasSession: () => false } });
    expect((await p1.inspect()).state).toBe('unknown');
    const p2 = createProbe({ host: { hasSession: () => true }, status: async () => { throw new Error('x'); } });
    const r2 = await p2.inspect();
    expect(r2.state).toBe('unknown');
    expect(r2.session).toBe(true);
  });
});
