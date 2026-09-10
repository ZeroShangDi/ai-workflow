import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// T1-074：前端 run 列表壳（守护 shell 标记存在）；多项目收口后链接须经 hrefWith 保留 ?p。
const HTML = fs.readFileSync(fileURLToPath(new URL('../../src/server/dashboard.html', import.meta.url)), 'utf8');

describe('dashboard 多 run 列表壳（T1-074 + 多项目作用域）', () => {
  it('含 runShell 列表 + /run/status 详情拉取', () => {
    expect(HTML).toContain('id="runShell"');
    expect(HTML).toContain('id="runList"');
    expect(HTML).toContain('/run/status');
    expect(HTML).toContain("fetch('/run/status?runId=' + encodeURIComponent(sid))");
  });

  it('run 链接经 hrefWith 生成（保留 ?p，否则点 run 会掉回 boot 项目）', () => {
    expect(HTML).toContain('AWF_COMMON.hrefWith({ sid: r.runId })');
    expect(HTML).not.toContain('href="?sid=');
  });

  it('common.js 同步加载（先于页面内联脚本装 ?p 作用域包装）', () => {
    expect(HTML).toContain('<script src="/common.js"></script>');
    expect(HTML).not.toContain('common.js" defer');
  });
});
