import { describe, it, expect } from 'vitest';
import { generateRunSettings } from '../../src/server/run-settings.cjs';

// run 专用 settings 生成归 cc（W1-044）：statusLine 等 cc 格式（T1-065 移 crossSessionInbound）。

describe('generateRunSettings', () => {
  it('statusLine 命令指向 context-usage', () => {
    const s = generateRunSettings({ workdir: '/w', contextUsageScript: '/infra/scripts/context-usage.mjs' });
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toBe('node "/infra/scripts/context-usage.mjs" "/w"');
    expect(s.statusLine.refreshInterval).toBe(30);
  });

  it('T1-070：提供 usagePath（每 run 渲染 __SID__ 落点）→ 命令带第三参（per-run usage 路径）', () => {
    const s = generateRunSettings({
      workdir: '/w',
      contextUsageScript: '/infra/scripts/context-usage.mjs',
      usagePath: '/w/.awf/runs/r1/context/usage.json',
    });
    expect(s.statusLine.command).toBe(
      'node "/infra/scripts/context-usage.mjs" "/w" "/w/.awf/runs/r1/context/usage.json"',
    );
  });
});
