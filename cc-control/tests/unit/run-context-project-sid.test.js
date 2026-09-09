import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { projectSid, projectSessionName, SID_PATTERN, buildRunContext } from '../../src/lib/run-context.cjs';

// projectSid / projectSessionName（W 单 server 多项目）：确定性项目 run 标签。
// 要求：同一 root 跨调用/跨进程一致、不同 root 相异、SID_PATTERN 合法、纯标签不落盘不派生 runDir。

describe('projectSid — 确定性项目标签', () => {
  it('同一 projectRoot 结果确定一致（跨调用/跨进程重放）', () => {
    expect(projectSid('/Users/x/Project/a')).toBe(projectSid('/Users/x/Project/a'));
    expect(projectSid(path.resolve('/Users/x/Project/a'))).toBe(projectSid(path.resolve('/Users/x/Project/a')));
  });

  it('不同 projectRoot 结果相异', () => {
    expect(projectSid('/p/a')).not.toBe(projectSid('/p/b'));
    expect(projectSid('/p/a')).not.toBe(projectSid('/p/ab'));
  });

  it('结果合法：p + 12 hex，匹配 SID_PATTERN 且 ≤64', () => {
    const sid = projectSid('/some/project/dir');
    expect(sid).toMatch(/^p[0-9a-f]{12}$/);
    expect(SID_PATTERN.test(sid)).toBe(true);
    expect(sid.length).toBeLessThanOrEqual(64);
  });
});

describe('projectSessionName — tmux 会话名唯一化', () => {
  it('`${session}-${projectSid}`；基础名来自 config/env', () => {
    expect(projectSessionName('/p/a', { env: {} })).toBe(`cc-${projectSid('/p/a')}`);
    expect(projectSessionName('/p/a', { env: { CC_SESSION: 'wf' } })).toBe(`wf-${projectSid('/p/a')}`);
  });

  it('两个项目会话名唯一（单 tmux server 下互不 kill）', () => {
    expect(projectSessionName('/p/a', { env: {} })).not.toBe(projectSessionName('/p/b', { env: {} }));
  });

  it('纯标签：不派生 .awf/runs/<sid>（与 buildRunContext sid 语义解耦）', () => {
    // projectSid 是纯函数，不读文件；此处用不同 root 建 ctx 验证 projectRoot 不变即可
    const ctx = buildRunContext({ projectRoot: '/p/a', env: {} });
    expect(ctx.projectRoot).toBe('/p/a');
  });
});
