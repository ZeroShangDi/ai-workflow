'use strict';
/**
 * build.cjs — dsh 侧插件构造器：中性源 `plugin/<包>/<内容目录>` → `server/adapters/dsh/plugin/<内容目录>`
 *
 * ## 与 cc 侧的两点不同
 *   ① **拍平**：源里是三个插件包（core / decision / plugin-code，那是 cc 市场的切分），
 *      DSH 的安装单元是一条 profile patch 行 → 汇成一个包。
 *   ② **要变换**：源是 cc 口径的正文（命令命名空间、`subagent_type`、CC 工具名…），
 *      DSH 侧必须换成自己的（命令名禁冒号、命名身份靠专用工具实例、工具名蛇形）。
 *      变换规则集中在下面 `BODY_RULES`，逐条有真机依据。
 *
 * ## 为什么规则不是「变量」
 * 用户已定：正文里的这些引用**后续会变成变量**、由各侧维护。本轮先落成机械替换 ——
 * 不留它们的话 dsh 产物会变，逐字节验收就失效了。等变量机制上来，`BODY_RULES` 整段被替换掉。
 *
 * 用法：`node server/adapters/dsh/build.cjs`（`npm run build` 会调）
 */

const fs = require('node:fs');
const path = require('node:path');

function pkgRootDir() {
  return path.resolve(__dirname, '..', '..', '..');
}
function sourceRoot(root = pkgRootDir()) {
  return path.join(root, 'plugin');
}
function targetRoot(root = pkgRootDir()) {
  return path.join(root, 'server', 'adapters', 'dsh', 'plugin');
}

/**
 * 正文改写规则（**顺序有意义**，后面的规则依赖前面的结果）。
 *
 * 依据速查：
 *   - 命令名正则 `^[a-z][a-z0-9_-]*$` 禁冒号 → cc 的 `ai-workflow-code:w-plan` 在 DSH 非法；
 *   - DSH **没有 subagent_type 注册表** → 命名身份靠「调哪个工具」表达（`awf_worker` 等）；
 *   - 工具名蛇形（`read`/`grep`/`ask_user_question`），与 CC 的 `Read`/`Grep`/`AskUserQuestion` 不同；
 *   - `Agent 工具`（CC 的派生工具）在 DSH 是 `subagent`（平台内置）或本插件的命名实例。
 */
const BODY_RULES = [
  // 命令命名空间在 DSH 非法（正则禁冒号）→ 扁平名
  [/\/ai-workflow-code:w-/g, '/w-'],
  // 命名子 Agent：cc 的 `subagent_type: <插件名>:<代理名>` → DSH 的工具名（蛇形）
  [/ai-workflow-core:awf-worker/g, 'awf_worker'],
  [/ai-workflow-core:awf-monitor-probe/g, 'awf_monitor_probe'],
  [/ai-workflow-core:awf-monitor-repair/g, 'awf_monitor_repair'],
  // 交互工具名
  [/AskUserQuestion/g, 'ask_user_question'],
  [/Skill 工具/g, 'skill 工具'],
  // CC 的派生工具叫「Agent 工具」，DSH 侧内置的那个叫 `subagent`
  [/Agent 工具/g, 'subagent 工具'],
  // DSH 的命名身份就是工具名本身，没有 `subagent_type` 参数 → 句式一并改写
  [/用 subagent 工具派发一个前台子 Agent（`subagent_type: ([a-z0-9_]+)`）/g, '用 `$1` 工具派发一个前台子 Agent'],
];

/** 代理身份正文里的「派生它的工具」按身份写实（awf-worker 由 `awf_worker` 工具派生） */
const AGENT_TOOL_NAME = { 'awf-worker': 'awf_worker' };

/** 这些 MCP server 是 cc 专有，不随 DSH 包 */
const MCP_SKIP = new Set(['awf-oneshot']); // `claude -p` 实现；DSH 的一次性调用走 llm.stream

/** 从源遍历出内容目录（三包拍平；同名以先到者为准并告警） */
function discover(source, log = () => {}) {
  const byDir = new Map();
  if (!fs.existsSync(source)) return byDir;
  for (const pkg of fs.readdirSync(source).sort()) {
    const pkgDir = path.join(source, pkg);
    if (!fs.statSync(pkgDir).isDirectory()) continue;
    for (const dir of fs.readdirSync(pkgDir).sort()) {
      const content = path.join(pkgDir, dir);
      if (!fs.statSync(content).isDirectory()) continue;
      if (byDir.has(dir)) {
        log(`[build:dsh] 注意：${pkg}/${dir} 与已有来源同名，合入同一个 ${dir}/（同名文件后者被跳过）`);
        byDir.set(dir, [...byDir.get(dir), content]);
      } else byDir.set(dir, [content]);
    }
  }
  return byDir;
}

/** 解析 frontmatter（源命令是 `description` / `argument-hint` / `empty-input`） */
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const afterClose = text.indexOf('\n', end + 1);
  const data = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (m) data[m[1]] = m[2].replace(/^'(.*)'$/, '$1');
  }
  // ⚠️ 正文**原样**从闭合 fence 的换行之后取，不做 \n+ 归并 —— 源里 frontmatter 与正文之间的那个
  //    空行是原文的一部分，吃掉它产物就与重构前不一致了（agents 上踩到过）。
  return { data, body: text.slice(afterClose + 1) };
}

/** 正文改写：先套通用规则，再套该身份专属的规则 */
function rewriteBody(body, agentName) {
  let out = body;
  for (const [re, to] of BODY_RULES) out = out.replace(re, to);
  const tool = agentName && AGENT_TOOL_NAME[agentName];
  if (tool) out = out.replace(/subagent 工具/g, `${tool} 工具`);
  return out;
}

/** 命令：源的 frontmatter → DSH 的注册参数（`argument-hint` → `hint`），正文改写 */
function renderCommand(name, text) {
  const { data, body } = parseFrontmatter(text);
  if (!data.description) throw new Error(`源命令 ${name} 缺 frontmatter description（DSH 的 commands.register 强校验）`);
  // 元数据是**超集**：DSH 读自己的 `hint`，不要求 cc 的 `argument-hint` 改名过来
  const hint = data.hint ?? data['argument-hint'] ?? `<${name} 的输入>`;
  const lines = [`description: ${data.description}`, `hint: ${hint}`];
  if (data['empty-input']) lines.push(`empty-input: '${data['empty-input']}'`);
  return `---\n${lines.join('\n')}\n---\n${rewriteBody(body)}`;
}

/** 代理：正文改写 + 加 `max-depth`（源里没有，是 DSH 侧的平台配置） */
function renderAgent(name, text) {
  const { data, body } = parseFrontmatter(text);
  // frontmatter 的值同样是给模型看的散文（description 里有「Agent 工具」这种措辞），必须一起改写
  const fm = Object.entries(data).map(([k, v]) => `${k}: ${rewriteBody(v, name)}`).join('\n');
  return `---\n${fm}\nmax-depth: 0\n---\n${rewriteBody(body, name)}`;
}

/** MCP server：只取 `server.cjs`，并把包外 require 改写成随包携带的 `_lib/` */
function rewriteMcpRequires(text) {
  return text.replace(
    /'\.\.'(?:,\s*'\.\.'){5,},\s*'server',\s*'shared',\s*'([^']+)'/g,
    "'..', '_lib', '$1'",
  );
}

/**
 * 生成 dsh 侧的全部内容目录。
 * @param {{ pkgRoot?: string, log?: Function }} [opts]
 * @returns {{ written: string[], files: number, skipped: string[] }}
 */
function build({ pkgRoot, log = () => {} } = {}) {
  const root = pkgRoot || pkgRootDir();
  const source = sourceRoot(root);
  const target = targetRoot(root);
  if (!fs.existsSync(source)) throw new Error(`构造源不存在：${source}`);

  const byDir = discover(source, log);
  const written = [];
  const skipped = [];
  let files = 0;

  for (const [dir, sources] of byDir) {
    const to = path.join(target, dir);
    fs.rmSync(to, { recursive: true, force: true });   // 先清后写：源里删掉的产物也要消失
    fs.mkdirSync(to, { recursive: true });

    if (dir === 'mcp') {
      for (const from of sources) {
        for (const srv of fs.readdirSync(from).sort()) {
          if (MCP_SKIP.has(srv)) { skipped.push(`mcp/${srv}（cc 专有）`); continue; }
          const src = path.join(from, srv, 'server.cjs');
          if (!fs.existsSync(src)) continue;           // 只要 server.cjs（state.template.json 是 awf init 的资产，不进包）
          const dstDir = path.join(to, srv);
          fs.mkdirSync(dstDir, { recursive: true });
          fs.writeFileSync(path.join(dstDir, 'server.cjs'), rewriteMcpRequires(fs.readFileSync(src, 'utf8')));
          files += 1;
        }
      }
      // 随包携带的叶子依赖（awf-state 用；它们自己的 require 只有 node: 内置，原样拷）
      const libDir = path.join(to, '_lib');
      fs.mkdirSync(libDir, { recursive: true });
      for (const f of ['store-core.cjs', 'task-graph.cjs']) {
        fs.copyFileSync(path.join(root, 'server', 'shared', f), path.join(libDir, f));
        files += 1;
      }
      written.push('mcp');
      continue;
    }

    const seen = new Set();
    for (const from of sources) {
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (seen.has(e.name)) continue;                // 同名后者跳过（discover 已告警）
        seen.add(e.name);
        const src = path.join(from, e.name);
        const dst = path.join(to, e.name);
        if (e.isDirectory()) {                         // 技能目录（内含 SKILL.md 与 references/）
          files += copyRewritten(src, dst, dir);
          continue;
        }
        const text = fs.readFileSync(src, 'utf8');
        if (dir === 'commands') fs.writeFileSync(dst, renderCommand(e.name.replace(/\.md$/, ''), text));
        else if (dir === 'agents') fs.writeFileSync(dst, renderAgent(e.name.replace(/\.md$/, ''), text));
        else fs.writeFileSync(dst, rewriteBody(text)); // skills：frontmatter 原样，正文改写
        files += 1;
      }
    }
    written.push(dir);
  }

  log(`[build:dsh] ${written.length} 个内容目录 → ${path.relative(root, target)}（${files} 文件）`);
  if (skipped.length) log(`[build:dsh] 跳过：${skipped.join('、')}`);
  return { written, files, skipped };
}

/**
 * 拷一个技能目录：其中的 .md 逐个走正文改写，其余原样。
 * （写这一版时踩过：整目录 cpSync 会把改写整段跳过 —— 表现为 SKILL.md 里还是 cc 的命令命名空间。）
 */
function copyRewritten(from, to, dir) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { n += copyRewritten(src, dst, dir); continue; }
    if (e.name.endsWith('.md')) fs.writeFileSync(dst, rewriteBody(fs.readFileSync(src, 'utf8')));
    else fs.copyFileSync(src, dst);
    n += 1;
  }
  return n;
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

module.exports = {
  build, BODY_RULES, MCP_SKIP, discover, parseFrontmatter, rewriteBody, rewriteMcpRequires,
  sourceRoot, targetRoot,
};

if (require.main === module) {
  build({ log: (m) => console.log(m) });
}
