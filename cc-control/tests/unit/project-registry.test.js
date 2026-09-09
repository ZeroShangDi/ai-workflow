import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectContext, createProjectRegistry } from '../../src/server/project-context.cjs';

// project-context：单 server 多项目的每项目容器 + 注册表（纯打包/寻址，构造无副作用）。
// 覆盖：boot 缺省、懒建/记忆化、归一化、每项目独立 mutable 槽、磁盘锚点隔离、会话名唯一。

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

describe('createProjectRegistry — 注册表', () => {
  it('缺省 root → boot 上下文，最先注册', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    const boot = reg.ctxFor();
    expect(boot.projectRoot).toBe(ROOT_A);
    expect(reg.size).toBe(1);
  });

  it('ctxFor 懒建 + 记忆化：同 root 同实例', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    expect(reg.ctxFor(ROOT_B)).toBe(reg.ctxFor(ROOT_B));
    expect(reg.size).toBe(2);
  });

  it('归一化：路径等价形式命中同一实例', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    expect(reg.ctxFor(path.join(ROOT_B, '..', 'projB'))).toBe(reg.ctxFor(ROOT_B));
  });

  it('resolveCtx：无 p → boot；p / bodyProjectRoot 兜底到对应项目', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    reg.ctxFor(ROOT_B);
    expect(reg.resolveCtx({}).projectRoot).toBe(ROOT_A);
    expect(reg.resolveCtx({ p: ROOT_B }).projectRoot).toBe(ROOT_B);
    expect(reg.resolveCtx({ bodyProjectRoot: ROOT_B }).projectRoot).toBe(ROOT_B);
  });

  it('list 枚举已注册项目', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    reg.ctxFor(ROOT_B);
    const roots = reg.list().map((x) => x.projectRoot).sort();
    expect(roots).toEqual([ROOT_A, ROOT_B].sort());
  });

  it('reset 复位全部上下文 mutable 槽（含 run host 引用清空）', () => {
    const reg = createProjectRegistry({ env: {}, bootRoot: ROOT_A });
    reg.ctxFor(ROOT_A).state = 'busy';
    reg.ctxFor(ROOT_A).decisionPending = { question: 'x' };
    reg.reset();
    expect(reg.ctxFor(ROOT_A).state).toBe('ready');
    expect(reg.ctxFor(ROOT_A).decisionPending).toBeNull();
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

  it('mutable 槽相互独立（不共享单槽）', () => {
    const a = createProjectContext({ projectRoot: ROOT_A, env: {} });
    const b = createProjectContext({ projectRoot: ROOT_B, env: {} });
    a.state = 'busy';
    a.decisionPending = { question: 'only-a' };
    expect(b.state).toBe('ready');
    expect(b.decisionPending).toBeNull();
  });

  it('per-sid 内存槽独立；runStateFile 根锚本项目', () => {
    const a = createProjectContext({ projectRoot: ROOT_A, env: {} });
    a.runSlotFor('ra').setReady();
    a.runSlotFor('ra').setBusy();
    expect(a.runSlotFor('rb').state).not.toBe('busy'); // 不同 sid 不串
    expect(a.runStateFile('ra')).toBe(path.join(ROOT_A, '.awf', 'runs', 'ra', 'state.json'));
    expect(a.runStateFile()).toBe(path.join(ROOT_A, '.awf', 'state.json'));
  });
});
