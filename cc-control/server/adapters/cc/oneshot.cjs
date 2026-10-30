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
 * prompt 固定放最后一位（claude -p 的位置参数），额外 args 插在它前面。
 */
function claudePArgs(prompt, { args = [] } = {}) {
  return ['-p', ...args, prompt];
}

/**
 * spawn claude -p（stdio stdin ignore，stdout/stderr 收集，NO_COLOR 隔离）。
 * 用 spawn 而非 exec：不经过 shell，prompt 里的引号/特殊字符不会被 shell 解释（注入面更小）。
 * @param {{ prompt: string, cwd?: string, args?: string[], env?: object, timeoutMs?: number, spawn?: Function }} opts
 *   spawn 可注入（测试），默认 child.spawn
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null, error?: string }>}
 *   ok 仅当退出码为 0；进程起不来（error）时 code=null、error 带消息；永不 reject
 */
function spawnClaudeP({ prompt, cwd, args = [], env = process.env, timeoutMs, stdio = ['ignore', 'pipe', 'pipe'], spawn = child.spawn } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('claude', claudePArgs(prompt, { args }), {
      cwd: cwd || process.cwd(),
      stdio,
      // NO_COLOR：强制关闭 ANSI 颜色，否则 stdout 会夹带转义序列，污染后续文本解析
      env: { ...env, NO_COLOR: '1' },
      // timeoutMs 仅在给了才带该键（缺省不带，避免 0/undefined 改变 spawn 行为）
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    let stdout = '';
    let stderr = '';
    // 流式拼接（可选链：stdio 被改成 'ignore' 时 stdout/stderr 可能为 null）
    proc.stdout?.on('data', (c) => { stdout += c.toString(); });
    proc.stderr?.on('data', (c) => { stderr += c.toString(); });
    // error（起不来）与 close（正常结束）二选一 resolve —— 两者不会都发生
    proc.on('error', (error) => resolve({ ok: false, stdout, stderr, code: null, error: error.message }));
    proc.on('close', (code) => resolve({ ok: code === 0, stdout, stderr, code }));
  });
}

/**
 * 便捷包装：{ ok, text: stdout.trim(), error?: stderr.trim() || `claude -p exited ${code}` }。
 * 失败时错误信息优先取 stderr，其次进程 error，最后用退出码兜底 —— 保证 error 永远有内容。
 * @param {Parameters<spawnClaudeP>[0]} opts
 */
async function runOneShot(opts) {
  const r = await spawnClaudeP(opts);
  if (r.ok) return { ok: true, text: r.stdout.trim() };
  return { ok: false, error: (r.stderr && r.stderr.trim()) || (r.error || `claude -p exited ${r.code}`) };
}

module.exports = { claudePArgs, spawnClaudeP, runOneShot };
