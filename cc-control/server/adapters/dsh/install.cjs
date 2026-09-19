'use strict';
/**
 * install.cjs — DSH 侧的「接入装配」（把 AWF 装进 DSH 的 profile）
 *
 * 与 cc 侧 `cc/profile.cjs` 对位：cc 往**项目**的 `.claude/settings.json` 注入，DSH 往**用户级
 * profile**装配（全局一次，多项目共享 —— U5/U12：插件全局安装、项目分别启用）。
 *
 * ## 装什么
 *   ① profile 的 `cordis.patch.yml` 里插一行 `awf-dsh`（plugin 名 = `awf-dsh-plugin`）；
 *   ② 把插件包**拷进** profile 的 `node_modules/`（本机无 pnpm，见 F13；拷贝而非软链，
 *      这样插件对 `@deepseek-ai/dsh-*` 的 import 能经 profile 的父级 node_modules 解析到）。
 *
 * ## 怎么改才安全
 *   - 只动两处：patch 文件里**标记块**（`# >>> awf-dsh` … `# <<< awf-dsh`）与我们的包目录；
 *   - 改前备份 `cordis.patch.yml` → `cordis.patch.yml.awf-backup`（只备一次，不覆盖旧备份）；
 *   - **幂等**：已有标记块就跳过；卸载只摘我们的块，留下别人的内容；
 *   - 不删别人的 patch、不动别处的 node_modules。
 *
 * ⚠️ 真实用户的 DSH_HOME 是运行中进程持有的（F11）。本模块**只写你让它写的那个 DSH_HOME**；
 * 实验/测试一律传隔离目录。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 标记块（幂等与卸载都认它） */
const MARK_BEGIN = '# >>> awf-dsh (managed by ai-workflow; do not edit) >>>';
const MARK_END = '# <<< awf-dsh <<<';

/** 插件包名（profile 的 patch 行里 `name:` 的值） */
const PLUGIN_PACKAGE = 'awf-dsh-plugin';

/** DSH_HOME：显式参数 > env DSH_HOME > 缺省 ~/.dsh */
function resolveDshHome(dshHome) {
  return path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
}

/** profile 目录（缺省 web —— DSH 的浏览器形态） */
function profileDir(dshHome, profile = 'web') {
  return path.join(resolveDshHome(dshHome), 'profiles', profile);
}

/** 插件源码目录（本包内的 dsh-plugin/） */
function pluginSourceDir() {
  return path.resolve(__dirname, 'plugin');
}

/**
 * 我们那段 YAML（顶层数组的一项）。
 *
 * 两个配置项都是**必须写对**的（漏了会在真实安装里立刻失败，而探针因为走环境变量而看不见）：
 *   - `awfBase`：AWF 常驻 server 的地址。没有它插件**不启动指令通道**（只告警）—— F42；
 *   - `webPort`：**DSH 网页**端口（会话观看地址用）。它**不是** AWF server 端口。
 *
 * `awfRepo` 已删除：它原本是为了让插件去 **cc 侧插件树** 取 MCP server 入口，
 * 属于「插件目录引用外部目录」，且安装位置一变就断。现在 MCP server 随包携带
 * （`<插件目录>/mcp/<name>/server.cjs`），入口由插件自己按包根解析。
 */
function managedBlock({ awfBase, webPort } = {}) {
  const lines = [
    MARK_BEGIN,
    '# awf 接入层（本段由 ai-workflow 管理；卸载 `awf plugin uninstall` 会整段摘掉）',
    '- insert:',
    `    - id: awf-dsh`,
    `      name: '${PLUGIN_PACKAGE}'`,
    '      config:',
    ...(awfBase ? [`        awfBase: '${awfBase}'`] : []),
    `        webPort: ${Number(webPort) || 3080}`,
    MARK_END,
  ];
  return `${lines.join('\n')}\n`;
}

/** 取 patch 里我们那段托管块（含标记行）；没有 → null */
function extractBlock(text) {
  const lines = String(text || '').split('\n');
  const begin = lines.findIndex((l) => l.includes(MARK_BEGIN));
  const end = lines.findIndex((l) => l.includes(MARK_END));
  if (begin === -1 || end < begin) return null;
  return lines.slice(begin, end + 1).join('\n') + '\n';
}

/** 用新块替换旧块（保留用户其它内容；块不存在则返回 null 由调用方决定插哪） */
function replaceBlock(text, block) {
  const lines = String(text || '').split('\n');
  const begin = lines.findIndex((l) => l.includes(MARK_BEGIN));
  const end = lines.findIndex((l) => l.includes(MARK_END));
  if (begin === -1 || end < begin) return null;
  return [...lines.slice(0, begin), ...block.replace(/\n$/, '').split('\n'), ...lines.slice(end + 1)].join('\n');
}

/** 去掉注释与空白后看内容是否「实质为空」（`[]` 或缺文件） */
function isEffectivelyEmpty(text) {
  const stripped = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .join('');
  return stripped === '' || stripped === '[]';
}

/**
 * 把插件装进 DSH profile。
 * @param {{ dshHome?: string, profile?: string, awfBase?: string, webPort?: number, pluginDir?: string }} [opts]
 * @returns {{ written: boolean, path: string, pluginPath: string, backupPath: string|null, reason?: string, error?: string }}
 */
function installProfile({ dshHome, profile = 'web', awfBase, webPort = 3080, pluginDir } = {}) {
  const dir = profileDir(dshHome, profile);
  const patchPath = path.join(dir, 'cordis.patch.yml');
  const pluginSrc = pluginDir || pluginSourceDir();
  const pluginDest = path.join(dir, 'node_modules', PLUGIN_PACKAGE);

  try {
    if (!fs.existsSync(dir)) {
      return { written: false, path: patchPath, pluginPath: pluginDest, backupPath: null, error: `profile 目录不存在：${dir}（先跑一次 dsh --profile ${profile} 让 DSH 建 profile）` };
    }
    if (!fs.existsSync(pluginSrc)) {
      return { written: false, path: patchPath, pluginPath: pluginDest, backupPath: null, error: `插件源码不存在：${pluginSrc}` };
    }

    const existing = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
    const block = managedBlock({ awfBase, webPort });
    if (existing.includes(MARK_BEGIN)) {
      // 幂等：patch 已有我们的块。但**内容可能已经过期**（升级后新增/更正的配置项）
      // ——那时必须原地更新，否则「重新安装」是个无效操作（F43 就是这么被踩到的）。
      copyPlugin(pluginSrc, pluginDest);
      const current = extractBlock(existing);
      if (current !== null && current !== block) {
        fs.writeFileSync(patchPath, replaceBlock(existing, block));
        return { written: true, path: patchPath, pluginPath: pluginDest, backupPath: null, reason: '托管块内容已更新（配置项有变）' };
      }
      return { written: false, path: patchPath, pluginPath: pluginDest, backupPath: null, reason: 'patch 已含 awf-dsh 块且内容一致（跳过写入）' };
    }

    // 备份（只备一次，不覆盖已存在的备份）
    let backupPath = null;
    if (fs.existsSync(patchPath)) {
      backupPath = `${patchPath}.awf-backup`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(patchPath, backupPath);
    }

    // 保留用户写的一切（含注释）；只把「空数组」那个占位符拿掉，否则 `[]` 后面再跟数组项是非法 YAML
    const kept = existing
      .split('\n')
      .filter((l) => l.trim() !== '[]')
      .join('\n')
      .replace(/\s*$/, '');
    const next = kept === '' ? block : `${kept}\n\n${block}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(patchPath, next);

    copyPlugin(pluginSrc, pluginDest);
    return { written: true, path: patchPath, pluginPath: pluginDest, backupPath };
  } catch (err) {
    return { written: false, path: patchPath, pluginPath: pluginDest, backupPath: null, error: err.message };
  }
}

/** 卸载：只摘我们的标记块与包目录，别人写的内容原样留着 */
function uninstallProfile({ dshHome, profile = 'web' } = {}) {
  const dir = profileDir(dshHome, profile);
  const patchPath = path.join(dir, 'cordis.patch.yml');
  const pluginDest = path.join(dir, 'node_modules', PLUGIN_PACKAGE);
  try {
    let removed = false;
    if (fs.existsSync(patchPath)) {
      const text = fs.readFileSync(patchPath, 'utf8');
      if (text.includes(MARK_BEGIN)) {
        const lines = text.split('\n');
        const begin = lines.findIndex((l) => l.includes(MARK_BEGIN));
        const end = lines.findIndex((l) => l.includes(MARK_END));
        if (begin !== -1 && end >= begin) {
          const kept = [...lines.slice(0, begin), ...lines.slice(end + 1)].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '');
          // 只剩空白才回落成 `[]`：用户的注释是内容，不能被当成「空」清掉
          fs.writeFileSync(patchPath, kept.trim() === '' ? '[]\n' : `${kept}\n`);
          removed = true;
        }
      }
    }
    if (fs.existsSync(pluginDest)) {
      fs.rmSync(pluginDest, { recursive: true, force: true });
      removed = true;
    }
    return { written: removed, path: patchPath, pluginPath: pluginDest };
  } catch (err) {
    return { written: false, path: patchPath, pluginPath: pluginDest, error: err.message };
  }
}

/**
 * 拷贝插件包（先清后拷，避免残留旧文件）。
 *
 * **整目录拷**，不只是 package.json/index.js/lib —— 插件现在是自包含的：命令 md、技能、
 * 子 Agent 定义、随包的 MCP server（含 mcp/_lib/ 的叶子依赖）都在目录里，装配时由插件自己读。
 *
 * 为什么不软链（用户最初的设想是「link 一个文件夹」）：Node 按**真实路径**解析包的裸 import，
 * 软链进 profile 后 `import('@deepseek-ai/dsh-llm')` 会从仓库目录往上找，永远到不了
 * `<profile>/node_modules`，插件直接起不来。（实测记录见 docs/discuss/dsh-plugin-structure.md §4）
 * 所以「安装单元 = 一个文件夹」成立，但装法是拷。
 *
 * 唯一排除 node_modules：依赖由 profile 的 node_modules 解析（本机无 pnpm，见 F13）。
 */
function copyPlugin(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => path.basename(from) !== 'node_modules',
  });
}

/** 装了没装（供状态展示 / 幂等判断） */
function isInstalled({ dshHome, profile = 'web' } = {}) {
  const dir = profileDir(dshHome, profile);
  const patchPath = path.join(dir, 'cordis.patch.yml');
  const pluginDest = path.join(dir, 'node_modules', PLUGIN_PACKAGE);
  let patchHas = false;
  try { patchHas = fs.readFileSync(patchPath, 'utf8').includes(MARK_BEGIN); } catch { /* 缺文件 = 没装 */ }
  return { installed: patchHas && fs.existsSync(pluginDest), patchHas, pluginPresent: fs.existsSync(pluginDest), path: patchPath, pluginPath: pluginDest };
}

/**
 * ── 技能：**已改为会话级注册，安装期不再往用户 home 铺链接**（保留本段只为清理旧安装）──
 *
 * 旧口径（C29）：把 `plugin/skills/<name>` 符号链接进 `$DSH_HOME/skills/<name>`，等平台扫到。
 * 它有两个问题：
 *   ① `$DSH_HOME/skills` 是**全局可见**的技能根（rank 400）—— 这 36 个 AWF 技能会出现在
 *      用户自己的每个 DSH 会话里，还会 first-wins 抢掉用户同名技能；
 *   ② web 组合里 `skill-filesystem` 位于 agent preset 平面（host 行 disabled，F18），
 *      「往全局根塞目录」是否真被发现，取决于 preset 的读取作用域，本来就不可靠。
 *
 * 现在：技能随插件目录走，**会话建立时由插件经 `agentCtx.skills.register()` 注册**到该 agent 的
 * 作用域层（见 plugin/lib/skills.js）—— 只有 AWF 自己建的会话看得到，不污染用户环境，
 * 也不再需要安装期动作。
 *
 * 因此 `installSkills` 已删除（没有任何路径该重建旧布局）；只保留 `uninstallSkills` ——
 * 它的唯一职责是把历史安装留在用户 `$DSH_HOME/skills` 里的链接按清单摘干净。
 */

/** 插件里全部技能（plugin/skills/<name>/SKILL.md）—— 只读清单 */
function listSkills() {
  const root = path.resolve(__dirname, 'plugin', 'skills');
  const skills = [];
  if (fs.existsSync(root)) {
    for (const dir of fs.readdirSync(root)) {
      const md = path.join(root, dir, 'SKILL.md');
      if (fs.existsSync(md)) skills.push({ name: dir, sourceDir: path.join(root, dir) });
    }
  }
  return skills;
}

/** 清单文件：旧口径记下「哪些是我们装的、链接还是复制」，清理历史安装时认它 */
function skillsManifestPath(skillsRoot) {
  return path.join(skillsRoot, '.awf-skills.json');
}

/** 只摘清单里 AWF 自己装的技能；用户自建的技能一个不动 */
function uninstallSkills({ dshHome } = {}) {
  const home = resolveDshHome(dshHome);
  const root = path.join(home, 'skills');
  const manifestPath = skillsManifestPath(root);
  const removed = [];
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const name of Object.keys(manifest.entries || {})) {
      const dest = path.join(root, name);
      try { if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); removed.push(name); } } catch { /* 单个失败不阻断 */ }
    }
    fs.rmSync(manifestPath, { force: true });
  }
  return { removed };
}

module.exports = {
  installProfile,
  managedBlock,
  extractBlock,
  replaceBlock,
  uninstallProfile,
  isInstalled,
  resolveDshHome,
  profileDir,
  pluginSourceDir,
  PLUGIN_PACKAGE,
  MARK_BEGIN,
  MARK_END,
  uninstallSkills,
  listSkills,
};
