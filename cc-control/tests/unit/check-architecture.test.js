import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runCheck, ALLOWED, ENTRY_ALLOWLIST, EXEMPTIONS, STRUCTURE_RULES, unreachableResponsibles, stripComments,
} from '../../scripts/check-architecture.mjs';

/**
 * 结构门禁（T1-114）。它拦住的是 `.awf/issues/002` 那一类：
 * 「抽象建了没人用、单测全绿、live 一行没变」——所以判据必须是**引用关系**，不是文件存在。
 */

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'scripts', 'check-architecture.mjs');

/** 造一棵最小树：{ '相对路径': '文件内容' } */
function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-arch-'));
  for (const [rel, content] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/**
 * 夹具基线：任何一棵树都要有入口 → cli 这条链，否则 cli 文件自己就是「零引用」，
 * 断言会被夹具自身的不完整带偏（真实仓库里 awf.js 是入口，walkir 白名单放行）。
 */
const BASE = { 'src/awf.js': "require('./cli/a.js');\n", 'src/cli/a.js': 'module.exports = 1;\n' };
const BASE_ALLOW = [{ file: 'src/awf.js', reason: '入口（夹具）' }];

const trees = [];
const tree = (extra) => { const t = makeTree({ ...BASE, ...extra }); trees.push(t); return t; };
afterEach(() => { while (trees.length) fs.rmSync(trees.pop(), { recursive: true, force: true }); });

/** 只取某类 finding 的 key/path */
const keysOf = (r, check) => r.findings.filter((f) => f.check === check).map((f) => f.key);

describe('不变量① 零生产引用模块', () => {
  it('生产侧零引用 → 检出，并指出文件路径', () => {
    const root = tree({
      'src/lib/used.cjs': 'module.exports = 1;\n',
      'src/lib/dead.cjs': 'module.exports = 2;\n',
      'src/cli/a.js': "require('../lib/used.cjs');\n",
    });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} });
    expect(keysOf(r, 'zero-ref')).toEqual(['src/lib/dead.cjs']);
    expect(r.findings.find((f) => f.key === 'src/lib/dead.cjs').path).toBe('src/lib/dead.cjs');
    expect(r.blocked).toHaveLength(1);
  });

  it('只被 tests/ 引用不算「被采用」——仍报', () => {
    const root = tree({
      'src/lib/dead.cjs': 'module.exports = 2;\n',
      'tests/unit/x.test.js': "require('../../src/lib/dead.cjs');\n",
    });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} });
    expect(keysOf(r, 'zero-ref')).toEqual(['src/lib/dead.cjs']);
  });

  it('被 plugin/ 生产侧引用也算被采用', () => {
    const root = tree({
      'src/lib/used.cjs': 'module.exports = 1;\n',
      'plugin/core/mcp/x/server.cjs': "require('../../../../src/lib/used.cjs');\n",
    });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} });
    expect(keysOf(r, 'zero-ref')).toEqual([]);
  });

  it('计算路径 require 也算引用（字面扫描看不见它）', () => {
    const root = tree({
      'src/lib/store-core.cjs': 'module.exports = 1;\n',
      'plugin/core/mcp/x/server.cjs': "const p = require('node:path');\n"
        + "require(p.join(__dirname, '..', '..', '..', '..', 'src', 'lib', 'store-core.cjs'));\n",
    });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} });
    expect(keysOf(r, 'zero-ref')).toEqual([]);
  });

  it('白名单逐文件放行（不靠 glob）', () => {
    const root = tree({}); // 只用 BASE：awf.js → cli/a.js，故只有 awf.js 零引用
    expect(runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} }).blocked).toEqual([]);
    expect(keysOf(runCheck({ root, allowlist: [], exemptions: {} }), 'zero-ref')).toEqual(['src/awf.js']);
  });

  it('ESM 消费壳（同名 .cjs 存在）放行', () => {
    const root = tree({
      'src/lib/foo.cjs': 'module.exports = 1;\n',      // 真实实现（被引用）
      'src/lib/foo.js': "export { x } from './foo.cjs';\n", // 同名 ESM 壳（自身零引用）
      'src/cli/a.js': "require('../lib/foo.cjs');\n",
    });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} });
    expect(keysOf(r, 'zero-ref')).toEqual([]);
  });

  it('没有同名 .cjs 的 .js 不放行（谓词是精确的，不是「只要是 .js 就放」）', () => {
    const root = tree({ 'src/lib/plain.js': 'export const x = 1;\n' });
    expect(keysOf(runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} }), 'zero-ref')).toEqual(['src/lib/plain.js']);
  });
});

/**
 * `.awf/issues/003`：`REL_IMPORT` 曾是纯文本扫描，**注释里的 import 被当成真引用** ——
 * 于是「调用点被注释掉」的模块被判「已被引用」，不变量①存在的唯一理由（拦住「抽象建了没人用」）
 * 当场失效。实测被漏检的真身是 `src/lib/version.js`。以下四条把「剥注释」的正反两面都钉住。
 */
describe('不变量① 注释里的 import 不算引用（issue 003）', () => {
  it('整行 // 注释里的 import → 判零引用', () => {
    const root = tree({
      'src/lib/version.js': 'export const x = 1;\n',
      'src/cli/a.js': "// import { x } from '../lib/version.js'; // 暂时禁用\n",
    });
    expect(keysOf(runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} }), 'zero-ref'))
      .toEqual(['src/lib/version.js']);
  });

  it('块注释里的 import → 判零引用', () => {
    const root = tree({
      'src/lib/legacy.js': 'module.exports = 1;\n',
      'src/cli/a.js': "/*\n * require('../lib/legacy.js'); ← 已下线\n */\nmodule.exports = 1;\n",
    });
    expect(keysOf(runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} }), 'zero-ref'))
      .toEqual(['src/lib/legacy.js']);
  });

  it('真 import 与注释里的 import 并存 → 不算零引用（剥离不误伤真代码）', () => {
    const root = tree({
      'src/lib/used.cjs': 'module.exports = 1;\n',
      'src/cli/a.js': "require('../lib/used.cjs');\n// require('../lib/used.cjs');\n",
    });
    expect(keysOf(runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} }), 'zero-ref')).toEqual([]);
  });

  it('已知残留：**行尾**注释里的 import 仍被计为引用（只剥整行，避免误伤字符串里的 //）', () => {
    const root = tree({
      'src/lib/tail.js': 'module.exports = 1;\n',
      'src/cli/a.js': "const a = 1; // require('../lib/tail.js')\n",
    });
    expect(keysOf(runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} }), 'zero-ref')).toEqual([]);
  });

  it('stripComments 保留换行数（行号不因剥离而错位）', () => {
    const src = 'a\n/* x\ny */\nb\n';
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
    expect(stripComments(src)).not.toContain('x');
  });
});

describe('不变量② 依赖方向', () => {
  it('越出 ALLOWED → 检出（key 为层边）', () => {
    const root = tree({
      'src/lib/a.cjs': "require('../server/b.cjs');\n",
      'src/server/b.cjs': 'module.exports = 1;\n',
    });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} });
    expect(keysOf(r, 'dep-direction')).toEqual(['lib → server']);
    expect(r.findings.find((f) => f.check === 'dep-direction').detail).toContain('a.cjs');
  });

  it('声明方向内不报', () => {
    const root = tree({
      'src/cli/a.js': "require('../lib/b.cjs');\n",
      'src/lib/b.cjs': 'module.exports = 1;\n',
    });
    expect(keysOf(runCheck({ root, allowlist: BASE_ALLOW, exemptions: {} }), 'dep-direction')).toEqual([]);
  });

  it('ALLOWED 未被为过门禁而放宽（守住 T1-114 的硬约束）', () => {
    expect([...ALLOWED].sort()).toEqual([
      'cli → adapters', 'cli → lib', 'entry → cli',
      'scripts → lib', 'scripts → server', 'server → adapters', 'server → lib',
    ]);
  });
});

describe('不变量③ 可配置结构断言', () => {
  const rule = (r) => [r];

  it('maxLines 超限 → 检出（后续任务直接加一条规则即可）', () => {
    const root = tree({ 'src/lib/big.cjs': 'x\n'.repeat(20) });
    const rules = rule({ id: 'big', kind: 'maxLines', file: 'src/lib/big.cjs', max: 10, reason: '测试上限' });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {}, structureRules: rules });
    expect(keysOf(r, 'structure')).toEqual(['big']);
    expect(r.findings.find((f) => f.check === 'structure').detail).toMatch(/行数 2\d 超过上限 10/);
  });

  it('maxLines 未超 → 不报', () => {
    const root = tree({ 'src/lib/small.cjs': 'x\n' });
    const rules = rule({ id: 'small', kind: 'maxLines', file: 'src/lib/small.cjs', max: 10, reason: '测试上限' });
    expect(keysOf(runCheck({ root, allowlist: [], exemptions: {}, structureRules: rules }), 'structure')).toEqual([]);
  });

  it('forbidFiles 命中 → 检出（备给「src/server 不得放 htm l/css」这类目标结构）', () => {
    const root = tree({
      'src/server/legacy.html': '<html></html>',
      'src/server/ok.cjs': 'module.exports = 1;\n',
    });
    const rules = rule({ id: 'no-html', kind: 'forbidFiles', dir: 'src/server', extensions: ['.html', '.css'], reason: '静态资源归 web/' });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {}, structureRules: rules });
    expect(keysOf(r, 'structure')).toEqual(['no-html']);
    expect(r.findings.find((f) => f.check === 'structure').path).toBe('src/server/legacy.html');
  });

  it('未知 kind → 显式抛错（不静默跳过规则）', () => {
    const root = tree({ 'src/lib/a.cjs': 'module.exports = 1;\n' });
    expect(() => runCheck({ root, allowlist: [], exemptions: {}, structureRules: [{ id: 'x', kind: 'nope' }] }))
      .toThrow(/未知结构断言/);
  });
});

describe('豁免表与 --strict', () => {
  it('豁免生效：finding 被标记，且不进 blocked', () => {
    const root = tree({ 'src/lib/dead.cjs': 'module.exports = 1;\n' });
    const exemptions = { 'src/lib/dead.cjs': { reason: '待接线', responsible: 'T1-115' } };
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions });
    expect(r.blocked).toEqual([]);
    expect(r.exemptions).toEqual([{ key: 'src/lib/dead.cjs', check: 'zero-ref', reason: '待接线', responsible: 'T1-115' }]);
  });

  it('默认只报不拦（豁免不进 blocker）；--strict 下豁免表非空即失败', () => {
    const root = tree({ 'src/lib/dead.cjs': 'module.exports = 1;\n' });
    const exemptions = { 'src/lib/dead.cjs': { reason: 'r', responsible: 'T1-115' } };
    expect(runCheck({ root, allowlist: BASE_ALLOW, exemptions }).strictBlocked).toEqual([]);
    expect(runCheck({ root, allowlist: BASE_ALLOW, exemptions, strict: true }).strictBlocked).toHaveLength(1);
  });

  it('未豁免的违例在 --strict 下同样失败', () => {
    const root = tree({ 'src/lib/dead.cjs': 'module.exports = 1;\n' });
    const r = runCheck({ root, allowlist: BASE_ALLOW, exemptions: {}, strict: true });
    expect(r.blocked).toHaveLength(1);
    expect(r.strictBlocked).toEqual([]);
  });

  it('豁免不存在的项 → 不产生豁免记录（陈旧豁免可被 --strict 揪出）', () => {
    const root = tree({ 'src/lib/a.cjs': "require('./b.cjs');\n", 'src/lib/b.cjs': 'module.exports=1;\n' });
    const exemptions = { 'src/lib/gone.cjs': { reason: '陈旧', responsible: 'T1-115' } };
    const r = runCheck({ root, allowlist: [], exemptions });
    expect(r.exemptions).toEqual([]);
    expect(runCheck({ root, allowlist: [], exemptions, strict: true }).strictBlocked).toHaveLength(1);
  });
});

describe('本仓库配置自洽', () => {
  it('EXEMPTIONS 每条都有 reason + responsible（责任 task id）', () => {
    for (const [key, ex] of Object.entries(EXEMPTIONS)) {
      expect(ex.reason, `${key} 缺 reason`).toBeTruthy();
      expect(ex.responsible, `${key} 缺 responsible`).toMatch(/^T\d+-\d+/);
    }
  });

  it('ENTRY_ALLOWLIST 每条都有理由，且不是 glob', () => {
    for (const e of ENTRY_ALLOWLIST) {
      expect(e.reason, `${e.file} 缺理由`).toBeTruthy();
      expect(e.file).not.toMatch(/[*?]/);
    }
  });

  it('ENTRY_ALLOWLIST 指向的文件都真实存在（陈旧条目比没有更危险：文件被重建就静默放行）', () => {
    for (const e of ENTRY_ALLOWLIST) {
      expect(fs.existsSync(path.join(REPO, e.file)), `${e.file} 已不存在，白名单条目该删`).toBe(true);
    }
  });

  it('STRUCTURE_RULES 每条都有 id 与 reason（后续任务追加时同样要求）', () => {
    for (const r of STRUCTURE_RULES) {
      expect(r.id).toBeTruthy();
      expect(r.reason).toBeTruthy();
    }
  });

  it('当前树通过默认门禁（未豁免违例为 0）', () => {
    const r = runCheck({ root: REPO });
    expect(r.blocked.map((f) => `${f.check}:${f.key}`)).toEqual([]);
  });

  it('当前树 --strict 未通过（豁免表非空 = 债务在册，T1-115/T1-117 清空后转绿）', () => {
    const r = runCheck({ root: REPO, strict: true });
    expect(r.strictBlocked.length).toBe(Object.keys(EXEMPTIONS).length);
    expect(r.strictBlocked.length).toBeGreaterThan(0);
  });
});

describe('豁免表的责任任务可达性（T3-009-F2 / N-6）', () => {
  const ex = (responsible) => ({ 'lib → server': { reason: '结构债', responsible } });
  const T = (id, status, deps = []) => ({ id, status, deps });

  it('责任任务全部可达 → 不报', () => {
    const tasks = [T('T1-100', 'pending'), T('T1-113', 'pending', ['T1-100'])];
    expect(unreachableResponsibles(ex('T1-113'), tasks)).toEqual([]);
  });

  it('责任任务悬空（不在任务图里）→ 报', () => {
    const out = unreachableResponsibles(ex('T9-999'), [T('T1-100', 'pending')]);
    expect(out).toHaveLength(1);
    expect(out[0].why).toMatch(/悬空/);
  });

  it('责任任务自身 blocked → 报', () => {
    const out = unreachableResponsibles(ex('T1-113'), [T('T1-113', 'blocked')]);
    expect(out[0].why).toMatch(/自身 blocked/);
  });

  it('依赖闭包内有 blocked → 报（depsDone 要求 done，故该任务永不可就绪）', () => {
    const tasks = [T('T4-001', 'pending'), T('T1-106', 'blocked', ['T4-001']), T('T1-113', 'pending', ['T1-106'])];
    const out = unreachableResponsibles(ex('T1-113'), tasks);
    expect(out).toHaveLength(1);
    expect(out[0].why).toMatch(/T1-106/);
    expect(out[0].why).toMatch(/永不可就绪/);
  });

  it('间接（隔一层）的 blocked 也算 → 报（本项即 N-6 的形态）', () => {
    const tasks = [T('A', 'blocked'), T('B', 'pending', ['A']), T('T1-113', 'pending', ['B'])];
    expect(unreachableResponsibles(ex('T1-113'), tasks)).toHaveLength(1);
  });

  it('环不会让检测挂死（环里没有 blocked 就照常放行）', () => {
    const tasks = [T('X', 'pending', ['Y']), T('Y', 'pending', ['X'])];
    expect(unreachableResponsibles(ex('X'), tasks)).toEqual([]);
  });

  it('缺 responsible 字段 → 报（字段齐备是底线，不是全部）', () => {
    const out = unreachableResponsibles({ k: { reason: 'r' } }, [T('T1-113', 'pending')]);
    expect(out[0].why).toMatch(/缺 responsible/);
  });

  it('本仓库：EXEMPTIONS 的责任任务在真实任务图上可达', () => {
    // 读运行态 state.json —— 干净 clone（无 .awf/state.json）时无从判定，跳过；
    // 有运行态时，这条就是「登记的责任真的走得到」的机器出口。
    const statePath = path.join(REPO, '.awf', 'state.json');
    if (!fs.existsSync(statePath)) return;
    const { tasks } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(unreachableResponsibles(EXEMPTIONS, tasks)).toEqual([]);
  });
});

describe('CLI 行为（退出码 + 指出路径）', () => {
  const runCli = (args) => {
    try {
      return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
    }
  };

  it('干净树 → 0；有零引用模块 → 非 0 且输出文件路径', () => {
    // 干净树：入口走白名单，lib 被 cli 引用，方向在 ALLOWED 内
    const clean = tree({ 'src/cli/a.js': "require('../lib/b.cjs');\n", 'src/lib/b.cjs': 'module.exports=1;\n' });
    expect(runCli(['--root', clean]).code).toBe(0);

    const dirty = tree({
      'src/cli/a.js': "require('../lib/used.cjs');\n",
      'src/lib/used.cjs': 'module.exports=1;\n',
      'src/lib/dead.cjs': 'module.exports=2;\n',
    });
    const r = runCli(['--root', dirty]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/lib/dead.cjs');
  });

  it('越界导入 → 非 0 且指出路径', () => {
    const dirty = tree({
      'src/lib/a.cjs': "require('../server/b.cjs');\n",
      'src/server/b.cjs': 'module.exports=1;\n',
    });
    const r = runCli(['--root', dirty]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/lib/a.cjs');
  });

  it('--json 输出机器可读结果', () => {
    const dirty = tree({ 'src/lib/dead.cjs': 'module.exports=1;\n' });
    const r = runCli(['--root', dirty, '--json']);
    const parsed = JSON.parse(r.out);
    expect(parsed.blocked.map((f) => f.key)).toContain('src/lib/dead.cjs');
  });

  it('未知参数 → 退出码 2（用法错误不与门禁失败混淆）', () => {
    expect(runCli(['--nope']).code).toBe(2);
  });
});
