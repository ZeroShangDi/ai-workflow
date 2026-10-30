import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 随旧树退役拆成两处（原 src/server/project-context.cjs 一个文件）：
//   每项目容器 = server/runtime/project.cjs；注册表 = server/runtime/registry.cjs
import { createProjectContext } from '../../server/runtime/project.cjs';
import { createProjectRegistry } from '../../server/runtime/registry.cjs';
import { createProjectRuntime } from '../../server/runtime/index.cjs';

// 单 server 多项目的每项目容器 + 注册表（纯打包/寻址，构造无副作用）。
// 覆盖：boot 缺省、懒建/记忆化、归一化、每项目独立运行态、磁盘锚点隔离、会话名唯一。
//
// 与旧版的口径差异（新树分层）：ctx 只装身份/路径/出口，**运行态在 session 上**
// —— 故旧的 `ctx.state / ctx.decisionPending` 断言改为 `rt.session.*`；
// per-sid 内存槽由 `ctx.runSlotFor(sid)` 改为 `rt.sessionFor(sid)`。

let ROOT_A;
let ROOT_B;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-pctx-'));
  ROOT_A = path.join(base, 'projA');
  ROOT_B = path.join(base, 'projB');
  for (const r of [ROOT_A, ROOT_B]) {
    fs.mkdirSync(path.join(r, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(r, '.awf', 'state.json'), JSON.stringify({ version: '0.1.0', mode: 'idle', tasks: [] }));
  }
});

afterAll(() => {
  fs.rmSync(path.dirname(ROOT_A), { recursive: true, force: true });
});

/** boot 的每项目容器 */
const bootCtx = (reg) => reg.runtimeFor(reg.bootRoot).ctx;
/** 某项目的会话态（运行态的新家） */
const sessOf = (reg, root) => reg.runtimeFor(root).session;

describe('createProjectRegistry — 注册表', () => {
  it('缺省 root → boot 上下文，最先注册', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    expect(bootCtx(reg).projectRoot).toBe(ROOT_A);
    expect(reg.size).toBe(1);
  });

  it('runtimeFor 懒建 + 记忆化：同 root 同实例', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    expect(reg.runtimeFor(ROOT_B)).toBe(reg.runtimeFor(ROOT_B));
    expect(reg.size).toBe(2);
  });

  it('归一化：路径等价形式命中同一实例', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    expect(reg.runtimeFor(path.join(ROOT_B, '..', 'projB'))).toBe(reg.runtimeFor(ROOT_B));
  });

  it('resolveRuntime：无 p → boot；p / bodyProjectRoot 兜底到对应项目', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    reg.runtimeFor(ROOT_B);
    expect(reg.resolveRuntime({}).ctx.projectRoot).toBe(ROOT_A);
    expect(reg.resolveRuntime({ p: ROOT_B }).ctx.projectRoot).toBe(ROOT_B);
    expect(reg.resolveRuntime({ bodyProjectRoot: ROOT_B }).ctx.projectRoot).toBe(ROOT_B);
  });

  it('list 枚举已注册项目', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    reg.runtimeFor(ROOT_B);
    const roots = reg.list().map((x) => x.projectRoot).sort();
    expect(roots).toEqual([ROOT_A, ROOT_B].sort());
  });

  it('reset 复位全部运行态（会话回 ready、待答决策清空）', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    sessOf(reg, ROOT_A).setBusy();
    sessOf(reg, ROOT_A).setDecision({ question: 'x' });
    reg.reset();
    expect(sessOf(reg, ROOT_A).state).toBe('ready');
    expect(sessOf(reg, ROOT_A).decisionPending).toBeNull();
  });
});

describe('createProjectContext — 每项目独立', () => {
  it('会话名按 projectSid 确定性派生且两项目相异', () => {
    const a = createProjectContext({ projectRoot: ROOT_A, env: {} });
    const b = createProjectContext({ projectRoot: ROOT_B, env: {} });
    expect(a.runSessionName).not.toBe(b.runSessionName);
    expect(a.runSessionName).toBe(createProjectContext({ projectRoot: ROOT_A, env: {} }).runSessionName);
  });

  it('磁盘锚点各自独立（state 落在各自 .awf/state.json，无 sid 分片）', () => {
    const a = createProjectContext({ projectRoot: ROOT_A, env: {} });
    const b = createProjectContext({ projectRoot: ROOT_B, env: {} });
    expect(a.storeCtx.statePath).toBe(path.join(ROOT_A, '.awf', 'state.json'));
    expect(b.storeCtx.statePath).toBe(path.join(ROOT_B, '.awf', 'state.json'));
    expect(a.storeCtx.runDir).toBeUndefined(); // 无 sid → 不分片
    // 写/读各自隔离
    a.stores.state.updateSync((s) => ({ ...s, marker: 'A' }));
    b.stores.state.updateSync((s) => ({ ...s, marker: 'B' }));
    expect(a.stores.state.readSync().marker).toBe('A');
    expect(b.stores.state.readSync().marker).toBe('B');
    expect(JSON.parse(fs.readFileSync(path.join(ROOT_A, '.awf', 'state.json'), 'utf8')).marker).toBe('A');
    expect(JSON.parse(fs.readFileSync(path.join(ROOT_B, '.awf', 'state.json'), 'utf8')).marker).toBe('B');
  });

  it('每项目运行态相互独立（不共享单槽）', () => {
    const rtA = createProjectRuntime({ projectRoot: ROOT_A, env: {} });
    const rtB = createProjectRuntime({ projectRoot: ROOT_B, env: {} });
    rtA.session.setBusy();
    rtA.session.setDecision({ question: 'only-a' });
    expect(rtB.session.state).toBe('ready');
    expect(rtB.session.decisionPending).toBeNull();
  });

  it('per-sid 内存槽独立；runStateFile 根锚本项目', () => {
    const rt = createProjectRuntime({ projectRoot: ROOT_A, env: {} });
    rt.sessionFor('ra').setBusy();
    expect(rt.sessionFor('rb').state).not.toBe('busy'); // 不同 sid 不串
    expect(rt.ctx.runStateFile('ra')).toBe(path.join(ROOT_A, '.awf', 'runs', 'ra', 'state.json'));
    expect(rt.ctx.runStateFile()).toBe(path.join(ROOT_A, '.awf', 'state.json'));
  });
});
