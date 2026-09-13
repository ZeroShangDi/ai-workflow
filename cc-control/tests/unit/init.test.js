import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initCommand, checkPrerequisites } from '../../cli/commands/init.cjs';
import { WORKSPACE_DIRS, TEMPLATE_FILES } from '../../server/shared/workspace.cjs';

/**
 * initCommand — `awf init` 的命令层接线（前置检查 → 本地注册插件 → 建工作区骨架）
 *
 * 随旧树退役重写。旧版靠 `vi.mock` 拦 `project-paths` / `node:child_process` —— 那套机制对新树
 * 不成立（新 CLI 是 CJS，vitest 不拦 require，见 .awf/issues/014）。这里改成**真跑**：
 * 在临时目录里真建工作区、真写 settings，断言真落盘的东西。
 *
 * 「.awf/ 建成什么样」的细节归 server/shared/workspace.cjs，由 tests/unit/server-workspace.test.js
 * 深测；本文件只覆盖命令层：前置门禁、三步顺序、幂等与 --force 的输出语义。
 *
 * 已删除的旧用例：CLAUDE.md 注入 4 场景 —— 该机制随 `CLAUDE.md.template` 弃用一并移除
 * （模板 0 字节，且内容会引导运行期误走已停用的旧决策入口；workspace.cjs:14 载明「未搬」）。
 */

let TMP;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-init-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'cwd').mockReturnValue(TMP);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('checkPrerequisites', () => {
  it('返回三项检查（tmux / claude / node），每项带 name/ok/hint', () => {
    const deps = checkPrerequisites();
    expect(deps.map((d) => d.name)).toEqual(['tmux', 'claude', 'node']);
    for (const d of deps) {
      expect(typeof d.ok).toBe('boolean');
      expect(typeof d.hint).toBe('string');
      expect(d.hint.length).toBeGreaterThan(0); // 不过时要能告诉人怎么装
    }
  });

  it('本机三项齐备（真机用例的前置条件，缺了这里先红）', () => {
    expect(checkPrerequisites().every((d) => d.ok)).toBe(true);
  });
});

describe('initCommand', () => {
  it('首次 init：建 .awf/ 骨架 + 播模板 + 播种 state + 本地注册插件', async () => {
    await initCommand();

    // 骨架目录
    for (const dir of WORKSPACE_DIRS) {
      expect(fs.existsSync(path.join(TMP, '.awf', dir))).toBe(true);
    }
    // 模板（README / config / context/architecture.md）
    for (const { target } of TEMPLATE_FILES) {
      expect(fs.existsSync(path.join(TMP, '.awf', target))).toBe(true);
    }
    // state 播种 + 本地插件注册（项目级 .mcp.json 同步注册）
    expect(fs.existsSync(path.join(TMP, '.awf', 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(TMP, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(TMP, '.mcp.json'))).toBe(true);
  });

  it('重复 init：幂等，既有文件内容一个字节不动', async () => {
    await initCommand();
    const readme = fs.readFileSync(path.join(TMP, '.awf', 'README.md'), 'utf8');
    const settings = fs.readFileSync(path.join(TMP, '.claude', 'settings.json'), 'utf8');

    await initCommand();

    expect(fs.readFileSync(path.join(TMP, '.awf', 'README.md'), 'utf8')).toBe(readme);
    expect(fs.readFileSync(path.join(TMP, '.claude', 'settings.json'), 'utf8')).toBe(settings);
  });

  it('--force：补回缺失文件，但**不覆盖**用户改过的既有文件', async () => {
    await initCommand();
    // 用户改过 README、并删掉 config
    fs.writeFileSync(path.join(TMP, '.awf', 'README.md'), '用户自己的说明\n');
    fs.rmSync(path.join(TMP, '.awf', 'config.json'));

    await initCommand({ force: true });

    expect(fs.readFileSync(path.join(TMP, '.awf', 'README.md'), 'utf8')).toBe('用户自己的说明\n');
    expect(fs.existsSync(path.join(TMP, '.awf', 'config.json'))).toBe(true);
  });

  it('前置依赖缺失 → 阻断且不建骨架（不在半缺依赖的项目里动手）', async () => {
    vi.stubEnv('PATH', ''); // command -v 全部落空
    const code = [];
    vi.spyOn(process, 'exit').mockImplementation((c) => { code.push(c); throw new Error('exit'); });

    await expect(initCommand()).rejects.toThrow('exit');

    expect(code).toEqual([1]);
    expect(fs.existsSync(path.join(TMP, '.awf'))).toBe(false);
  });
});
