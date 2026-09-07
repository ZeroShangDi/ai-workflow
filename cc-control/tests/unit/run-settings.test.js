import { describe, it, expect } from 'vitest';
import { generateRunSettings } from '../../src/server/run-settings.cjs';

// run 专用 settings 生成归 cc（W1-044）：statusLine/crossSessionInbound 等 cc 格式。

describe('generateRunSettings', () => {
  it('crossSessionInbound accept + statusLine 命令指向 context-usage', () => {
    const s = generateRunSettings({ workdir: '/w', contextUsageScript: '/infra/scripts/context-usage.mjs' });
    expect(s.crossSessionInbound).toBe('accept');
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toBe('node "/infra/scripts/context-usage.mjs" "/w"');
    expect(s.statusLine.refreshInterval).toBe(30);
  });
});
