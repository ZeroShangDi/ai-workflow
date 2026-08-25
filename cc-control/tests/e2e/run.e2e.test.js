import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = fileURLToPath(new URL('../../src/server/server.cjs', import.meta.url));

// ── 临时项目：runCommand 的 process.cwd() 指向这里，state.json 真实读写 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-run-e2e-'));
const STATE_PATH = path.join(TMP, '.awf', 'state.json');
fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });

// ── mock tmux（服务器 in-process 加载时通过 global.__CC_TMUX__ 注入）──
// sendText 触发「模拟 AI」：真实 Claude 会在收到 prompt 后工作并回写 state.json + Stop hook。
const mockTmux = {
  hasSession: vi.fn(() => true),
  sendText: vi.fn(),
  sendEnter: vi.fn(),
  capture: vi.fn(() => ''),
  SESSION: 'cc',
};

// 每个测试注入的「模拟 AI」行为：收到 prompt 文本后决定是否标 done，并始终 setReady 推进状态机。
let promptHandler = null;
mockTmux.sendText.mockImplementation((text) => {
  if (promptHandler) promptHandler(text);
});

// ── child_process 全部 mock：tmux / bash bootstrap / open 无法在测试环境运行 ──
const h = vi.hoisted(() => ({
  execSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: h.execSync,
  spawn: h.spawn,
}));

import { runCommand } from '../../src/cli/run.js';

// ── state.json 直接读写（模拟 AI 通过 awf-state MCP 写文件；MCP 写路径已在 e2e-smoke 覆盖）──
function readState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function markDone(id) {
  const s = readState();
  const t = s.tasks.find((x) => x.id === id);
  if (t) {
    t.status = 'done';
    t.exec = t.exec || {};
    t.exec.result = t.exec.result || 'e2e done';
  }
  writeState(s);
}

function baseState(tasks) {
  return {
    mode: 'run',
    version: '0.1.0',
    currentState: 'CODE',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    plan: { summary: 'run e2e' },
    tasks,
    milestones: [],
  };
}

function task(id, prompt, deps = []) {
  return { id, title: id, prompt, status: 'pending', deps };
}

function sentPrompts() {
  return mockTmux.sendText.mock.calls.map((c) => c[0]);
}

let server;

beforeAll(async () => {
  // 必须在 import server.cjs 之前注入：server 在模块顶层读取 env + global.__CC_TMUX__
  process.env.CC_PROJECT = TMP;
  process.env.CC_PORT = '8787';
  process.env.CC_READY_TIMEOUT_MS = '2000';
  process.env.CC_ENTER_DELAY_MS = '0';
  process.env.CC_LOCAL_CMD_MS = '500';
  global.__CC_TMUX__ = mockTmux;

  // spawn('node', [server.cjs]) 只返回假句柄——真实 server 已在进程内启动。
  h.spawn.mockImplementation(() => {
    const proc = new EventEmitter();
    proc.unref = () => {};
    return proc;
  });

  vi.spyOn(process, 'cwd').mockReturnValue(TMP);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  server = await import(SERVER_PATH);
  await server.start(8787);
});

afterAll(async () => {
  await server?.stop();
  delete global.__CC_TMUX__;
  for (const k of ['CC_PROJECT', 'CC_PORT', 'CC_READY_TIMEOUT_MS', 'CC_ENTER_DELAY_MS', 'CC_LOCAL_CMD_MS']) {
    delete process.env[k];
  }
  vi.restoreAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  server._resetForTest();
  promptHandler = null;
  mockTmux.sendText.mockClear();
  mockTmux.sendEnter.mockClear();
  fs.rmSync(path.join(TMP, '.awf', 'versions'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, '.awf', 'logs'), { recursive: true, force: true });
});

describe('awf run 端到端 — runCommand 主循环 + 收尾协商', () => {
  it('E2E-1: 单任务正常完成 → 只 send 一次 → backup 写 versions', async () => {
    writeState(baseState([task('T1', 'do task one')]));
    promptHandler = (text) => {
      if (text === 'do task one') markDone('T1');
      server.setReady();
    };

    await runCommand(undefined, {});

    const s = readState();
    expect(s.tasks[0].status).toBe('done');
    expect(s.tasks[0].exec.result).toBe('e2e done');

    const versions = fs.readdirSync(path.join(TMP, '.awf', 'versions'));
    expect(versions).toHaveLength(1);

    expect(sentPrompts()).toEqual(['do task one']);
  }, 20000);

  it('E2E-2: 未标 done → 补发 wrapup → 生效', async () => {
    writeState(baseState([task('T1', 'do task one')]));
    promptHandler = (text) => {
      if (text.includes('收尾') && text.includes('awf_task_status')) markDone('T1');
      server.setReady();
    };

    await runCommand(undefined, {});

    const s = readState();
    expect(s.tasks[0].status).toBe('done');

    const prompts = sentPrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe('do task one');
    expect(prompts[1]).toContain('awf_task_status');
    expect(prompts[1]).toContain('T1');
  }, 20000);

  it('E2E-3: wrapup 未生效 → 追问 1 轮 → done', async () => {
    writeState(baseState([task('T1', 'do task one')]));
    promptHandler = (text) => {
      if (text.includes('三选一')) markDone('T1');
      server.setReady();
    };

    await runCommand(undefined, {});

    const s = readState();
    expect(s.tasks[0].status).toBe('done');

    const prompts = sentPrompts();
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toBe('do task one');
    expect(prompts[1]).toContain('收尾');
    expect(prompts[2]).toContain('三选一');
  }, 20000);

  it('E2E-4: 追问 3 轮仍未完成 → 标 blocked 跳过', async () => {
    writeState(baseState([task('T1', 'do task one')]));
    promptHandler = () => server.setReady(); // 永不标 done

    await runCommand(undefined, {});

    const s = readState();
    expect(s.tasks[0].status).toBe('blocked');

    const prompts = sentPrompts();
    expect(prompts).toHaveLength(5); // task + wrapup + 3 轮 settle
    expect(prompts.filter((p) => p.includes('三选一'))).toHaveLength(3);
  }, 20000);

  it('E2E-5: 多任务顺序执行，deps 满足后才执行 T2', async () => {
    writeState(baseState([
      task('T1', 'task one'),
      task('T2', 'task two', ['T1']),
    ]));
    promptHandler = (text) => {
      if (text === 'task one') markDone('T1');
      else if (text === 'task two') markDone('T2');
      server.setReady();
    };

    await runCommand(undefined, {});

    const s = readState();
    expect(s.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    // 第一个任务跳过上下文检查；第二个任务前会先发 context-check prompt
    const prompts = sentPrompts();
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toBe('task one');
    expect(prompts[1]).toContain('上下文检查');
    expect(prompts[2]).toBe('task two');
  }, 20000);
});
