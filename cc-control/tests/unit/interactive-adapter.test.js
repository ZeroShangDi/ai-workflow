import { describe, it, expect } from 'vitest';
import { launchInteractiveClaude, projectSettingsPath } from '../../src/adapters/interactive.cjs';

describe('interactive adapter（claude 字面只在 adapter）', () => {
  it('projectSettingsPath 指向 .claude/settings.json', () => {
    expect(projectSettingsPath('/p')).toBe('/p/.claude/settings.json');
  });

  it('导出 launchInteractiveClaude（spawn 交互式，不在 cli 拼 claude）', () => {
    expect(typeof launchInteractiveClaude).toBe('function');
  });
});
