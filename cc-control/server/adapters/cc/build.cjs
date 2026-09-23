'use strict';
/**
 * build.cjs — cc 侧插件构造器：中性源 `plugin/<包>/<内容目录>` → `server/adapters/cc/plugin/<包>/<内容目录>`
 *
 * ## 为什么有它
 * 各插件包里的**内容**（命令 / 技能 / 代理 / MCP server）
 * 是平台中性的，只有一份真值 —— 放在包根的 `plugin/`。本构造器把它生成到 cc 树的安装位置，
 * dsh 侧的同名构造器生成到它自己的位置。**两侧都不再手改生成物。**
 *
 * ## 只管内容，不管清单
 * `plugin.json` / `.mcp.json` / `hooks/hooks.json` **不在源里**：它们是 cc 平台的接线清单，
 * 本来就由 `scripts/render-config.mjs` 从 `config.json` 渲染。`core/hooks/gateway.cjs` 是 cc
 * 手写代码，同样不进源。
 *
 * ## 内容原样搬，一个字段都不删
 * 源的元数据是**超集**（`description` + `argument-hint` 给 cc，`hint` / `empty-input` 给 dsh）——
 * 各平台读自己的键，不互相派生。cc 侧原样保留整块 frontmatter：
 *   - 未知键 CC 运行时**容忍**（`claude plugin validate` 会把「未识别字段」列为 warning，
 *     但那是 `--strict` 才致命的提示，不是加载失败）；
 *   - 反过来「删字段」有实据的代价：**命令没有 frontmatter 本身就是一条 CC 警告**
 *     （`No frontmatter block found … to set description`），正是补上它才消掉的。
 *
 * ⚠️ 技能与代理的 frontmatter 更**必须**原样保留 —— 那不是元数据，是定义本身：
 * 代理的 `name`/`description`/`tools`/`model` 就是身份，技能的 `name`/`description` 是发现依据。
 * （写这一版时踩过：无差别剥离把 cc 的代理定义剥没了。）
 *
 * 用法：`node server/adapters/cc/build.cjs`（`npm run build` 会调）
 */

const fs = require('node:fs');
const path = require('node:path');

/** 源根：包根下的 plugin/ */
function sourceRoot(pkgRoot = path.resolve(__dirname, '..', '..', '..')) {
  return path.join(pkgRoot, 'plugin');
}

/** 产物根：cc 插件的安装位置 */
function targetRoot(pkgRoot = path.resolve(__dirname, '..', '..', '..')) {
  return path.join(pkgRoot, 'server', 'adapters', 'cc', 'plugin');
}

/** 从源里遍历出的「哪些包、有哪些内容目录」——不写死，按实际存在的目录走 */
function discover(source) {
  const found = [];
  if (!fs.existsSync(source)) return found;
  for (const pkg of fs.readdirSync(source).sort()) {
    const pkgDir = path.join(source, pkg);
    if (!fs.statSync(pkgDir).isDirectory()) continue;
    for (const dir of fs.readdirSync(pkgDir).sort()) {
      const content = path.join(pkgDir, dir);
      if (fs.statSync(content).isDirectory()) found.push({ pkg, dir, from: content });
    }
  }
  return found;
}

/**
 * 生成 cc 侧的全部内容目录。
 * @param {{ pkgRoot?: string, log?: Function }} [opts]
 * @returns {{ written: string[], files: number }}
 */
function build({ pkgRoot, log = () => {} } = {}) {
  const source = sourceRoot(pkgRoot);
  const target = targetRoot(pkgRoot);
  if (!fs.existsSync(source)) throw new Error(`构造源不存在：${source}`);

  const written = [];
  let files = 0;
  for (const { pkg, dir, from } of discover(source)) {
    const to = path.join(target, pkg, dir);
    // 先清后写：源里删掉的东西必须在产物里也消失，否则会留下孤儿文件
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    files += countFiles(to);
    written.push(`${pkg}/${dir}`);
  }
  log(`[build:cc] ${written.length} 个内容目录 → ${path.relative(pkgRoot || process.cwd(), target)}（${files} 文件）`);
  return { written, files };
}

/** 数一个目录下的文件数（构造日志用） */
function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

module.exports = { build, discover, sourceRoot, targetRoot };

if (require.main === module) {
  build({ log: (m) => console.log(m) });
}
