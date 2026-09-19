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

  // F43：插件挂项目 MCP 要靠 awfRepo 定位包内的 MCP server 入口；
  // 真实安装漏了它 → session.create 直接失败（探针走环境变量，所以一直没暴露）。
  it('awfRepo 写进配置（插件据此定位包内 MCP server）', () => {
    makeHome();
    dshInstall.installProfile({ dshHome: HOME, awfRepo: '/opt/ai-workflow' });
    expect(fs.readFileSync(PATCH, 'utf8')).toContain("awfRepo: '/opt/ai-workflow'");
  });

  // 升级场景：配置项变了必须**原地更新**托管块，否则「重新安装」修不好任何东西
  it('托管块内容有变 → 原地更新（保留用户内容、不重复插块）', () => {
    makeHome({ patch: '# 用户自己的注释\n[]\n' });
    const first = dshInstall.installProfile({ dshHome: HOME, awfBase: 'http://127.0.0.1:8787', webPort: 3080 });
    expect(first.written).toBe(true);
    const before = fs.readFileSync(PATCH, 'utf8');
    expect(before).not.toContain('awfRepo');

    const again = dshInstall.installProfile({ dshHome: HOME, awfBase: 'http://127.0.0.1:8787', awfRepo: '/opt/ai-workflow', webPort: 3080 });
    expect(again.written).toBe(true);
    expect(again.reason).toContain('更新');
    const after = fs.readFileSync(PATCH, 'utf8');
    expect(after).toContain("awfRepo: '/opt/ai-workflow'");
    expect(after).toContain('# 用户自己的注释');
    expect(after.match(/>>> awf-dsh/g)).toHaveLength(1); // 不重复插块

    // 内容一致时仍幂等（不写文件）
    const third = dshInstall.installProfile({ dshHome: HOME, awfBase: 'http://127.0.0.1:8787', awfRepo: '/opt/ai-workflow', webPort: 3080 });
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

describe('DSH 装配：技能 installSkills / uninstallSkills', () => {
  it('技能链接进 $DSH_HOME/skills（符号链接，指向 plugin 里的 SKILL.md 目录）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-skills-'));
    const r = dshInstall.installSkills({ dshHome: home });
    expect(r.installed).toContain('awf-plan-norm');
    expect(r.installed.length).toBeGreaterThan(3);
    const link = path.join(home, 'skills', 'awf-plan-norm');
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true); // 设计目标：安装 = 链接，改源即生效
    expect(fs.existsSync(path.join(link, 'SKILL.md'))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('目标已有同名技能且非 AWF 所装 → 跳过，不动用户的东西', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-skills-'));
    const mine = path.join(home, 'skills', 'awf-plan-norm');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '用户自己的');
    const r = dshInstall.installSkills({ dshHome: home });
    expect(r.skipped.some((x) => x.includes('awf-plan-norm'))).toBe(true);
    expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8')).toBe('用户自己的'); // 没被覆盖
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('卸载只摘清单里 AWF 装的，用户自建的技能一个不动', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-skills-'));
    const userSkill = path.join(home, 'skills', 'user-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '用户的');
    dshInstall.installSkills({ dshHome: home });
    const r = dshInstall.uninstallSkills({ dshHome: home });
    expect(r.removed).toContain('awf-plan-norm');
    expect(fs.existsSync(path.join(home, 'skills', 'awf-plan-norm'))).toBe(false);
    expect(fs.existsSync(userSkill)).toBe(true); // 用户的还在
    fs.rmSync(home, { recursive: true, force: true });
  });
});
