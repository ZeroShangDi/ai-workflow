#!/usr/bin/env node
/**
 * check-architecture.mjs — 结构门禁（T1-114：从「取证工具」升级为「会失败的门禁」）
 *
 * 为什么升级：`.awf/issues/002-integration-has-no-task.md` —— v0.2.0 重构里「建抽象」与「接上 live」
 * 写在同一条任务里，而验收只判「建成」。于是抽象建了没人用、单测全绿、live 一行没变，
 * 最后清理任务把骨架当死代码删掉。**机器能拦住的，就不该只写在提醒里。**
 * 依据：`docs/discuss/planned-architecture-landing.md` §三（护栏三条不变量）。
 *
 * 三条不变量：
 *   1. zero-ref        `src/` 下的代码文件在生产侧（src/ scripts/ plugin/ web/src）零引用
 *   2. dep-direction   跨层导入越出 `ALLOWED` 声明方向
 *   3. structure       可配置结构断言（文件行数上限 / 目录不得出现某类文件），后续任务直接追加
 *
 * 用法：
 *   node scripts/check-architecture.mjs              门禁：有未豁免违例 → 非 0
 *   node scripts/check-architecture.mjs --strict     额外要求**豁免表为空**（T1-115 / T1-117 的验收）
 *   node scripts/check-architecture.mjs --warn-only  只报不拦（取证；永远 0）
 *   node scripts/check-architecture.mjs --json       机器可读
 *   node scripts/check-architecture.mjs --root <dir> 换根目录（测试夹具 / 仓库复用）
 *
 * 退出码：0 通过；1 有未豁免违例；2 用法/环境错误。
 */

import fs from 'node:fs';
import path from 'node:path';

// ── 分层与允许方向 ──────────────────────────────────────────────────────────

const LAYER_RULES = [
  [/^src\/adapters\//, 'adapters'],
  [/^src\/server\//, 'server'],
  [/^src\/cli\//, 'cli'],
  [/^src\/lib\//, 'lib'],
  [/^src\/templates\//, 'templates'],
  [/^src\/awf\.js$/, 'entry'],
  [/^plugin\/core\/mcp\//, 'plugin-mcp'],
  [/^web\//, 'web'],
  [/^scripts\//, 'scripts'],
];

/** 声明允许的依赖方向。凡未列出的「同层以外」导入即为越界。
 *  依据：docs/discuss/architecture-notes.md「已定勿翻」+ W3-001..008 模块描述 + 纪律 R-cc。 */
export const ALLOWED = new Set([
  'entry → cli',
  'cli → lib',
  'cli → adapters',
  'server → lib',
  'server → adapters',
  'scripts → lib',
  'scripts → server',
]);

// ── 显式白名单：零生产引用但**合理**的文件 ──────────────────────────────────
//
// 规则：**逐文件、逐条理由**，禁止宽泛 glob（`src/**/*.js` 这种会让真违例混过去）。
// 判据是「没有 import 方但不需要 import 方」——入口、被 spawn 的进程、浏览器直接加载的资源、
// 只在测试侧使用的夹具。凡不能归入这四类，就该接线或删除（见 issue 002）。

export const ENTRY_ALLOWLIST = [
  { file: 'src/awf.js', reason: 'CLI 入口：package.json bin / `awf` 命令直接执行，没有 import 方' },
  { file: 'src/server/server.cjs', reason: '常驻 server 进程：由 cli/run.js ensureServer 与 awf server start 以 spawn 拉起，不经 import' },
  { file: 'src/adapters/mock.cjs', reason: '测试夹具：只被 tests/ 引入，生产路径不应引用它' },
];

/**
 * ESM 消费壳：`X.js` 与 `X.cjs` 同名共存时，`.js` 是给 ESM 侧的再导出壳，
 * 真实实现在 `.cjs`（本仓库 CJS 为核心、ESM 为消费面的既定形态）。
 * 这是**精确谓词**（同名兄弟文件必须真实存在），不是 glob。
 */
function isEsmShell(rel, exists) {
  if (!rel.endsWith('.js') || rel.endsWith('.cjs')) return false;
  return exists(rel.replace(/\.js$/, '.cjs'));
}

// ── 豁免表：每条必须带 reason + responsible（责任 task id）──────────────────
//
// 「待办」从此不是注释，而是**会让门禁变红的数据**：`--strict` 要求本表为空，
// 这就是 T1-115 / T1-117 的验收口径（docs/discuss/planned-architecture-landing.md §5.4）——
// 故本表**只登记这两个任务负责的项**（T1-115：零引用幸存者；T1-117：生产消费者改走边界）。
// 表清空 = 这两条做完，`--strict` 通过。后续再有暂缓项，同样必须写明责任 task id。

export const EXEMPTIONS = {
  // ── 零生产引用（剥离注释后首次暴露；`03` 修复的连带面，见 .awf/issues/003）──
  //
  // 口径来自 `.awf/decisions/runs/0.2.0-2026-09-10T14-21-09.jsonl` 的 Decision Result：
  // 「保留模块 + 进 EXEMPTIONS」而非删除 —— 删除判据（T1-115：生产侧零引用 **且** 能力已在
  // live 路径别处实现）对它不成立：交互式版本选择器在别处**没有**实现，两处调用点是人的**有意**
  // 关闭（"版本处理暂时禁用"）。
  'src/lib/version.js': {
    reason: '交互式版本选择器已实现但接线被有意关闭：init.js:5 与 plan.js:2 的 import/调用点均注释为'
      + '「版本处理暂时禁用」——根因是交互式 prompt 会挂住以 `stdio: pipe` 执行的自动化入口'
      + '（回归 harness 的 `awf init`、init.test.js）。能力**不在**别处：版本号改由 package.json /'
      + ' state.json 承载 ≠ 这个选择器被取代，故按「保留 + 登记」处置，不删除模块。'
      + '本豁免**不会自动失效**：撤销时机 = 产品决定给出非交互入口（如 --version）或正式废弃该功能；'
      + '下一次必然复核它的地方是发布门禁 T4-001 的文档核对（docs/features/version-prompt.md 的「当前状态」段）',
    responsible: 'T4-001',
  },
  // ── 依赖方向越界（既存结构债，见 .awf/reports/architecture-discipline-audit.md F3/F4/F6）
  // 本表不写它们，「在当前树通过」就做不到：门禁第一天全红、npm run build 当场坏。
  // 约束是「不得为了变绿放宽规则」——所以不扩 ALLOWED，而是如实记债 + 指责任任务。
  //
  // 已清（留个记号，别再往回走）：
  //   - `src/adapters/ports.cjs` 零生产引用 → T1-117 让 cli/server 改走端口契约后消失
  //   - `lib → adapters`（F2b, run-diagnosis 直连 oneshot）→ T1-117 改成「端口由装配根注入」后消失
  'cli → server': {
    reason: 'F4：run.js 直接 import server/run-settings.cjs，同时绕过 client 边界与 cc 端口边界。'
      + '清它要把 run-settings（cc 格式产物）挪进 adapters 或经客户端取用——属 cc 收口的结构改动',
    responsible: 'T1-113',
  },
  'adapters → server': {
    reason: 'F3：ports.cjs 反向 require server/host.cjs、hook-adapter.cjs —— 端口契约层依赖控制平面实现。'
      + '清它要把 host/hook 的实现从 server/ 挪进 adapters/（W3-004「cc 一切收口到 adapters」的未尽事项）',
    responsible: 'T1-113',
  },
  'plugin-mcp → lib': {
    reason: 'F6：awf-state 以计算路径 try/catch 回取 src/lib/store-core.cjs（纯插件副本无 src/ 时的降级路径）。'
      + '按薄代理纪律它该只经 HTTP 到 server，不应直取 src。'
      + '清它先要给「纯插件副本怎么办」一个结论——属插件边界裁决',
    responsible: 'T1-113',
  },
  'plugin-mcp → adapters': {
    reason: 'F6：awf-oneshot 同形回取 src/adapters/oneshot.cjs；与上一条同属插件边界裁决'
      + '（纯插件副本无 src/ 时的降级路径要不要保留）',
    responsible: 'T1-113',
  },
};

// ── 可配置结构断言：后续任务往这里追加 ──────────────────────────────────────
//
// kind: 'maxLines'    { file, max }
// kind: 'forbidFiles' { dir, extensions: ['.html', ...] }
//
export const STRUCTURE_RULES = [
  {
    id: 'server-single-file-size',
    kind: 'maxLines',
    file: 'src/server/server.cjs',
    max: 1600,
    reason: 'server.cjs 是待拆的单体（W3-003 目标：拆为 bootstrap/api/events/config/host，A 轴由 T1-113 承接）；'
      + '上限只拦住它在拆分前继续膨胀',
  },
  {
    id: 'server-no-static-assets',
    kind: 'forbidFiles',
    dir: 'src/server',
    extensions: ['.html', '.css'],
    reason: '静态资源（页面/主题）只由 web/ 构建产物承载（src/server/public，T1-118 接的构建链路）；'
      + 'src/server/ 只放服务端代码 —— 这条拦住「又往 src/server 里塞页面」的回退（T1-119）',
  },
];

// ── 豁免表责任任务的可达性（T3-009-F2 / 门禁 N-6）────────────────────────────
//
// 第 1 轮门禁分出「抽象已建」与「已被采用」；本轮分出「有责任人」与「责任人**走得到**」。
// 背景：4 条豁免的 responsible 全指 T1-113，而 T1-113 排在**被用户明示暂缓**的 T1-106 之后——
// 登记表字段齐备（reason + responsible 都有），但那份责任在图上不可达，等于没有。
//
// 判据直接取自 `src/lib/state.js:depsDone`：依赖必须 **done** 才算满足。
// 所以只要依赖闭包里有一个 `blocked`，该任务就**永远不可就绪** —— 责任落空。
//
// 能力边界（写清楚，免得它被当成万能判据）：
//   它判得出的：责任任务悬空 / 责任任务自身 blocked / 依赖闭包内有 blocked（不可达）。
//   它判不出的：**非实质依赖**（「T1-113 用不着等 T1-106」是语义判断，机器无从得知）。
//   故本函数是必要条件，不是充分条件；非实质依赖仍靠人审。

/**
 * @param {Record<string, {reason?: string, responsible?: string}>} exemptions
 * @param {Array<{id: string, status?: string, deps?: string[]}>} tasks
 * @returns {Array<{key: string, responsible: string, why: string}>} 不可达的责任项（空数组 = 全部可达）
 */
export function unreachableResponsibles(exemptions, tasks = []) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];

  /** 深度优先收集依赖闭包里的 blocked 任务（含环保护） */
  const blockedAncestors = (task) => {
    const seen = new Set();
    const hit = [];
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const t = byId.get(id);
      if (!t) return;
      for (const dep of t.deps || []) {
        const d = byId.get(dep);
        if (!d) continue;
        if (d.status === 'blocked') hit.push(d.id);
        walk(dep);
      }
    };
    walk(task.id);
    return hit;
  };

  for (const [key, ex] of Object.entries(exemptions)) {
    const responsible = ex.responsible;
    if (!responsible) {
      out.push({ key, responsible: '(缺 responsible)', why: '豁免条目缺 responsible（没写责任 task id）' });
      continue;
    }
    const task = byId.get(responsible);
    if (!task) {
      out.push({ key, responsible, why: '责任任务不在任务图里（悬空的责任等于没有）' });
      continue;
    }
    if (task.status === 'blocked') {
      out.push({ key, responsible, why: `责任任务自身 blocked（${task.status}）` });
      continue;
    }
    const blocked = blockedAncestors(task);
    if (blocked.length) {
      out.push({
        key,
        responsible,
        why: `依赖闭包内含 blocked 任务 ${blocked.join('、')} —— depsDone 要求 done，故该责任任务永不可就绪`,
      });
    }
  }
  return out;
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

const CODE = /\.(?:c|m)?jsx?$|\.tsx?$|\.vue$/;
const SRC_CODE = /\.(?:c|m)?js$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'sandbox', 'coverage']);

/**
 * 按**路径**跳过的生成物目录（不是源码，不该按源码规则判）。
 * `src/server/public` 是 web/ 的构建产物（T1-118）：文件名带内容哈希、由浏览器加载而非 import，
 * 落进 src/ 只是为了 server 静态托管。把它算作「零生产引用模块」是误报 ——
 * 而且哈希名每构建一次就变，不可能进白名单。
 */
const SKIP_PATHS = new Set(['src/server/public', 'src/server/public/assets']);

/** 生产侧引用者目录：这些地方的 import 才算「被生产引用」；tests/ 不算 */
const PROD_DIRS = ['src', 'scripts', 'plugin', 'web/src'];

const REL_IMPORT = /(?:require\(\s*|from\s+|import\(\s*)["'](\.[^"']+)["']/g;
// 首个参数是 __dirname 的 join 调用（本仓库写作 path.join；放宽到任意 <obj>.join，避免别名写法漏扫）
const COMPUTED_REQUIRE = /require\(\s*[\w$]+\.join\(\s*__dirname\s*,([^)]*)\)\s*\)/g;

/**
 * 剥掉注释再扫 import（`.awf/issues/003`）。
 *
 * 为什么必须剥：`REL_IMPORT` 是**纯文本**扫描，注释里的 `from '../lib/version.js'` 同样命中 ——
 * 于是把一个「调用点被注释掉」的模块记成「已被引用」，不变量①（零生产引用）当场失效。
 * 而「抽象建了没人用」正是它唯一想机器兜住的东西（`.awf/issues/002`）。实测：`src/lib/version.js`
 * 的两处调用点都被注释，修复前门禁报「① 零生产引用模块：无」。
 *
 * 两条规则，各有取舍：
 *   1. 块注释 → **等量空白（保留换行）**：行号类断言不会因为剥离而错位；
 *   2. 行注释 → 只剥**整行以 // 开头**的，不截断行尾注释 —— 字符串字面量里的 `//`（如 URL）
 *      会被行尾截断误伤，而本仓库暂无「行尾注释里写 import」的形态，整行规则已足够。
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function collect(dir, filter, out = [], root = dir) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const relDir = path.relative(root, p).split(path.sep).join('/');
      if (!SKIP_DIRS.has(e.name) && !SKIP_PATHS.has(relDir)) collect(p, filter, out, root);
    } else if (filter.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function resolveImport(fromFile, spec) {
  const base = path.join(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.cjs`, `${base}.js`, `${base}.mjs`, `${base}.jsx`,
    path.join(base, 'index.js'), path.join(base, 'index.cjs')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * 计算路径依赖：`require(path.join(__dirname, '..', …))`。
 * 字面扫描看不见它，但它同样是真实依赖边 —— 本仓库的插件 MCP 正是用它回取 src/。
 */
function resolveComputed(fromFile, argList) {
  const segs = [...argList.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (!segs.length) return null;
  const base = path.join(path.dirname(fromFile), ...segs);
  for (const c of [base, `${base}.cjs`, `${base}.js`, `${base}.mjs`,
    path.join(base, 'index.js'), path.join(base, 'index.cjs')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** 一个文件引用的全部本地文件（字面 + 计算路径；**注释里的不算**，见 stripComments） */
function importedBy(file) {
  const out = [];
  const reads = (cb) => {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { return; }
    cb(stripComments(src));
  };
  reads((src) => {
    REL_IMPORT.lastIndex = 0;
    let m;
    while ((m = REL_IMPORT.exec(src))) {
      const hit = resolveImport(file, m[1]);
      if (hit) out.push(hit);
    }
    COMPUTED_REQUIRE.lastIndex = 0;
    while ((m = COMPUTED_REQUIRE.exec(src))) {
      const hit = resolveComputed(file, m[1]);
      if (hit) out.push(hit);
    }
  });
  return out;
}

const layerOf = (rel) => LAYER_RULES.find(([re]) => re.test(rel))?.[1] ?? null;

// ── 三条不变量 ──────────────────────────────────────────────────────────────

/**
 * @param {{ root?: string, allowlist?: object[], exemptions?: object, structureRules?: object[], strict?: boolean }} [opts]
 * @returns {{ root, scanned, findings, blocked, edges, exemptions, strictBlocked, allowlisted }}
 *   `--strict` 的判据在这里（而非 main），单测可直接断言：豁免表非空即 strictBlocked。
 */
export function runCheck({ root = process.cwd(), allowlist = ENTRY_ALLOWLIST, exemptions = EXEMPTIONS, structureRules = STRUCTURE_RULES, strict = false } = {}) {
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const srcFiles = collect(path.join(root, 'src'), SRC_CODE, [], root).map((f) => path.relative(root, f));
  const prodFiles = PROD_DIRS.flatMap((d) => collect(path.join(root, d), CODE, [], root));

  // 全部被 import 到的目标（绝对路径）
  const referenced = new Set();
  const edges = new Map(); // "A → B" → Set<"file ⇒ file">
  for (const f of prodFiles) {
    const rel = path.relative(root, f);
    const from = layerOf(rel);
    for (const hit of importedBy(f)) {
      referenced.add(hit);
      const relHit = path.relative(root, hit);
      const to = layerOf(relHit);
      if (!from || !to || from === to) continue;
      const key = `${from} → ${to}`;
      if (!edges.has(key)) edges.set(key, new Set());
      edges.get(key).add(`${rel} ⇒ ${relHit}`);
    }
  }

  const findings = [];

  // 1) 零生产引用
  const allow = new Map(allowlist.map((e) => [e.file, e.reason]));
  for (const rel of srcFiles.sort()) {
    if (referenced.has(path.join(root, rel))) continue;
    if (allow.has(rel)) continue;
    if (isEsmShell(rel, exists)) continue;
    findings.push({
      check: 'zero-ref',
      key: rel,
      path: rel,
      detail: '生产侧（src/ scripts/ plugin/ web/src）零引用；只有测试 import 不算被采用',
    });
  }

  // 2) 依赖方向越界
  for (const key of edges.keys()) {
    if (ALLOWED.has(key)) continue;
    findings.push({
      check: 'dep-direction',
      key,
      path: [...edges.get(key)][0].split(' ⇒ ')[0],
      detail: `越出声明方向：${[...edges.get(key)].join('；')}`,
    });
  }

  // 3) 结构断言
  for (const rule of structureRules) {
    if (rule.kind === 'maxLines') {
      const abs = path.join(root, rule.file);
      if (!fs.existsSync(abs)) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
      if (lines > rule.max) {
        findings.push({
          check: 'structure',
          key: rule.id,
          path: rule.file,
          detail: `行数 ${lines} 超过上限 ${rule.max}（${rule.reason}）`,
        });
      }
    } else if (rule.kind === 'forbidFiles') {
      const dir = path.join(root, rule.dir);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!rule.extensions.some((ext) => name.endsWith(ext))) continue;
        findings.push({
          check: 'structure',
          key: rule.id,
          path: `${rule.dir}/${name}`,
          detail: `该目录不得出现 ${rule.extensions.join('/')}（${rule.reason}）`,
        });
      }
    } else {
      throw new Error(`check-architecture: 未知结构断言 kind='${rule.kind}'（id=${rule.id}）`);
    }
  }

  // 豁免：找到匹配就标记，并在结果里列出（默认不拦，--strict 才要求表为空）
  const usedExemptions = [];
  for (const f of findings) {
    const ex = exemptions[f.key];
    if (!ex) continue;
    f.exempt = ex;
    usedExemptions.push({ key: f.key, check: f.check, ...ex });
  }

  // --strict：豁免表必须为空（每一条都会变成 blocker，指名道姓「谁的活没干完」）
  const strictBlocked = strict
    ? Object.entries(exemptions).map(([key, ex]) => ({ key, ...ex }))
    : [];

  return {
    root,
    scanned: prodFiles.length,
    findings,
    blocked: findings.filter((f) => !f.exempt),
    strictBlocked,
    edges: [...edges.keys()].sort().map((k) => ({ edge: k, allowed: ALLOWED.has(k), sites: [...edges.get(k)].sort() })),
    exemptions: usedExemptions,
    allowlisted: [...allow.keys()],
  };
}

// ── 命令行 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { json: false, strict: false, warnOnly: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--warn-only') out.warnOnly = true;
    else if (a === '--root') out.root = argv[++i];
    else throw new Error(`未知参数 ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || path.resolve(import.meta.dirname, '..'));
  const r = runCheck({ root, strict: args.strict });
  const strictViolations = r.strictBlocked;

  if (args.json) {
    console.log(JSON.stringify({
      root: r.root, scanned: r.scanned,
      findings: r.findings, blocked: r.blocked,
      exemptions: r.exemptions, allowlisted: r.allowlisted,
      edges: r.edges,
      strictBlocked: strictViolations,
    }, null, 2));
    process.exit(args.warnOnly ? 0 : (r.blocked.length || strictViolations.length) ? 1 : 0);
  }

  const byCheck = (name) => r.findings.filter((f) => f.check === name);
  const exByCheck = (c) => r.exemptions.filter((e) => e.check === c).length;
  console.log(`扫描 ${r.scanned} 个生产文件；白名单 ${r.allowlisted.length} 条；`
    + `豁免 ${Object.keys(EXEMPTIONS).length} 条（零生产引用 ${exByCheck('zero-ref')}、依赖方向 ${exByCheck('dep-direction')}）\n`);

  for (const [name, title] of [
    ['zero-ref', '① 零生产引用模块'],
    ['dep-direction', '② 依赖方向越界'],
    ['structure', '③ 结构断言'],
  ]) {
    const list = byCheck(name);
    console.log(`── ${title}：${list.length === 0 ? '无' : `${list.length} 项`}`);
    for (const f of list) {
      const tag = f.exempt ? `豁免（${f.exempt.responsible}）` : '违例';
      console.log(`   ${f.exempt ? '⚪' : '❌'} [${tag}] ${f.path}`);
      console.log(`      ${f.detail}`);
      if (f.exempt) console.log(`      豁免理由：${f.exempt.reason}`);
    }
  }

  if (r.allowlisted.length) {
    console.log('\n── 白名单（零生产引用但合理）');
    for (const f of r.allowlisted) console.log(`   ✔ ${f}`);
  }

  console.log(`\n边：声明方向内 ${r.edges.filter((e) => e.allowed).length} 条，越界 ${r.edges.filter((e) => !e.allowed).length} 条`);

  if (r.exemptions.length) {
    console.log('\n── 豁免生效（这些「待办」会让门禁变红，`--strict` 下必须清零）');
    for (const e of r.exemptions) console.log(`   ⚪ ${e.key} → ${e.responsible}：${e.reason}`);
  }
  if (strictViolations.length) {
    console.log('\n── --strict：豁免表必须为空');
    for (const e of strictViolations) console.log(`   ❌ ${e.key} → ${e.responsible}：${e.reason}`);
  }

  const failed = r.blocked.length + strictViolations.length;
  if (args.warnOnly) {
    console.log(`\n[--warn-only] 仅取证：${r.blocked.length} 条未豁免违例、${strictViolations.length} 条 strict 阻断，退出码仍为 0`);
    return 0;
  }
  if (failed) {
    console.log(`\n结构门禁未通过：${r.blocked.length} 条未豁免违例`
      + `${strictViolations.length ? `，--strict 阻断 ${strictViolations.length} 条豁免` : ''}`);
    console.log('处置：接线或删除；确需暂缓的，进 EXEMPTIONS 并写清 reason + responsible（责任 task id）。');
    return 1;
  }
  console.log('\n结构门禁通过。');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`check-architecture: ${e.message}`);
    process.exit(2);
  }
}
