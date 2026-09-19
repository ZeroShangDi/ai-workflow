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

  // 真机踩到过的回归（P2-6c 收口）：`localPlugin` 曾写死 `buildContext(root, { env: {} })`，
  // 把 `CC_ADAPTER` 一起吞掉 —— 干净项目上 `CC_ADAPTER=dsh awf init` 会按 cc 注册，
  // 而 DSH 的资产装配（profile 插件）根本没发生。这里钉住「平台覆盖真的生效」。
  it('CC_ADAPTER=dsh：按 DSH 装配（装 profile、不做 cc 的项目级注入），并把平台记进 config.json', async () => {
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-init-dsh-'));
    const profile = path.join(dshHome, 'profiles', 'probe');
    fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# 用户自己的注释\n[]\n');
    vi.stubEnv('CC_ADAPTER', 'dsh');
    vi.stubEnv('DSH_HOME', dshHome);
    vi.stubEnv('AWF_DSH_PROFILE', 'probe');
    try {
      await initCommand();

      // 平台进项目：之后不带 CC_ADAPTER 也能解析到 dsh
      expect(JSON.parse(fs.readFileSync(path.join(TMP, '.awf', 'config.json'), 'utf8')).runtime.adapter).toBe('dsh');
      // DSH 的接入是「装进 profile」，没有 cc 那套项目级注入
      expect(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')).toContain('awf-dsh-plugin');
      expect(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')).toContain('# 用户自己的注释');
      expect(fs.existsSync(path.join(TMP, '.claude', 'settings.json'))).toBe(false);
      expect(fs.existsSync(path.join(TMP, '.mcp.json'))).toBe(false);
    } finally {
      fs.rmSync(dshHome, { recursive: true, force: true });
    }
  });

  // 不用手改配置、也不用每次带环境变量：`awf init --adapter dsh` 先把平台写进项目配置，
  // 之后所有命令（含 init 自己）都按项目解析。
  it('--adapter dsh：写进 .awf/config.json 并按 DSH 装配；不带参数再跑仍解析为 dsh', async () => {
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-init-adapter-'));
    const profile = path.join(dshHome, 'profiles', 'probe');
    fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
    vi.stubEnv('DSH_HOME', dshHome);
    vi.stubEnv('AWF_DSH_PROFILE', 'probe');
    try {
      await initCommand({ adapter: 'dsh' });
      expect(JSON.parse(fs.readFileSync(path.join(TMP, '.awf', 'config.json'), 'utf8')).runtime.adapter).toBe('dsh');
      expect(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')).toContain('awf-dsh-plugin');
      expect(fs.existsSync(path.join(TMP, '.claude', 'settings.json'))).toBe(false); // dsh 无项目级注入

      // 第二次不带 --adapter：从配置解析出 dsh（这就是「不用每次带」的证据）
      await initCommand();
      expect(fs.existsSync(path.join(profile, 'node_modules', 'awf-dsh-plugin', 'index.js'))).toBe(true);
    } finally {
      fs.rmSync(dshHome, { recursive: true, force: true });
    }
  });

  it('--adapter nope：未知平台 → 显式报错退出（不静默回落 cc、不建骨架）', async () => {
    const code = [];
    vi.spyOn(process, 'exit').mockImplementation((c) => { code.push(c); throw new Error('exit'); });
    await expect(initCommand({ adapter: 'nope' })).rejects.toThrow('exit');
    expect(code).toEqual([2]);
    expect(fs.existsSync(path.join(TMP, '.awf'))).toBe(false);
  });

  it('--adapter cc：显式指定覆盖配置里已有的 dsh（用户明确要的平台优先）', async () => {
    fs.mkdirSync(path.join(TMP, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(TMP, '.awf', 'config.json'), JSON.stringify({ runtime: { adapter: 'dsh' }, run: { agents: { max: 3 } } }));
    await initCommand({ adapter: 'cc' });
    const cfg = JSON.parse(fs.readFileSync(path.join(TMP, '.awf', 'config.json'), 'utf8'));
    expect(cfg.runtime.adapter).toBe('cc');
    expect(cfg.run.agents.max).toBe(3); // 其它字段原样保留
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
