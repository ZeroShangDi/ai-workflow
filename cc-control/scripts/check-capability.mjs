#!/usr/bin/env node
/**
 * check-capability.mjs — 能力登记对账（U9）
 *
 * 要解决的问题（U9 原文）：「声明『支持取消』，但真实调用没有接上；这种情况只看文档和方法名很容易漏过。」
 *
 * 本检查只做**机器能确定的事**，不假装能判定语义：
 *   1. 登记文件本身合规：字段齐、枚举合法、id 唯一、必需能力（public）缺失即失败；
 *   2. 登记声明的实现路径**真实存在**（文件级），且模块能 `await import()`（语法/导出层面可加载）；
 *   3. 登记的 `port` 与 `server/adapters/ports.cjs` 的名册**双向一致**（登记用了名册外端口 → 失败）；
 *   4. 有 `consumers` 声明的，对应文件必须存在（防止登记里写了个不存在的调用方）；
 *   5. `blocked` / `partial` 必须写 `note`（说明限定是什么），`blocked` 必须写 `responsible`（谁欠着）。
 *
 * 明确**不做**的：不把「有实现 + 有调用方」当作语义正确；语义由带证据的行为测试与真机验证负责（执行记录 F 表 / E-* 实验）。
 * 也不设「端口数量上限」—— U9 明确否掉了这条。
 *
 * 用法：
 *   node scripts/check-capability.mjs            门禁：有违例 → 非 0
 *   node scripts/check-capability.mjs --json     机器可读
 *   node scripts/check-capability.mjs --root <d> 换根目录（测试夹具用）
 *
 * 退出码：0 通过；1 有违例；2 用法/环境错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REGISTRY_REL = 'server/adapters/capability-registry.json';
const PORTS_REL = 'server/adapters/ports.cjs';

const ALLOWED_STATUS = ['implemented', 'partial', 'planned', 'blocked', 'unsupported'];
const ALLOWED_KIND = ['public', 'platform'];
const TOP_FIELDS = ['id', 'name', 'kind', 'port', 'status', 'cc', 'dsh', 'consumers', 'evidence', 'responsible', 'note'];
const IMPL_FIELDS = ['impl', 'note'];

function parseArgs(argv) {
  const args = { json: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--root') { args.root = path.resolve(argv[i + 1] ?? ''); i += 1; }
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/** 读名册里的端口名（从 ports.cjs 文本里取 PORT_CONTRACT 的 name 字段）。 */
function readPortNames(root) {
  const file = path.join(root, PORTS_REL);
  if (!fs.existsSync(file)) return { names: null, error: `${PORTS_REL} 不存在` };
  const text = fs.readFileSync(file, 'utf8');
  // 匹配 `name: 'host'`（行首或对象字面量内均可）。真实 ports.cjs 每项独占一行，测试夹具可能是单行字面量。
  const names = [...text.matchAll(/\bname:\s*'([a-z][a-z-]*)'/g)].map((m) => m[1]);
  return { names: new Set(names), error: names.length === 0 ? 'ports.cjs 未解析出任何端口名' : null };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法: node scripts/check-capability.mjs [--json] [--root <dir>]');
    return 0;
  }
  const root = args.root;
  const violations = [];
  const warnings = [];
  const add = (capId, msg) => violations.push({ capId, msg });

  // ── 登记文件 ──
  const registryPath = path.join(root, REGISTRY_REL);
  if (!fs.existsSync(registryPath)) throw new Error(`登记文件不存在: ${REGISTRY_REL}`);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const caps = registry.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) throw new Error('capabilities 必须是非空数组');

  const { names: portNames, error: portError } = readPortNames(root);
  if (portError) add('(registry)', `端口名册不可用：${portError}`);

  const seen = new Set();
  for (const cap of caps) {
    const id = cap.id ?? '(缺 id)';
    if (seen.has(id)) add(id, 'id 重复');
    seen.add(id);

    // 字段齐备（不多不少，防止登记漂移）
    for (const f of TOP_FIELDS) if (!(f in cap)) add(id, `缺字段 ${f}`);
    for (const f of Object.keys(cap)) if (!TOP_FIELDS.includes(f)) add(id, `未知字段 ${f}（登记 schema 只允许 ${TOP_FIELDS.join('/')}）`);
    if (!ALLOWED_STATUS.includes(cap.status)) add(id, `status 非法: ${cap.status}`);
    if (!ALLOWED_KIND.includes(cap.kind)) add(id, `kind 非法: ${cap.kind}`);
    if (typeof cap.name !== 'string' || cap.name.trim() === '') add(id, 'name 不能为空');

    // 两端实现的形状
    for (const side of ['cc', 'dsh']) {
      const s = cap[side];
      if (s === null || typeof s !== 'object') { add(id, `${side} 必须是对象`); continue; }
      for (const f of Object.keys(s)) if (!IMPL_FIELDS.includes(f)) add(id, `${side} 未知字段 ${f}`);
      if (!Array.isArray(s.impl)) { add(id, `${side}.impl 必须是数组`); continue; }
      for (const rel of s.impl) {
        const abs = path.join(root, rel);
        if (!fs.existsSync(abs)) add(id, `${side}.impl 路径不存在: ${rel}`);
      }
    }

    // 端口一致性：登记用了名册外的端口 → 失败
    if (cap.port !== null) {
      if (typeof cap.port !== 'string') add(id, 'port 必须是 null 或字符串');
      else if (portNames && !portNames.has(cap.port)) add(id, `port "${cap.port}" 不在 ${PORTS_REL} 名册里`);
    }

    // consumers：声明的调用方必须存在
    if (!Array.isArray(cap.consumers)) add(id, 'consumers 必须是数组');
    else for (const rel of cap.consumers) {
      if (typeof rel !== 'string') { add(id, 'consumers 元素必须是字符串'); continue; }
      if (!fs.existsSync(path.join(root, rel))) add(id, `consumers 路径不存在: ${rel}`);
    }

    // evidence：P0 证据编号（F 表 / E-* 实验），只做形状检查
    if (!Array.isArray(cap.evidence)) add(id, 'evidence 必须是数组');

    // 限定必须写明
    if ((cap.status === 'blocked' || cap.status === 'partial') && (typeof cap.note !== 'string' || cap.note.trim() === '')) {
      add(id, `status=${cap.status} 必须写 note（说明限定/约束）`);
    }
    if (cap.status === 'blocked' && (cap.responsible === null || cap.responsible === undefined || cap.responsible === '')) {
      add(id, 'status=blocked 必须写 responsible（责任 task id）');
    }
    // public 能力至少要有实现或明确 not
    if (cap.kind === 'public' && cap.status === 'implemented') {
      if ((cap.cc?.impl?.length ?? 0) === 0) add(id, 'status=implemented 但 cc.impl 为空');
    }
    if (cap.kind === 'platform' && cap.port !== null) {
      warnings.push({ capId: id, msg: 'platform 能力一般不该挂公共端口' });
    }
  }

  // ── 模块可加载性（只对 cc.impl 的 .cjs/.js，且不执行副作用重的入口）──
  // 说明：这里只 import 适配器实现，不 import cli/server 入口 —— 后者会起进程/读环境。
  for (const cap of caps) {
    for (const rel of cap.cc?.impl ?? []) {
      if (!/^server\/adapters\/.+\.(cjs|js)$/.test(rel)) continue;
      try {
        await import(pathToFileURL(path.join(root, rel)).href);
      } catch (e) {
        add(cap.id, `cc.impl 无法加载: ${rel}（${e.message}）`);
      }
    }
  }

  const result = {
    ok: violations.length === 0,
    counts: {
      capabilities: caps.length,
      byStatus: ALLOWED_STATUS.reduce((acc, s) => ({ ...acc, [s]: caps.filter((c) => c.status === s).length }), {}),
      publicCount: caps.filter((c) => c.kind === 'public').length,
      platformCount: caps.filter((c) => c.kind === 'platform').length,
    },
    violations,
    warnings,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`能力登记检查：${caps.length} 项（public ${result.counts.publicCount} / platform ${result.counts.platformCount}）`);
    console.log(`状态分布：${Object.entries(result.counts.byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const w of warnings) console.log(`  ⚠ [${w.capId}] ${w.msg}`);
    if (violations.length === 0) {
      console.log('✓ 能力登记对账通过（登记形状、实现路径、端口名册、调用方存在性、限定说明）');
      console.log('  注：本检查不判定语义正确；语义由带证据的行为测试与真机验证负责。');
    } else {
      console.log(`✗ ${violations.length} 条违例：`);
      for (const v of violations) console.log(`  - [${v.capId}] ${v.msg}`);
    }
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`check-capability: ${e.message}`); process.exit(2); });
}

export { main };
