import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ccBuild = require('../../server/adapters/cc/build.cjs');
const dshBuild = require('../../server/adapters/dsh/build.cjs');

/**
 * 插件构造（`plugin/` 中性源 → 两侧产物）的验收。
 *
 * ## 为什么这么测
 * 构造器最危险的失效不是报错，而是**悄悄改了一个字**：产物看起来正常，装上去才发现在某个平台上
 * 少了半句协议。所以这里的判据是**逐字节**的：
 *   - cc 侧：技能 / 代理产物必须与源**逐字节相同**（证明「没被动过」）；命令产物 = 源剥掉 frontmatter。
 *   - dsh 侧：变换必须**恰好**是声明的那些（命令命名空间、`subagent_type`、工具名），一条不多。
 *
 * ## 重构期的硬证据（已跑过，快照留档在 /tmp，不进库）
 * 本构造器首次落地时，产物与「源还没统一之前」那两棵树逐字节比对：cc 7/7、dsh 4/4 全等。
 * 那条比对是一次性的；这里留下的是**可重复**的那部分不变量。
 */

const ROOT = path.resolve(__dirname, '../..');

/**
 * **在临时根里构造**，不碰真实的产物目录。
 *
 * 为什么必须隔离：构造是「先清后写」，而别的测试文件正在读真实的
 * `server/adapters/dsh/plugin/skills/**`。两边并发时读的那方会看到半写状态
 * （实测：`listSkills()` 报出 2 个「缺 SKILL.md」）。测试不该互相踩。
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-build-parity-'));
fs.cpSync(path.join(ROOT, 'plugin'), path.join(TMP, 'plugin'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'server', 'shared'), { recursive: true });
for (const f of ['store-core.cjs', 'task-graph.cjs']) {
  fs.copyFileSync(path.join(ROOT, 'server', 'shared', f), path.join(TMP, 'server', 'shared', f));
}

const SRC = path.join(TMP, 'plugin');
const CC = path.join(TMP, 'server', 'adapters', 'cc', 'plugin');
const DSH = path.join(TMP, 'server', 'adapters', 'dsh', 'plugin');

ccBuild.build({ pkgRoot: TMP });
dshBuild.build({ pkgRoot: TMP });

afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const read = (p) => fs.readFileSync(p, 'utf8');
/** 递归列出目录下的**真实文件**，路径相对根（root 固定传下去 —— 早先按当前层算，深层文件会塌成同名）。
 *  跳过 node_modules（开发期依赖软链，不是构造产物）与符号链接。 */
const walkFiles = (dir, root = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, root, out);
    else if (e.isFile()) out.push(path.relative(root, p));
  }
  return out.sort();
};
describe('构造：跑得出产物', () => {
  it('cc 侧 7 个内容目录（core 四类 + decision/skills + plugin-code 两类）', () => {
    for (const dir of ['core/commands', 'core/skills', 'core/agents', 'core/mcp', 'decision/skills', 'plugin-code/commands', 'plugin-code/skills']) {
      expect(fs.existsSync(path.join(CC, dir)), `${dir} 未生成`).toBe(true);
      expect(fs.readdirSync(path.join(CC, dir)).length).toBeGreaterThan(0);
    }
  });

  it('dsh 侧 4 个内容目录（三包拍平成一包）', () => {
    for (const dir of ['commands', 'skills', 'agents', 'mcp']) {
      expect(fs.existsSync(path.join(DSH, dir)), `${dir} 未生成`).toBe(true);
    }
    expect(fs.readdirSync(path.join(DSH, 'commands'))).toHaveLength(16);
    expect(fs.readdirSync(path.join(DSH, 'skills'))).toHaveLength(36);
    expect(fs.readdirSync(path.join(DSH, 'agents'))).toHaveLength(3);
  });

  it('可复现：连跑两次产物逐字节相同（构造器无隐藏状态）', () => {
    const snap = walkFiles(DSH).map((f) => [f, read(path.join(DSH, f))]);
    dshBuild.build({ pkgRoot: TMP });   // 必须带 pkgRoot，否则写真实目录 → 与别的测试竞态
    for (const [f, before] of snap) {
      expect(read(path.join(DSH, f)), `${f} 第二次构造结果不同`).toBe(before);
    }
    expect(walkFiles(DSH)).toHaveLength(snap.length);
  });
});

describe('构造：cc 侧是纯拷贝（内容一个字段都不改）', () => {
  // 用户的元数据口径：**可以多，不要少**。所以 cc 侧不剥 frontmatter —— 源是超集，
  // 各平台读自己的键。实测（claude plugin validate，含 --strict）三个包零警告：
  // CC 运行时容忍未识别键；反而是「命令没有 frontmatter」本身会招一条警告。
  it('四类内容目录全部与源逐字节相同', () => {
    const pairs = [
      ['core/commands', 'core/commands'],
      ['core/skills', 'core/skills'],
      ['core/agents', 'core/agents'],
      ['core/mcp', 'core/mcp'],
      ['decision/skills', 'decision/skills'],
      ['plugin-code/commands', 'plugin-code/commands'],
      ['plugin-code/skills', 'plugin-code/skills'],
    ];
    for (const [srcDir, outDir] of pairs) {
      const srcFiles = walkFiles(path.join(SRC, srcDir));
      expect(walkFiles(path.join(CC, outDir)), `${outDir} 文件集不同`).toEqual(srcFiles);
      for (const f of srcFiles) {
        expect(read(path.join(CC, outDir, f)), `${outDir}/${f} 与源不一致`).toBe(read(path.join(SRC, srcDir, f)));
      }
    }
  });

  it('源命令的 frontmatter 原样到了 cc 产物（description / argument-hint 都在）', () => {
    for (const [pkg, f] of [['core', 'w-start.md'], ['plugin-code', 'w-plan.md']]) {
      const out = read(path.join(CC, pkg, 'commands', f));
      expect(out.startsWith('---\n'), `${f} 的 frontmatter 丢了`).toBe(true);
      const fm = out.slice(0, out.indexOf('\n---', 3));
      expect(fm).toMatch(/^description: .+/m);
      expect(fm).toMatch(/^argument-hint: .+/m);
    }
  });
});

describe('构造：dsh 侧的变换恰好是声明的那些', () => {
  const SRC_ALL = () => walkFiles(SRC)
    .filter((f) => /\.md$/.test(f))
    .map((f) => read(path.join(SRC, f)))
    .join('\n');

  it('产物里没有 cc 口径的残留（命令命名空间 / subagent_type / CC 工具名）', () => {
    const out = walkFiles(DSH).filter((f) => /\.md$/.test(f)).map((f) => read(path.join(DSH, f))).join('\n');
    expect(out).not.toContain('/ai-workflow-code:');
    expect(out).not.toContain('subagent_type');
    expect(out).not.toContain('ai-workflow-core:');
    expect(out).not.toContain('AskUserQuestion');
  });

  it('这些残留**确实在源里**（否则上一条是空断言）', () => {
    const src = SRC_ALL();
    expect(src).toContain('/ai-workflow-code:');
    expect(src).toContain('subagent_type');
    expect(src).toContain('AskUserQuestion');
  });

  it('命令的 frontmatter 换成 DSH 的键（hint），不留 cc 的 argument-hint', () => {
    for (const f of fs.readdirSync(path.join(DSH, 'commands'))) {
      const t = read(path.join(DSH, 'commands', f));
      expect(t.startsWith('---\n'), `${f} 缺 frontmatter`).toBe(true);
      expect(t.slice(0, t.indexOf('\n---', 3))).toContain('hint:');
      expect(t.slice(0, t.indexOf('\n---', 3))).not.toContain('argument-hint:');
      expect(t).not.toContain('description: \n');
    }
  });

  it('代理产物带 max-depth（DSH 侧平台配置，源里没有）', () => {
    for (const f of fs.readdirSync(path.join(DSH, 'agents'))) {
      expect(read(path.join(DSH, 'agents', f))).toContain('max-depth: 0');
    }
  });

  it('MCP：cc 专有的 awf-oneshot 不进 DSH 包，叶子依赖随包（_lib/）', () => {
    expect(fs.existsSync(path.join(DSH, 'mcp', 'awf-oneshot'))).toBe(false);
    expect(fs.existsSync(path.join(DSH, 'mcp', 'awf-state', 'server.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(DSH, 'mcp', '_lib', 'store-core.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(DSH, 'mcp', '_lib', 'task-graph.cjs'))).toBe(true);
    // 包外 require 必须改写干净，否则拷到 profile 里就断
    const awfState = read(path.join(DSH, 'mcp', 'awf-state', 'server.cjs'));
    expect(awfState).toContain("'..', '_lib', 'store-core.cjs'");
    expect(awfState).not.toMatch(/'\.\.',\s*'\.\.',\s*'\.\.',\s*'\.\.'/);
  });
});

describe('构造：源的元数据是超集', () => {
  it('每条源命令都有 description + argument-hint(cc) + hint(dsh)', () => {
    const cmds = ['core/commands', 'plugin-code/commands']
      .flatMap((d) => fs.readdirSync(path.join(SRC, d)).map((f) => path.join(SRC, d, f)));
    expect(cmds).toHaveLength(16);
    for (const p of cmds) {
      const fm = read(p).slice(0, read(p).indexOf('\n---', 3));
      expect(fm, `${p} 缺 description`).toMatch(/^description: .+/m);
      expect(fm, `${p} 缺 argument-hint（cc 的键）`).toMatch(/^argument-hint: .+/m);
      expect(fm, `${p} 缺 hint（dsh 的键）`).toMatch(/^hint: .+/m);
    }
  });

  it('源的技能 / 代理仍带自己的 frontmatter（那是定义，不是元数据）', () => {
    const sk = read(path.join(SRC, 'core', 'skills', 'awf-state', 'SKILL.md'));
    expect(sk).toMatch(/^name: /m);
    expect(sk).toMatch(/^description: /m);
    const ag = read(path.join(SRC, 'core', 'agents', 'awf-worker.md'));
    expect(ag).toMatch(/^name: awf-worker$/m);
    expect(ag).toMatch(/^tools: /m);
  });
});

/**
 * `.gitignore` 的边界：**只能忽略从 `plugin/` 拷过来的资产**。
 *
 * 这条守卫来自一个真实的担心（用户提的）：「换个电脑直接不能用了」——
 * 若规则写宽了把代码也忽略掉，本机因为文件都在所以完全看不出来，
 * 换机器/新 clone 时才会缺文件，且报错点离根因很远。
 */
describe('gitignore：只忽略构造产物，代码一律入库', () => {
  const hasGit = fs.existsSync(path.join(ROOT, '.git')) || (() => {
    try { return require('node:child_process').execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: 'pipe' }); } catch { return false; }
  })();
  const checkIgnore = (rel) => {
    try {
      require('node:child_process').execSync(`git check-ignore -q -- ${JSON.stringify(rel)}`, { cwd: ROOT, stdio: 'pipe' });
      return true;   // 退出码 0 = 被忽略
    } catch { return false; }
  };

  it.skipIf(!hasGit)('手写代码 / 清单**没有**被忽略', () => {
    const mustTrack = [
      'server/adapters/dsh/plugin/index.js',
      'server/adapters/dsh/plugin/lib/ops.js',
      'server/adapters/dsh/plugin/lib/assets.js',
      'server/adapters/dsh/plugin/hooks/index.js',
      'server/adapters/dsh/plugin/hooks/hooks.json',
      'server/adapters/dsh/plugin/mcp.json',
      'server/adapters/dsh/plugin/prompts.json',
      'server/adapters/dsh/plugin/package.json',
      'server/adapters/cc/plugin/core/hooks/gateway.cjs',
      'server/adapters/cc/plugin/core/plugin.json',
      'server/adapters/cc/plugin/settings.json',
      'server/adapters/cc/plugin/config.json',
      'server/adapters/cc/plugin/plugin-code/prompts.json',
      'server/adapters/cc/build.cjs',
      'server/adapters/dsh/build.cjs',
    ];
    for (const f of mustTrack) {
      expect(fs.existsSync(path.join(ROOT, f)), `${f} 不存在`).toBe(true);
      expect(checkIgnore(f), `${f} 被 gitignore 了 —— 换机器会缺文件`).toBe(false);
    }
  });

  it.skipIf(!hasGit)('被忽略的只落在四个内容目录里', () => {
    const ignored = require('node:child_process')
      .execSync('git ls-files -o -i --exclude-standard -- server/adapters', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const ASSETS = ['commands', 'skills', 'agents', 'mcp'];
    // node_modules 是**既有**的忽略规则（仓库根的 `node_modules/`），不是本次构造引入的：
    // 里面是开发期给探针用的 `@deepseek-ai/*` 软链，由 scripts/probe/dsh/install-fixture.sh 重建。
    // 显式挑出来而不是宽度过宽地放过 —— 别的任何非内容目录都必须为 0。
    const devOnly = ignored.filter((p) => p.includes('/node_modules/'));
    const stray = ignored
      .filter((p) => !p.includes('/node_modules/'))
      .filter((p) => !p.split('/').some((seg) => ASSETS.includes(seg)));
    expect(devOnly.every((p) => p.includes('@deepseek-ai/')), `node_modules 里出现了非预期项：${devOnly.join(', ')}`).toBe(true);
    expect(stray, `这些被忽略了但不在内容目录里：\n${stray.join('\n')}`).toEqual([]);
  });

  it('源的 .gitignore 规则只针对四个内容目录（不是宽 glob）', () => {
    const gi = read(path.join(ROOT, '.gitignore'));
    const rules = gi.split('\n').filter((l) => /plugin\/(\*\/)?(commands|skills|agents|mcp)\//.test(l));
    expect(rules.length).toBeGreaterThanOrEqual(8);
    // 不许出现「忽略整个 plugin 目录」这种写宽了的规则
    expect(gi).not.toMatch(/^\/server\/adapters\/(cc|dsh)\/plugin\/?\s*$/m);
    expect(gi).not.toMatch(/^\/server\/adapters\/dsh\/plugin\/\*\*\s*$/m);
  });
});
