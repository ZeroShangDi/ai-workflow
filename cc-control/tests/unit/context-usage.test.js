import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/context-usage.mjs', import.meta.url));

// 每个测试独立的 cwd，避免相互覆盖 .awf/context/usage.json
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-context-usage-'));

/** 以给定 statusline payload 运行脚本，返回 spawnSync 结果 */
function run(payload) {
  return spawnSync('node', [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf-8' });
}

function readUsage(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.awf', 'context', 'usage.json'), 'utf-8'));
}

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('context-usage.mjs — statusline 上下文占用落盘', () => {
  it('有 used_percentage → 写 usage.json（含各字段）+ stdout 显示百分比', () => {
    const res = run({
      cwd: TMP,
      context_window: {
        used_percentage: 62,
        remaining_percentage: 38,
        context_window_size: 200000,
        total_input_tokens: 124000,
      },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('ctx 62%');

    const usage = readUsage(TMP);
    expect(usage.used_percentage).toBe(62);
    expect(usage.remaining_percentage).toBe(38);
    expect(usage.context_window_size).toBe(200000);
    expect(usage.total_input_tokens).toBe(124000);
    expect(usage.updatedAt).toBeTruthy();
  });

  it('used_percentage 为 null（会话早期）→ usage.json 记 null + stdout ctx ?', () => {
    const res = run({ cwd: TMP, context_window: { used_percentage: null, context_window_size: 200000 } });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('ctx ?');
    expect(readUsage(TMP).used_percentage).toBe(null);
  });

  it('非 JSON 输入 → 不崩，stdout ctx ?', () => {
    const res = spawnSync('node', [SCRIPT], { input: 'garbage-not-json', encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('ctx ?');
  });

  it('无 cwd 字段 → 回退进程 cwd（spawn 的 cwd），写对应位置', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-context-usage2-'));
    const res = spawnSync('node', [SCRIPT], {
      input: JSON.stringify({ context_window: { used_percentage: 8 } }),
      cwd: tmp2,
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('ctx 8%');
    expect(fs.existsSync(path.join(tmp2, '.awf', 'context', 'usage.json'))).toBe(true);
    fs.rmSync(tmp2, { recursive: true, force: true });
  });
});
