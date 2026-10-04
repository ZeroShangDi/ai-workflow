import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createIdleScheduler } = require('../../server/application/idle-scheduler.cjs');

function harness({ allowed = true, status = 'todo', activeClaims = [], managedCheckout = false } = {}) {
  const submit = vi.fn(async (_port, _root, endpoint) => endpoint.includes('prepare-worktree')
    ? { ok: true, data: { projectPath: '/managed/project', requirementId: 'req-1' } }
    : { ok: true });
  const app = {
    listActiveWorkClaims: () => activeClaims,
    listProjects: () => [{ checkout: { rootPath: '/repo/project' } }, ...(managedCheckout ? [{ checkout: { rootPath: '/managed/project' } }] : [])],
    readWorkConfig: () => ({ git: { repositoryRoot: '/repo', targetBranch: 'main' } }),
    ensureProject: () => ({ project: { activeRequirementId: 'req-1' } }),
    getRequirement: () => ({ id: 'req-1', workKind: 'requirement', lifecycleStatus: status, allowAiWork: allowed }),
    listBugs: () => [],
  };
  const registry = { all: () => [], runtimeFor: () => ({ ctx: { stores: { state: { readSync: () => ({ mode: 'idle' }) } } } }) };
  return { scheduler: createIdleScheduler({ app, registry, anyHostActive: () => false, port: 8787, submit }), submit };
}

describe('idle work scheduler', () => {
  it('starts an explicitly allowed todo in its prepared worktree', async () => {
    const { scheduler, submit } = harness();
    await scheduler.tick();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][3]).toEqual({ owner: 'idle' });
    expect(submit.mock.calls[1][1]).toBe('/managed/project');
  });
  it('does not claim unapproved, unauthorized, or already occupied work', async () => {
    for (const options of [{ allowed: false }, { status: 'draft' }, { activeClaims: [{ owner: 'manual' }] }]) {
      const { scheduler, submit } = harness(options);
      await scheduler.tick();
      expect(submit).not.toHaveBeenCalled();
    }
  });
  it('resumes an idle claim in its existing worktree after a server restart', async () => {
    const { scheduler, submit } = harness({ activeClaims: [{ owner: 'idle', itemType: 'requirement', itemId: 'req-1', worktreePath: '/managed' }], managedCheckout: true });
    await scheduler.tick();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][1]).toBe('/managed/project');
    expect(submit.mock.calls[0][2]).toBe('/api/persistence/run/start');
  });
});
