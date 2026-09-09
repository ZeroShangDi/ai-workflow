import { describe, it, expect } from 'vitest';
import tooling from '../../src/adapters/tooling.cjs';

const { buildMarketplaceAdd, buildInstall, buildUninstall, install, uninstall } = tooling;

describe('tooling adapter（plugin 安装/市场；claude 字面只在 adapter）', () => {
  it('命令构造含 claude plugin 前缀与参数', () => {
    expect(buildMarketplaceAdd('/p/plugin')).toBe('claude plugin marketplace add "/p/plugin"');
    expect(buildInstall('ai-workflow-dev:ai-workflow-core@2.0.0')).toBe('claude plugin install ai-workflow-dev:ai-workflow-core@2.0.0');
    expect(buildUninstall('ai-workflow-core')).toBe('claude plugin uninstall ai-workflow-core');
  });

  it('install/uninstall：可注入 execAsync 执行；无则返回命令', async () => {
    const calls = [];
    await install('spec', { execAsync: async (cmd) => { calls.push(cmd); return { ok: true }; } });
    expect(calls[0]).toContain('claude plugin install spec');
    expect(await uninstall('x')).toBe('claude plugin uninstall x');
  });
});
