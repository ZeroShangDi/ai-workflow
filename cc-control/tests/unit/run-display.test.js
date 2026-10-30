import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRunDisplay } = require('../../cli/lib/run-display.cjs');

// 解释展示层用到的光标指令，断言用户最终看到的行，而不只检查发出了 ANSI 字符。
function terminal(isTTY = true) {
  const screen = [''];
  const writes = [];
  let row = 0;
  const output = {
    isTTY, columns: 100, rows: 24,
    write(text) {
      writes.push(text);
      for (const token of text.split(/(\x1b\[\d+[AJ]|\r|\n)/).filter(Boolean)) {
        if (/^\x1b\[\d+A$/.test(token)) row -= Number(token.slice(2, -1));
        else if (token === '\x1b[0J') { screen.splice(row); screen[row] = ''; }
        else if (token === '\n') { row++; screen[row] ??= ''; }
        else if (token !== '\r') screen[row] = (screen[row] || '') + token;
      }
    },
  };
  return { output, writes, text: () => screen.join('\n') };
}

function event(type, taskId = 'T1', at = Date.now(), title) {
  return { type, at: new Date(at).toISOString(), payload: { taskId, title } };
}

let displays;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  displays = [];
  delete process.env.AWF_TASK_LIST_INTERACTIVE;
});
afterEach(() => {
  for (const display of displays) display.stop();
  vi.useRealTimers();
});

function setup(isTTY = true) {
  const term = terminal(isTTY);
  const display = createRunDisplay({ output: term.output, print: (line) => term.output.write(`${line}\n`) });
  displays.push(display);
  return { ...term, display };
}

describe('run 终端跟随展示', () => {
  it('无新事件时仍刷新耗时，结束后只留一行完成记录并停表', () => {
    const t = setup();
    t.display.event(event('task.started', 'T1', Date.now(), '绘制场景'));
    vi.advanceTimersByTime(3000);
    expect(t.text()).toContain('● [T1] 绘制场景 3s');
    t.display.event(event('task.done'));
    expect(t.text().trim()).toBe('✓ [T1] 绘制场景 3s');
    t.display.stop();
    const writes = t.writes.length;
    vi.advanceTimersByTime(5000);
    expect(t.writes).toHaveLength(writes);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('并行任务分别计时，run 日志插入与单个任务结束不覆盖其他任务', () => {
    const t = setup();
    t.display.event(event('task.started', 'T1', Date.now(), 'A'));
    vi.advanceTimersByTime(2000);
    t.display.event(event('task.started', 'T2', Date.now(), 'B'));
    vi.advanceTimersByTime(3000);
    t.display.event({ type: 'run.phase' });
    t.display.event(event('task.done', 'T1'));
    expect(t.text()).toContain('· run.phase\n  ✓ [T1] A 5s\n  ● [T2] B 3s');
    vi.advanceTimersByTime(2000);
    t.display.event(event('task.blocked', 'T2'));
    expect(t.text().match(/\[T1\]/g)).toHaveLength(1);
    expect(t.text().match(/\[T2\]/g)).toHaveLength(1);
    expect(t.text()).toContain('⚠ [T2] B 5s');
  });

  it('挂接历史事件用宿主起止时间，相同 taskId 在下一次订阅不串标题和耗时', () => {
    const t = setup();
    const now = Date.now();
    t.display.event(event('task.started', 'T1', now - 243000, '旧任务'));
    t.display.event(event('task.done', 'T1', now - 1000));
    expect(t.text()).toContain('✓ [T1] 旧任务 242s');
    const next = setup();
    next.display.event(event('task.done', 'T1', now, '新任务'));
    expect(next.text()).toContain('✓ [T1] 新任务 0s');
  });

  it('普通管道保留开始/完成日志，评测显式开启时可强制刷新', () => {
    const t = setup(false);
    t.display.event(event('task.started', 'T1', Date.now(), 'A'));
    vi.advanceTimersByTime(2000);
    t.display.event(event('task.done'));
    expect(t.text()).toContain('● [T1] A 0s\n  ✓ [T1] A 2s');
    expect(t.writes.join('')).not.toContain('\x1b');
    process.env.AWF_TASK_LIST_INTERACTIVE = '1';
    const forced = setup(false);
    forced.display.event(event('task.started', 'T2', Date.now(), 'B'));
    vi.advanceTimersByTime(2000);
    expect(forced.text()).toContain('● [T2] B 2s');
    delete process.env.AWF_TASK_LIST_INTERACTIVE;
  });

  it('决策输入期间暂停刷新，异常离开输入后恢复', async () => {
    const t = setup();
    t.display.event(event('task.started', 'T1', Date.now(), 'A'));
    let reject;
    const prompt = t.display.duringPrompt(() => new Promise((_, fail) => { reject = fail; }));
    t.output.write('选择序号: ');
    const writes = t.writes.length;
    vi.advanceTimersByTime(3000);
    expect(t.writes).toHaveLength(writes);
    t.output.write('\n');
    reject(new Error('输入取消'));
    await expect(prompt).rejects.toThrow('输入取消');
    expect(t.text()).toContain('选择序号: \n  ● [T1] A 3s');
  });

  it('窄终端的中文标题保持单行，避免换行导致重复和擦错行', () => {
    const t = setup();
    t.output.columns = 24;
    t.display.event(event('task.started', 'T1', Date.now(), '绘制鹈鹕与自行车静态场景'.repeat(5)));
    expect(t.text()).toContain('… 0s');
    t.display.event(event('task.done'));
    expect(t.text()).not.toContain('●');
    expect(t.text().match(/\[T1\]/g)).toHaveLength(1);
  });
});
