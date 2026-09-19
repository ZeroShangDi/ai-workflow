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
  return path.resolve(__dirname, '..', '..', '..', 'dsh-plugin');
}

/** 我们那段 YAML（顶层数组的一项） */
function managedBlock({ webPort } = {}) {
  const lines = [
    MARK_BEGIN,
    '# awf 接入层（本段由 ai-workflow 管理；卸载 `awf plugin uninstall` 会整段摘掉）',
    '- insert:',
    `    - id: awf-dsh`,
    `      name: '${PLUGIN_PACKAGE}'`,
    '      config:',
    `        webPort: ${Number(webPort) || 3080}`,
    MARK_END,
  ];
  return `${lines.join('\n')}\n`;
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
 * @param {{ dshHome?: string, profile?: string, webPort?: number, pluginDir?: string }} [opts]
 * @returns {{ written: boolean, path: string, pluginPath: string, backupPath: string|null, reason?: string, error?: string }}
 */
function installProfile({ dshHome, profile = 'web', webPort = 3080, pluginDir } = {}) {
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
    if (existing.includes(MARK_BEGIN)) {
      // 幂等：patch 已有我们的块；仍确保包是最新的拷贝
      copyPlugin(pluginSrc, pluginDest);
      return { written: false, path: patchPath, pluginPath: pluginDest, backupPath: null, reason: 'patch 已含 awf-dsh 块（跳过写入）' };
    }

    // 备份（只备一次，不覆盖已存在的备份）
    let backupPath = null;
    if (fs.existsSync(patchPath)) {
      backupPath = `${patchPath}.awf-backup`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(patchPath, backupPath);
    }

    const block = managedBlock({ webPort });
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

/** 拷贝插件包（先清后拷，避免残留旧文件） */
function copyPlugin(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // 只拷运行所需：package.json + index.js + lib/（不带 node_modules —— 依赖由 profile 解析）
  fs.copyFileSync(path.join(src, 'package.json'), path.join(dest, 'package.json'));
  fs.copyFileSync(path.join(src, 'index.js'), path.join(dest, 'index.js'));
  fs.cpSync(path.join(src, 'lib'), path.join(dest, 'lib'), { recursive: true });
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

module.exports = {
  installProfile,
  uninstallProfile,
  isInstalled,
  resolveDshHome,
  profileDir,
  pluginSourceDir,
  PLUGIN_PACKAGE,
  MARK_BEGIN,
  MARK_END,
};
