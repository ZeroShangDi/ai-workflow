'use strict';
/**
 * oneshot.cjs — cc oneshot 端口（claude -p 收口；外部源码零 claude 字面）
 *
 * 无状态 LLM 调用（claude -p）统一收口到此 adapter。spawnClaudeP 提供 raw 结果
 * { ok, stdout, stderr, code, error? }；runOneShot 包装为 { ok, text, error? }（供诊断等
 * 需要 stderr/统一错误语义的调用方）。spawn 可注入（测试）。claude 字面只在 adapter。
 */

const child = require('node:child_process');

/**
 * claude -p 参数构造（诊断/oneshot 可传额外 args 如 --safe-mode --no-session-persistence）。
 */
function claudePArgs(prompt, { args = [] } = {}) {
  return ['-p', ...args, prompt];
}

/**
 * spawn claude -p（stdio stdin ignore，stdout/stderr 收集，NO_COLOR 隔离）。
 * @param {{ prompt: string, cwd?: string, args?: string[], env?: object, timeoutMs?: number, spawn?: Function }} opts
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null, error?: string }>}
 */
function spawnClaudeP({ prompt, cwd, args = [], env = process.env, timeoutMs, stdio = ['ignore', 'pipe', 'pipe'], spawn = child.spawn } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('claude', claudePArgs(prompt, { args }), {
      cwd: cwd || process.cwd(),
      stdio,
      env: { ...env, NO_COLOR: '1' },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c) => { stdout += c.toString(); });
    proc.stderr?.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (error) => resolve({ ok: false, stdout, stderr, code: null, error: error.message }));
    proc.on('close', (code) => resolve({ ok: code === 0, stdout, stderr, code }));
  });
}

/**
 * 便捷包装：{ ok, text: stdout.trim(), error?: stderr.trim() || `claude -p exited ${code}` }。
 * @param {Parameters<spawnClaudeP>[0]} opts
 */
async function runOneShot(opts) {
  const r = await spawnClaudeP(opts);
  if (r.ok) return { ok: true, text: r.stdout.trim() };
  return { ok: false, error: (r.stderr && r.stderr.trim()) || (r.error || `claude -p exited ${r.code}`) };
}

module.exports = { claudePArgs, spawnClaudeP, runOneShot };
