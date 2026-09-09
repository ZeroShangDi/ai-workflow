import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// T1-074：前端 ?sid 路由视图 + 多 run 简单列表壳（守护 shell 标记存在）
const HTML = fs.readFileSync(fileURLToPath(new URL('../../src/server/dashboard.html', import.meta.url)), 'utf8');

describe('dashboard ?sid 多 run 列表壳（T1-074）', () => {
  it('含 runShell 列表 + /run/status 详情拉取 + ?sid 链接', () => {
    expect(HTML).toContain('id="runShell"');
    expect(HTML).toContain('id="runList"');
    expect(HTML).toContain('/run/status');
    expect(HTML).toContain('?sid=');
    expect(HTML).toContain("fetch('/run/status?runId=' + encodeURIComponent(sid))");
  });
});
