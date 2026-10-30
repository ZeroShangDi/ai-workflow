/**
 * assets.js — 插件**自有资产**的定位与解析（命令 / 技能 / 代理 / MCP 清单）
 *
 * 这是 DSH 插件自包含的支点：所有资产都用 `import.meta.url` 相对本包定位，
 * **不引用包目录以外的任何东西**（尤其不引用 cc 侧插件树）。
 *
 * 为什么能这么定位：Node 的 ESM 解析默认走 realpath，插件被软链进
 * `$DSH_HOME/profiles/<p>/node_modules/awf-dsh-plugin` 后，`import.meta.url`
 * 仍指向仓库里的真实目录 —— 所以「安装 = 软链一个文件夹」与「资产以包根相对定位」
 * 这两件事同时成立。（已实测，见 docs/discuss/dsh-plugin-structure.md §4）
 *
 * 资产形态（与 cc 侧插件同构，差异只在该平台必须的那几项）：
 *   commands/<name>.md        frontmatter: description / hint / empty-input；正文 = 注入给模型的指令
 *   skills/<name>/SKILL.md    frontmatter: name / description / whenToUse；正文 = 技能体
 *   agents/<name>.md          frontmatter: name / description / tools；正文 = persona
 *   mcp.json                  3 个 MCP server 的声明（相对本包，替代旧的 awfRepo 外部定位）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根（lib/ 的上一级） */
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 插件包根绝对路径 */
export function pluginRoot() {
  return ROOT;
}

/**
 * 解析 markdown frontmatter（只支持本仓资产实际用到的子集）。
 *
 * 支持：`key: 值`、`key: >`（折叠块，换行折成空格）、`key: |`（字面块，保留换行）、
 * 单双引号包裹的值、空行与 `#` 注释行跳过。
 * 不支持（本仓资产也没用）：嵌套映射、数组、锚点 —— 遇到了会原样当字符串，
 * 不猜、不静默丢。
 *
 * @param {string} text 文件原文
 * @returns {{ data: Record<string, string>, body: string }} frontmatter 键值 + 正文
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '');
  if (!src.startsWith('---\n')) return { data: {}, body: src };

  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };

  const rawLines = src.slice(4, end).split('\n');
  const body = src.slice(src.indexOf('\n', end + 1) + 1).replace(/^\n+/, '');

  const data = {};
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;

    if (rest === '>' || rest === '|') {
      // 块标量：收走后续所有缩进行
      const chunk = [];
      let j = i + 1;
      for (; j < rawLines.length; j += 1) {
        const l = rawLines[j];
        if (l.trim() === '') { chunk.push(''); continue; }
        if (!/^\s/.test(l)) break;
        chunk.push(l.replace(/^\s+/, ''));
      }
      i = j - 1;
      const joined = chunk.join('\n').trim();
      data[key] = rest === '>' ? joined.replace(/\n+/g, ' ') : joined;
      continue;
    }

    data[key] = stripQuotes(rest.trim());
  }
  return { data, body };
}

function stripQuotes(v) {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** 包内某个资产子目录的绝对路径（不存在则返回 null） */
export function assetDir(sub) {
  const dir = path.join(ROOT, sub);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
}

/** 子目录下的条目名（目录或文件），排序后返回；缺目录 → 空数组 */
function listEntries(sub, pred) {
  const dir = assetDir(sub);
  if (!dir) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(pred)
    .map((e) => e.name)
    .sort();
}

/**
 * 全部命令（commands/<name>.md）。
 * @returns {Array<{name: string, description: string, hint: string|null, emptyInput: string|null, body: string}>}
 */
export function listCommands() {
  return listEntries('commands', (e) => e.isFile() && e.name.endsWith('.md')).map((file) => {
    const name = file.replace(/\.md$/, '');
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(ROOT, 'commands', file), 'utf8'));
    return {
      name,
      description: data.description || name,
      hint: data.hint || null,
      emptyInput: data['empty-input'] || null,
      body: body.trim(),
    };
  });
}

/**
 * 全部技能（skills/<name>/SKILL.md）。
 * 技能名以 frontmatter 的 `name` 为准（与 DSH 的发现规则一致：目录名不参与命名）。
 * 缺 `name` 或 `description` 的条目**跳过并回报**（DSH 侧会直接忽略这种文件，这里提前对齐）。
 * @returns {{ skills: Array<object>, skipped: Array<{dir: string, reason: string}> }}
 */
export function listSkills() {
  const skills = [];
  const skipped = [];
  for (const dirName of listEntries('skills', (e) => e.isDirectory())) {
    const md = path.join(ROOT, 'skills', dirName, 'SKILL.md');
    if (!fs.existsSync(md)) { skipped.push({ dir: dirName, reason: '缺 SKILL.md' }); continue; }
    const { data, body } = parseFrontmatter(fs.readFileSync(md, 'utf8'));
    if (!data.name || !data.description) {
      skipped.push({ dir: dirName, reason: '缺 frontmatter name/description' });
      continue;
    }
    skills.push({
      name: data.name,
      description: data.description,
      ...(data.whenToUse ? { whenToUse: data.whenToUse } : {}),
      body: body.trim(),
      dir: path.join(ROOT, 'skills', dirName),
    });
  }
  return { skills, skipped };
}

/**
 * 全部子 Agent 身份（agents/<name>.md）。
 *
 * cc 靠 `subagent_type` 引用这份定义；DSH 没有 subagent_type，靠
 * **一个独立的 `tool-subagent` 实例**表达 —— 所以这里解析出的每一项都会被装配成
 * 一个模型可见的工具，工具名由 `toolNameFor()` 决定。
 *
 * @returns {Array<{name: string, toolName: string, description: string, persona: string,
 *                  allowTools: string[]|null, maxDepth: number|null}>}
 */
export function listAgents() {
  return listEntries('agents', (e) => e.isFile() && e.name.endsWith('.md')).map((file) => {
    const name = file.replace(/\.md$/, '');
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(ROOT, 'agents', file), 'utf8'));
    return {
      name: data.name || name,
      toolName: toolNameFor(data.name || name),
      description: data.description || name,
      persona: body.trim(),
      allowTools: data.tools ? data.tools.split(',').map((s) => s.trim()).filter(Boolean) : null,
      maxDepth: data['max-depth'] !== undefined ? Number(data['max-depth']) : null,
    };
  });
}

/** cc 的代理名（kebab）→ DSH 工具名（蛇形；DSH 工具名不允许中划线语义上的命名空间，蛇形是本平台惯例） */
export function toolNameFor(agentName) {
  return String(agentName).trim().replace(/-/g, '_');
}

/**
 * cc 代理 frontmatter 的 `tools:` 白名单 → DSH 全局工具名。
 *
 * 映射依据：`dsh-agent-presets/presets/standard/agent.cordis.yml` 里实际挂载的工具行
 * （tool-fs → read/write/edit，tool-fs-search → glob/grep，tool-bash → bash，
 *  tool-web → web_fetch/web_search，tool-todo → todo_write，tool-ask-user → ask_user_question）。
 *
 * **没在表里的名字不猜**：原样返回，由调用方（lib/agents.js）在真实工具面上核验后决定取舍，
 * 核不上的会被剔除并留痕 —— 宁可少给权限，也不让一次静默改名变成「权限没设上」。
 */
const TOOL_NAME_MAP = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Glob: 'glob',
  Grep: 'grep',
  Bash: 'bash',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
  AskUserQuestion: 'ask_user_question',
  Skill: 'skill',
  Agent: 'subagent',
  SendMessage: 'send_message',
};

/**
 * @param {string[]} ccTools cc frontmatter 的工具名列表
 * @returns {{mapped: string[], unmapped: string[]}} 映射结果与「表里没有、原样带回」的名字
 */
export function mapToolNames(ccTools) {
  const mapped = [];
  const unmapped = [];
  for (const t of ccTools ?? []) {
    if (TOOL_NAME_MAP[t]) mapped.push(TOOL_NAME_MAP[t]);
    else unmapped.push(t); // mcp__* 之类的原样带回，交给调用方核验
  }
  return { mapped, unmapped };
}

/**
 * MCP server 清单（mcp.json）。路径字段是**本包内相对路径**，与声明分离：
 * 声明里只写 server 名与入口相对路径，绝对路径在 lib/mcp.js 里拼 —— 换机器/换安装位置都不影响。
 * @returns {Array<{name: string, entry: string, mountByDefault: boolean}>}
 */
export function listMcpServers() {
  const manifest = path.join(ROOT, 'mcp.json');
  if (!fs.existsSync(manifest)) return [];
  const cfg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const servers = Array.isArray(cfg?.servers) ? cfg.servers : [];
  return servers
    .filter((s) => s && typeof s.name === 'string' && typeof s.entry === 'string')
    .map((s) => ({ name: s.name, entry: s.entry, mountByDefault: s.mountByDefault === true }));
}

export const ROOT_DIR = ROOT;
