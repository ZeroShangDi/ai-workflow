import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
// 原经 server/features/index.js 这个「统一出口」取；该聚合桶无人生产引用（复盘 K1「建抽象没人用」），
// 已随收口删除 —— 直接指向真正的实现（tools 侧一律显式导入，不走桶）
const { MAX_RECHECK, gateFixMeta, spawnGateFixTask, spawnGateFixTaskAtomic } =
  require('../../server/features/gate/closure.js');

// 门禁闭环协议：fail → 派生修复 → 回退待复审，直到 pass 或达轮次上限。
// 规则归 features/gate（本文件），通用落账原语归 shared/state.js 的 mutateState。

const tmpRoots = [];
function makeRoot(state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gate-'));
  fs.mkdirSync(path.join(root, '.awf'), { recursive: true });
  if (state) fs.writeFileSync(path.join(root, '.awf', 'state.json'), JSON.stringify(state));
  tmpRoots.push(root);
  return root;
}
afterEach(() => { while (tmpRoots.length) fs.rmSync(tmpRoots.pop(), { recursive: true, force: true }); });

const readState = (root) => JSON.parse(fs.readFileSync(path.join(root, '.awf', 'state.json'), 'utf8'));

function fixture({ verdict = { level: 'fail', conclusion: '缺测试' }, recheck, status = 'blocked' } = {}) {
  const exec = { startedAt: 'x', completedAt: 'y', verdict };
  if (recheck !== undefined) exec.recheck = recheck;
  return {
    mode: 'run',
    currentState: 'CODE',
    version: '0.2.0',
    tasks: [
      { id: 'T1', kind: 'dev', status: 'done', deps: [], acceptance: 'a' },
      { id: 'R1', kind: 'review', status, deps: ['T1'], acceptance: '模块验收', title: '模块门禁', exec },
    ],
  };
}
const gateOf = (state) => state.tasks.find((t) => t.id === 'R1');

describe('server · 门禁闭环规则（gateFixMeta）', () => {
  it('blocked + 非 pass verdict → 给出本轮 recheck 与派生 id', () => {
    expect(gateFixMeta(gateOf(fixture()))).toEqual({ recheck: 1, fixId: 'R1-F1' });
    expect(gateFixMeta(gateOf(fixture({ recheck: 1 })))).toEqual({ recheck: 2, fixId: 'R1-F2' });
  });

  it('不派生的四种情形：非门禁 / 非 blocked / 无 verdict / verdict=pass', () => {
    expect(gateFixMeta({ id: 'X', kind: 'dev', status: 'blocked', exec: { verdict: { level: 'fail' } } })).toBeNull();
    expect(gateFixMeta(gateOf(fixture({ status: 'pending' })))).toBeNull();
    expect(gateFixMeta(gateOf(fixture({ verdict: null })))).toBeNull();
    expect(gateFixMeta(gateOf(fixture({ verdict: { level: 'pass' } })))).toBeNull();
  });

  it('达轮次上限 → 不再派生（保持 blocked，交人工）', () => {
    expect(gateFixMeta(gateOf(fixture({ recheck: MAX_RECHECK })))).toBeNull();
  });
});

describe('server · 门禁闭环派生（spawnGateFixTask）', () => {
  it('派生 dev 修复任务、插在门禁之前，并把门禁回退 pending 待复审', () => {
    const state = fixture();
    expect(spawnGateFixTask(state, gateOf(state), '修吧')).toBe('R1-F1');

    // 修复任务排在门禁之前，deps 继承门禁原依赖
    expect(state.tasks.map((t) => t.id)).toEqual(['T1', 'R1-F1', 'R1']);
    const fix = state.tasks.find((t) => t.id === 'R1-F1');
    expect(fix).toMatchObject({ kind: 'dev', status: 'pending', deps: ['T1'], acceptance: '模块验收', prompt: '修吧' });

    // 门禁回退待复审：pending + recheck+1 + 清掉本轮起止时间（verdict 保留供下一轮参考）+ deps 串上修复任务
    const back = gateOf(state);
    expect(back.status).toBe('pending');
    expect(back.exec.recheck).toBe(1);
    expect(back.exec.startedAt).toBeUndefined();
    expect(back.exec.verdict).toEqual({ level: 'fail', conclusion: '缺测试' });
    expect(back.deps).toContain('R1-F1');
  });

  it('不可派生时 state 原样不动', () => {
    const state = fixture({ verdict: { level: 'pass' } });
    const before = JSON.stringify(state.tasks);
    expect(spawnGateFixTask(state, gateOf(state), 'p')).toBeNull();
    expect(JSON.stringify(state.tasks)).toBe(before);
  });
});

describe('server · 门禁闭环原子派生（spawnGateFixTaskAtomic）', () => {
  it('锁内读改写：派生并落盘，返回本轮元数据', () => {
    const root = makeRoot(fixture());
    const out = spawnGateFixTaskAtomic(root, 'R1', '修吧', 'R1-F1');
    expect(out).toEqual({ fixId: 'R1-F1', recheck: 1 });

    const saved = readState(root);
    expect(saved.tasks.map((t) => t.id)).toEqual(['T1', 'R1-F1', 'R1']);
    expect(gateOf(saved).status).toBe('pending');
  });

  it('CAS 不符 → 不派发也不写盘（调用方生成 prompt 期间门禁已被别人推进）', () => {
    const root = makeRoot(fixture({ recheck: 1 }));       // 实际 meta.fixId = R1-F2
    const before = JSON.stringify(readState(root));
    expect(spawnGateFixTaskAtomic(root, 'R1', '修吧', 'R1-F1')).toBeNull();
    expect(JSON.stringify(readState(root))).toBe(before);
  });

  it('达上限 → 不派发（幂等 no-op）', () => {
    const root = makeRoot(fixture({ recheck: MAX_RECHECK }));
    expect(spawnGateFixTaskAtomic(root, 'R1', '修吧')).toBeNull();
    expect(readState(root).tasks).toHaveLength(2);
  });
});
