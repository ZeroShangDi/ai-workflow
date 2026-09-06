import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { installProjectMcp } from '../../src/lib/profile.js';
import { projectMcpJson } from '../../src/lib/plugin-config.js';

// installProjectMcp 的项目级 .mcp.json 路径形态：
// - 自托管（projectRoot == repoRoot）→ 相对路径（与仓库提交版一致，可移植、git 干净）
// - 跨项目注入（projectRoot != repoRoot）→ 绝对路径（server 在 cc-control 包内，逃逸相对路径不可靠）

const REPO = path.resolve(__dirname, '..', '..');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awf-installmcp-'));
}

describe('projectMcpJson — 路径形态按场景', () => {
  it('自托管（projectRoot == repoRoot）→ 相对路径 plugin/core/...', () => {
    const { mcpServers } = projectMcpJson(REPO, 8787, REPO);
    const arg = mcpServers['awf-state'].args[0];
    expect(path.isAbsolute(arg)).toBe(false);
    expect(arg).toBe('plugin/core/mcp/awf-state/server.cjs');
  });

  it('跨项目（projectRoot != repoRoot）→ 绝对路径且可解析到真实文件', () => {
    const tmp = tmpProject();
    try {
      const { mcpServers } = projectMcpJson(REPO, 8787, tmp);
      for (const name of ['awf-state', 'awf-session', 'awf-oneshot']) {
        const arg = mcpServers[name].args[0];
        expect(path.isAbsolute(arg)).toBe(true);
        expect(fs.existsSync(arg)).toBe(true);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('installProjectMcp — 写入形态', () => {
  it('跨项目注入 → .mcp.json 为绝对路径，幂等合并保留既有 server', () => {
    const tmp = tmpProject();
    try {
      // 预设一个用户自定义 server，验证幂等合并不覆盖
      fs.mkdirSync(path.join(tmp, '.awf'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'user-tool': { type: 'stdio', command: 'node', args: ['server.js'] } } }, null, 2) + '\n',
      );
      const r = installProjectMcp(tmp, REPO, 8787);
      expect(r.written).toBe(true);
      expect(r.servers).toEqual(['awf-state', 'awf-session', 'awf-oneshot']);
      const mcp = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'));
      // 用户 server 保留
      expect(mcp.mcpServers['user-tool']).toBeTruthy();
      // 跨项目 → 绝对路径且可解析
      expect(path.isAbsolute(mcp.mcpServers['awf-state'].args[0])).toBe(true);
      expect(fs.existsSync(mcp.mcpServers['awf-state'].args[0])).toBe(true);
      // AWF_BASE 端口注入
      expect(mcp.mcpServers['awf-session'].env.AWF_BASE).toBe('http://127.0.0.1:8787');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
