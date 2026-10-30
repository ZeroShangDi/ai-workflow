/**
 * check-capability 的对账门禁测试（T-P0-02 / U9）。
 *
 * U9 要点：不能只看「文档写了支持」——登记与真实实现、调用方必须能被机器对上，
 * 且**必需能力缺失/形状不合规时要真的失败**。本测试用临时夹具覆盖两个方向：
 *   正面：合法登记 → 通过；
 *   负面：缺实现路径 / 名册外端口 / blocked 缺 note / implemented 但无实现 / 未知字段 / id 重复 → 必须失败并给出可定位信息。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../scripts/check-capability.mjs';

/** 造一个最小可对账的根：ports.cjs 名册 + 一个真实存在的实现文件 + 登记 JSON。 */
function makeRoot({ capabilities, ports = ['host', 'hook'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capcheck-'));
  fs.mkdirSync(path.join(root, 'server/adapters'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/adapters/ports.cjs'), [
    'const PORT_CONTRACT = [',
    ...ports.map((n) => `  { name: '${n}', status: 'factory', role: 'r', methods: [] },`),
    '];',
    'module.exports = { PORT_CONTRACT };',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'server/adapters/impl.cjs'), 'module.exports = {};\n');
  const registry = { version: 1, legend: {}, capabilities };
  fs.writeFileSync(path.join(root, 'server/adapters/capability-registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
  return root;
}

/** 一份合法能力条目（可按需覆盖字段）。 */
function cap(over = {}) {
  return {
    id: 'C01',
    name: '示例能力',
    kind: 'public',
    port: 'host',
    status: 'partial',
    cc: { impl: ['server/adapters/impl.cjs'], note: 'cc 实现' },
    dsh: { impl: [], note: '待实现' },
    consumers: [],
    evidence: [],
    responsible: null,
    note: '限定说明',
    ...over,
  };
}

async function run(root) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await main(['--root', root]);
    return { code, out: logs.join('\n') };
  } finally {
    console.log = orig;
  }
}

describe('check-capability：能力登记对账', () => {
  it('合法登记通过', async () => {
    const root = makeRoot({ capabilities: [cap()] });
    const r = await run(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('对账通过');
  });

  it('impl 路径不存在 → 失败且点名该能力', async () => {
    const root = makeRoot({ capabilities: [cap({ cc: { impl: ['server/adapters/nope.cjs'], note: '' } })] });
    const r = await run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[C01]');
    expect(r.out).toContain('路径不存在');
  });

  it('端口不在 ports.cjs 名册里 → 失败', async () => {
    const root = makeRoot({ capabilities: [cap({ port: 'not-a-port' })] });
    const r = await run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('名册');
  });

  it('status=blocked 缺 note → 失败（不允许沉默的阻塞）', async () => {
    const root = makeRoot({ capabilities: [cap({ status: 'blocked', note: '' })] });
    const r = await run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('必须写 note');
  });

  it('status=implemented 但 cc.impl 为空 → 失败', async () => {
    const root = makeRoot({ capabilities: [cap({ status: 'implemented', cc: { impl: [], note: '' } })] });
    const r = await run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('cc.impl 为空');
  });

  it('未知字段 / id 重复 / 非法 status → 失败', async () => {
    const root = makeRoot({
      capabilities: [
        cap({ extra: 1 }),
        cap({ id: 'C01' }),
        cap({ id: 'C02', status: 'done' }),
      ],
    });
    const r = await run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('未知字段');
    expect(r.out).toContain('id 重复');
    expect(r.out).toContain('status 非法');
  });

  it('consumers 指向不存在的文件 → 失败', async () => {
    const root = makeRoot({ capabilities: [cap({ consumers: ['cli/nope.cjs'] })] });
    const r = await run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('consumers 路径不存在');
  });
});

describe('check-capability：登记本身的完备性（U9「必需能力缺失即失败」）', () => {
  it('真实仓库的 37 项能力齐全（C01～C37），且已具备 DSH 实现路径的项不为空壳', async () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const registry = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'server/adapters/capability-registry.json'), 'utf8'),
    );
    const ids = registry.capabilities.map((c) => c.id);
    for (let n = 1; n <= 37; n += 1) {
      const id = `C${String(n).padStart(2, '0')}`;
      expect(ids, `缺能力 ${id}`).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);

    // dsh.impl 非空 ⇒ 声明了「已有 DSH 实现路径」，其路径必须真实存在（不能是空壳声明）
    for (const cap of registry.capabilities) {
      for (const rel of cap.dsh?.impl ?? []) {
        expect(fs.existsSync(path.join(repoRoot, rel)), `${cap.id} 的 dsh.impl 不存在: ${rel}`).toBe(true);
      }
    }
    // 真仓库自检必须通过
    const { code } = await run(repoRoot);
    expect(code).toBe(0);
  });
});
