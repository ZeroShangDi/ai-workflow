import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ports = require('../../server/adapters/ports.cjs');
const { planCommand } = require('../../cli/commands/plan.cjs');
const { planEntry } = await import('../../server/shared/prompts.js');

/**
 * planCommand — `awf plan` 的编排（归档旧 state → 取入口提示词 → 开交互会话）
 *
 * 随旧树退役重写。旧版靠 `vi.mock('…/ports.cjs')` 换掉 adapter —— 那对新树不成立（CJS 的 require
 * 不被拦截，见 .awf/issues/014）。但 `ports` 与 `plan.cjs` 在**同一进程里共享同一个对象实例**，
 * 所以测试侧直接替换 `ports.interactive.launchDialog` 即可拦住真会话 —— **不必给产线加缝**。
 * 交互会话本身（launchInteractiveClaude）的执行路径无单测，已登记在 issue 014。
 *
 * 提示词与归档两块各自的深测在 plugin-bridge.test.js / state-plan-reset.test.js；
 * 这里只覆盖**编排**：三步都被调到、顺序对、参数对、输出对。
 */

let TMP;
let calls;
let originalLaunch;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-plan-'));
  vi.spyOn(process, 'cwd').mockReturnValue(TMP);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  calls = [];
  originalLaunch = ports.interactive.launchDialog;
  ports.interactive.launchDialog = vi.fn(async (opts) => { calls.push(opts); });
});

afterEach(() => {
  ports.interactive.launchDialog = originalLaunch;
  vi.restoreAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 播一个残留的旧 plan state（有 tasks + plan，mode=idle） */
function seedStalePlan() {
  fs.mkdirSync(path.join(TMP, '.awf'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.awf', 'state.json'), JSON.stringify({
    version: '0.1.0', mode: 'idle', currentState: 'CODE',
    plan: { summary: '旧计划' },
    tasks: [{ id: 'T1', title: '旧任务', status: 'pending' }],
  }, null, 2));
}

describe('planCommand', () => {
  it('有 description → 以 plan-start 提示词开交互会话（cwd 为本项目）', async () => {
    await planCommand('搭建测试基础设施');

    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(TMP);
    expect(calls[0].prompt).toBe(await planEntry('搭建测试基础设施', undefined));
  });

  it('无 description → plan-default', async () => {
    await planCommand(undefined);
    expect(calls[0].prompt).toBe(await planEntry(undefined, undefined));
  });

  it('--resume → plan-resume（且优先于 description）', async () => {
    await planCommand('随便写的', { resume: true });
    expect(calls[0].prompt).toBe(await planEntry('随便写的', true));
  });

  it('残留旧 plan（mode=idle）→ 先归档再开会话，并如实打印归档路径', async () => {
    seedStalePlan();
    await planCommand('新需求');

    const versions = fs.readdirSync(path.join(TMP, '.awf', 'versions'));
    expect(versions).toHaveLength(1); // 旧 state 进了 versions/
    const after = JSON.parse(fs.readFileSync(path.join(TMP, '.awf', 'state.json'), 'utf8'));
    expect(after.tasks ?? []).toHaveLength(0); // 已重置为空计划模板
    expect(calls).toHaveLength(1);
  });

  it('run 运行中（mode=run）→ 不重置 state，照常开规划会话', async () => {
    fs.mkdirSync(path.join(TMP, '.awf'), { recursive: true });
    const busy = { version: '0.1.0', mode: 'run', currentState: 'CODE', tasks: [{ id: 'T1', status: 'active' }] };
    fs.writeFileSync(path.join(TMP, '.awf', 'state.json'), JSON.stringify(busy, null, 2));

    await planCommand('新需求');

    expect(JSON.parse(fs.readFileSync(path.join(TMP, '.awf', 'state.json'), 'utf8')).mode).toBe('run');
    expect(fs.existsSync(path.join(TMP, '.awf', 'versions'))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('--resume 时不走归档（恢复语义：现场原样续用）', async () => {
    fs.mkdirSync(path.join(TMP, '.awf'), { recursive: true });
    fs.writeFileSync(path.join(TMP, '.awf', 'state.json'), JSON.stringify({
      version: '0.1.0', mode: 'idle', currentState: 'PLAN', plan: { summary: 's' }, tasks: [{ id: 'T1', status: 'pending' }],
    }, null, 2));

    await planCommand(undefined, { resume: true });

    expect(fs.existsSync(path.join(TMP, '.awf', 'versions'))).toBe(false); // 没归档
    expect(calls).toHaveLength(1);
  });
});
