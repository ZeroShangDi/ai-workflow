import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dshInstall = require('../../server/adapters/dsh/install.cjs');

/**
 * DSH 侧装配（`server/adapters/dsh/install.cjs`）—— P2-6c。
 *
 * **只在临时 DSH_HOME 上跑**：这是纪律（真实 `~/.dsh` 被运行中进程持有，F11），也是这个模块的
 * 契约 —— 它只写你让它写的那个 home。
 *
 * 验四件事：装（patch 标记块 + 包拷贝）、幂等、不碰别人的内容、卸载只摘自己的块。
 */

let HOME; let PROFILE_DIR; let PATCH;

function makeHome({ patch = '[]\n' } = {}) {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dsh-install-'));
  PROFILE_DIR = path.join(HOME, 'profiles', 'web');
  fs.mkdirSync(path.join(PROFILE_DIR, 'node_modules'), { recursive: true });
  PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml');
  fs.writeFileSync(PATCH, patch);
  return HOME;
}

afterEach(() => { if (HOME) fs.rmSync(HOME, { recursive: true, force: true }); });

describe('DSH 装配：installProfile', () => {
  it('空 patch → 写入标记块 + 拷贝插件（package.json/index.js/lib）', () => {
    makeHome({ patch: '# 用户注释\n[]\n' });
    const r = dshInstall.installProfile({ dshHome: HOME });

    expect(r.written).toBe(true);
    expect(r.error).toBeUndefined();
    const text = fs.readFileSync(PATCH, 'utf8');
    expect(text).toContain(dshInstall.MARK_BEGIN);
    expect(text).toContain("name: 'awf-dsh-plugin'");
    expect(text).toContain('- insert:');
    expect(text).toContain('# 用户注释');           // 用户原有注释保留
    expect(text).not.toContain('[]');                // 空数组被替换，避免 [] 后面跟数组项（非法 YAML）

    const dest = path.join(PROFILE_DIR, 'node_modules', dshInstall.PLUGIN_PACKAGE);
    expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'lib', 'ops.js'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false); // 依赖交给 profile 解析
  });

  it('已有用户内容 → 追加我们的块，不动人家一个字', () => {
    const userBlock = '- insert:\n    - id: someone-else\n      name: "other-plugin"\n';
    makeHome({ patch: userBlock });
    dshInstall.installProfile({ dshHome: HOME });
    const text = fs.readFileSync(PATCH, 'utf8');
    expect(text.startsWith(userBlock.trimEnd())).toBe(true);  // 用户内容在最前，原样
    expect(text).toContain(dshInstall.MARK_BEGIN);
    expect(text).toContain('someone-else');
  });

  it('幂等：第二次安装不重写，patch 不变（仍会刷新插件拷贝）', () => {
    makeHome();
    dshInstall.installProfile({ dshHome: HOME });
    const first = fs.readFileSync(PATCH, 'utf8');
    const second = dshInstall.installProfile({ dshHome: HOME });
    expect(second.written).toBe(false);
    expect(second.reason).toContain('已含 awf-dsh');
    expect(fs.readFileSync(PATCH, 'utf8')).toBe(first);
  });

  it('首次安装留备份，且不覆盖既有备份', () => {
    makeHome({ patch: '- insert: []\n' });
    const r1 = dshInstall.installProfile({ dshHome: HOME });
    expect(r1.backupPath).toBe(`${PATCH}.awf-backup`);
    expect(fs.readFileSync(r1.backupPath, 'utf8')).toBe('- insert: []\n');

    fs.writeFileSync(r1.backupPath, 'OLD-BACKUP');
    dshInstall.uninstallProfile({ dshHome: HOME });
    const r2 = dshInstall.installProfile({ dshHome: HOME });
    expect(fs.readFileSync(r2.backupPath, 'utf8')).toBe('OLD-BACKUP'); // 旧备份保留
  });

  it('profile 目录不存在 → 明确失败并给出下一步（不静默建一个假 profile）', () => {
    makeHome();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    const r = dshInstall.installProfile({ dshHome: HOME });
    expect(r.written).toBe(false);
    expect(r.error).toContain('profile 目录不存在');
    expect(r.error).toContain('dsh --profile web');
  });

  it('webPort 写进配置（DSH 网页端口，打开会话观看页用）', () => {
    makeHome();
    dshInstall.installProfile({ dshHome: HOME, webPort: 39081 });
    expect(fs.readFileSync(PATCH, 'utf8')).toContain('webPort: 39081');
  });

  // F42：插件没有 awfBase 就**不启动指令通道**（只告警）——真实安装路径必须把它写进配置，
  // 不能只靠 AWF_DSH_BASE 环境变量（探针走的是环境变量，所以这条一直没被真实安装路径暴露）。
  it('awfBase 写进配置（插件连常驻 AWF server 的唯一来源）', () => {
    makeHome();
    dshInstall.installProfile({ dshHome: HOME, awfBase: 'http://127.0.0.1:8787', webPort: 3080 });
    const patch = fs.readFileSync(PATCH, 'utf8');
    expect(patch).toContain("awfBase: 'http://127.0.0.1:8787'");
    // 两个端口不是一回事：webPort 是 DSH 网页端口，AWF 端口只能出现在 awfBase 里
    expect(patch).toContain('webPort: 3080');
    expect(patch).not.toContain('webPort: 8787');
  });

  it('不给 awfBase 时不写空配置项（由调用方决定，插件侧缺它会明确告警）', () => {
    makeHome();
    dshInstall.installProfile({ dshHome: HOME });
    expect(fs.readFileSync(PATCH, 'utf8')).not.toContain('awfBase');
  });

  // 自包含契约：插件目录**不允许引用目录以外的任何东西**（尤其不引用 cc 侧插件树）。
  // 旧实现的 awfRepo 就是为了让插件去 cc 插件树取 MCP 入口 —— 已删除，改为随包携带。
  it('托管块不含 awfRepo（MCP server 随包携带，不再指外部目录）', () => {
    makeHome();
    dshInstall.installProfile({ dshHome: HOME, awfBase: 'http://127.0.0.1:8787' });
    expect(fs.readFileSync(PATCH, 'utf8')).not.toContain('awfRepo');
  });

  // 升级场景：配置项变了必须**原地更新**托管块，否则「重新安装」修不好任何东西
  it('托管块内容有变 → 原地更新（保留用户内容、不重复插块）', () => {
    makeHome({ patch: '# 用户自己的注释\n[]\n' });
    const first = dshInstall.installProfile({ dshHome: HOME, awfBase: 'http://127.0.0.1:8787', webPort: 3080 });
    expect(first.written).toBe(true);
    const before = fs.readFileSync(PATCH, 'utf8');
    expect(before).toContain('webPort: 3080');

    const again = dshInstall.installProfile({ dshHome: HOME, awfBase: 'http://127.0.0.1:8787', webPort: 39081 });
    expect(again.written).toBe(true);
    expect(again.reason).toContain('更新');
    const after = fs.readFileSync(PATCH, 'utf8');
    expect(after).toContain('webPort: 39081');
    expect(after).toContain('# 用户自己的注释');
    expect(after.match(/>>> awf-dsh/g)).toHaveLength(1); // 不重复插块

    // 内容一致时仍幂等（不写文件）
    const third = dshInstall.installProfile({ dshHome: HOME, awfBase: 'http://127.0.0.1:8787', webPort: 39081 });
    expect(third.written).toBe(false);
    expect(fs.readFileSync(PATCH, 'utf8')).toBe(after);
  });
});

describe('DSH 装配：uninstallProfile', () => {
  it('只摘我们的块与包目录，用户内容原样留着', () => {
    const userBlock = '- insert:\n    - id: someone-else\n      name: "other-plugin"\n';
    makeHome({ patch: userBlock });
    dshInstall.installProfile({ dshHome: HOME });
    const r = dshInstall.uninstallProfile({ dshHome: HOME });

    expect(r.written).toBe(true);
    const text = fs.readFileSync(PATCH, 'utf8');
    expect(text).not.toContain(dshInstall.MARK_BEGIN);
    expect(text).toContain('someone-else');
    expect(fs.existsSync(path.join(PROFILE_DIR, 'node_modules', dshInstall.PLUGIN_PACKAGE))).toBe(false);
  });

  it('装之前卸载（无内容）→ 不报错', () => {
    makeHome({ patch: '[]\n' });
    const r = dshInstall.uninstallProfile({ dshHome: HOME });
    expect(r.error).toBeUndefined();
    expect(fs.readFileSync(PATCH, 'utf8')).toBe('[]\n');
  });
});

describe('DSH 装配：环境解析与状态', () => {
  it('DSH_HOME 优先级：显式 > env > ~/.dsh', () => {
    const saved = process.env.DSH_HOME;
    try {
      delete process.env.DSH_HOME;
      expect(dshInstall.resolveDshHome()).toBe(path.join(os.homedir(), '.dsh'));
      process.env.DSH_HOME = '/tmp/via-env';
      expect(dshInstall.resolveDshHome()).toBe('/tmp/via-env');
      expect(dshInstall.resolveDshHome('/tmp/explicit')).toBe('/tmp/explicit');
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    }
  });

  it('isInstalled：装前 false、装后 true、卸后 false', () => {
    makeHome();
    expect(dshInstall.isInstalled({ dshHome: HOME }).installed).toBe(false);
    dshInstall.installProfile({ dshHome: HOME });
    expect(dshInstall.isInstalled({ dshHome: HOME }).installed).toBe(true);
    dshInstall.uninstallProfile({ dshHome: HOME });
    expect(dshInstall.isInstalled({ dshHome: HOME }).installed).toBe(false);
  });
});

describe('DSH 装配：技能（已改为随包携带 + 会话级注册）', () => {
  // 旧口径把全部技能符号链接进 $DSH_HOME/skills —— 那是**全局可见**的技能根，
  // 会污染用户自己的 DSH 会话、还会 first-wins 抢用户同名技能。现在安装期不碰那里。
  it('安装不往 $DSH_HOME/skills 铺任何东西', () => {
    const home = makeHome();
    dshInstall.installProfile({ dshHome: home, awfBase: 'http://127.0.0.1:8787' });
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false);
  });

  it('清单里的技能数量 = 插件目录里的技能数（不再是链接森林）', () => {
    const skills = dshInstall.listSkills();
    expect(skills.length).toBeGreaterThan(30);
    expect(skills.some((s) => s.name === 'awf-plan-norm')).toBe(true);
    // 每个技能都必须是插件目录里的**真实文件**，不是指向别处的链接
    for (const s of skills) {
      expect(fs.existsSync(path.join(s.sourceDir, 'SKILL.md'))).toBe(true);
      expect(fs.lstatSync(path.join(s.sourceDir, 'SKILL.md')).isSymbolicLink()).toBe(false);
    }
  });

  // 卸载仍要能清掉历史安装留下的链接（用户机器上可能还留着旧布局）
  it('uninstallSkills 只摘清单里 AWF 装的，用户自建的技能一个不动', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-skills-'));
    const root = path.join(home, 'skills');
    const userSkill = path.join(root, 'user-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '用户的');
    // 模拟旧安装留下的现场：一个技能 + 一份清单
    const ours = path.join(root, 'awf-plan-norm');
    fs.mkdirSync(ours, { recursive: true });
    fs.writeFileSync(path.join(ours, 'SKILL.md'), '旧的');
    fs.writeFileSync(path.join(root, '.awf-skills.json'), JSON.stringify({ entries: { 'awf-plan-norm': { linked: true } } }));

    const r = dshInstall.uninstallSkills({ dshHome: home });
    expect(r.removed).toContain('awf-plan-norm');
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(userSkill)).toBe(true); // 用户的还在
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('DSH 插件目录：自包含', () => {
  // 这条是「安装 = 一个文件夹」的地基：目录里引用了外面的东西，拷到别处就会断。
  const PLUGIN = dshInstall.pluginSourceDir();

  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue; // 开发期依赖软链，不入包（拷贝时排除）
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) out.push(p);
      else if (e.isDirectory()) walk(p, out);
    }
    return out;
  }

  it('目录里没有一个符号链接（技能/命令/代理/MCP 全是真实文件）', () => {
    expect(walk(PLUGIN)).toEqual([]);
  });

  it('五类资产都在目录里：命令 / 技能 / 代理 / MCP / hooks', () => {
    expect(fs.readdirSync(path.join(PLUGIN, 'commands')).some((f) => f.endsWith('.md'))).toBe(true);
    const skillDirs = fs.readdirSync(path.join(PLUGIN, 'skills'));
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const dir of skillDirs) expect(fs.existsSync(path.join(PLUGIN, 'skills', dir, 'SKILL.md'))).toBe(true);
    expect(fs.readdirSync(path.join(PLUGIN, 'agents')).filter((f) => f.endsWith('.md')).length).toBe(3);
    expect(fs.existsSync(path.join(PLUGIN, 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(PLUGIN, 'hooks', 'hooks.json'))).toBe(true);
  });

  it('mcp.json 声明的每个入口都真实存在（且都在包内）', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'mcp.json'), 'utf8'));
    expect(cfg.servers.length).toBeGreaterThan(0);
    for (const s of cfg.servers) {
      const entry = path.join(PLUGIN, s.entry);
      expect(fs.existsSync(entry)).toBe(true);
      expect(path.relative(PLUGIN, entry).startsWith('..')).toBe(false);
    }
  });

  it('源码里不出现指向包外的路径引用（cc 插件树 / 上跳三级以上）', () => {
    const offenders = [];
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scan(p); continue; }
        if (!/\.(js|cjs|json|md)$/.test(e.name)) continue;
        const text = fs.readFileSync(p, 'utf8');
        // 允许 ../ 与 ../../（lib/ → 包根、mcp/x/ → mcp/_lib）；不允许再往上，也不允许指名 cc 插件树。
        // 只看**路径字面量**：注释里提「旧 awfRepo」是说明历史，不算引用。
        if (/\.\.\/\.\.\/\.\./.test(text) || text.includes('adapters/cc/plugin')) {
          offenders.push(path.relative(PLUGIN, p));
        }
      }
    };
    scan(PLUGIN);
    expect(offenders).toEqual([]);
  });
});
