'use strict';
/**
 * shared/workspace.cjs — 项目工作区（`.awf/`）的骨架与模板播种
 *
 * 「`awf init` 之后项目里长什么样」这件事的唯一知情者：建哪些目录、README/config/架构说明
 * 从哪来、state.json 怎么播。上层（CLI 的 init 命令）只调用，不自己 copy 文件。
 *
 * ## 模板放哪
 * 模板是**项目工作区的形状**，随新 server 一起分发：`server/templates/`（本模块是它的读取口）。
 *
 * ⚠️ **过渡期的重复**：旧树 `src/templates/` 里还有一份同名文件（旧 CLI 在读）。用户裁定：
 * 旧树不动，等重构收尾后**直接删掉旧树**，重复随之消失。在那之前，改模板**两边都要改**
 * —— 同 `shared/prompts.js` 的处置（两棵树各一份，注释写明需同步）。
 * 未搬的三份：`CLAUDE.md.template`（已弃用，0 字节）、`w-tree-template.html`（无引用）。
 *
 * ## state 模板为什么不在这
 * `state.json` 的模板由**插件**声明（`plugin/core/.../awf-state/state.template.json`），
 * 经 `shared/prompts.js` 的 `stateTemplatePath()` 取 —— 它是 MCP 与 CLI 共用的资产，
 * 不随本模块搬动。
 */

const fs = require('node:fs');
const path = require('node:path');
const { awfDir } = require('./project-paths.cjs');
const { stateTemplatePath } = require('./plugin-assets.cjs');

/** 工作区骨架目录（相对 .awf/）：文档四类 + 报告分档 + 版本快照 + 动态规划扩展边界 */
const WORKSPACE_DIRS = [
  'bugs', 'issues', 'decisions', 'context', 'logs', 'versions',
  'dynamic-planning/proposals',
  'reports/lint', 'reports/test', 'reports/review', 'reports/perf', 'reports/summary',
];

/** 模板文件 → 目标相对路径（缺失才播，绝不覆盖用户改过的） */
const TEMPLATE_FILES = [
  { template: 'awf-README.md', target: 'README.md' },
  { template: 'awf-config.json', target: 'config.json' },
  { template: 'architecture.md', target: path.join('context', 'architecture.md') },
];

/** 模板目录（本模块在 shared/ 下，上两级即 server/） */
function templatesDir() {
  return path.resolve(__dirname, '..', 'templates');
}

/** 读一份工作区模板原文 */
function readTemplate(name) {
  return fs.readFileSync(path.join(templatesDir(), name), 'utf8');
}

/** 递归把目录下所有文本文件里的 {{VERSION}} 换掉（版本号未知时跳过） */
function replaceVersionInDir(dir, version) {
  if (!version) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { replaceVersionInDir(full, version); continue; }
    try {
      const raw = fs.readFileSync(full, 'utf8');
      if (raw.includes('{{VERSION}}')) fs.writeFileSync(full, raw.replace(/\{\{VERSION\}\}/g, version));
    } catch { /* 二进制/不可读 → 跳过 */ }
  }
}

/** 播 state.json（缺失才播）：模板里 `{{TIMESTAMP}}` 换成当前时刻 */
function seedState(projectRoot) {
  const dest = path.join(awfDir(projectRoot), 'state.json');
  if (fs.existsSync(dest)) return false;
  try {
    const raw = fs.readFileSync(stateTemplatePath(), 'utf8').replace('{{TIMESTAMP}}', new Date().toISOString());
    fs.writeFileSync(dest, raw);
    return true;
  } catch {
    return false; // 插件资产缺失 → 不阻断初始化，run 时会提示先 plan
  }
}

/**
 * 建工作区骨架并播模板。
 * 幂等：已存在的目录跳过、**已存在的文件绝不覆盖**（用户改过的 README/config 不动）。
 * @param {string} projectRoot
 * @param {{ force?: boolean, version?: string }} [opts]
 *   force   目录已存在时也执行补全（补缺失文件）
 * @returns {{ created: boolean, dirs: number, files: string[], state: boolean }}
 */
function initWorkspace(projectRoot, { force = false, version } = {}) {
  const root = awfDir(projectRoot);
  const existed = fs.existsSync(root);
  if (existed && !force) return { created: false, dirs: 0, files: [], state: false };

  fs.mkdirSync(root, { recursive: true });
  for (const dir of WORKSPACE_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });

  const files = [];
  for (const { template, target } of TEMPLATE_FILES) {
    const dest = path.join(root, target);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readTemplate(template));
    files.push(target);
  }

  const state = seedState(projectRoot);
  replaceVersionInDir(root, version);
  return { created: !existed, dirs: WORKSPACE_DIRS.length, files, state };
}

module.exports = { initWorkspace, readTemplate, templatesDir, WORKSPACE_DIRS, TEMPLATE_FILES };
