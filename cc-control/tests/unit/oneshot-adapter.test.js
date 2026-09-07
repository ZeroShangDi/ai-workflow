import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { claudePArgs, spawnClaudeP, runOneShot } from '../../src/adapters/oneshot.cjs';

/** 构造返回可驱动 close/error 的假 spawn */
function fakeSpawnOf({ code, stdout = '', stderr = '', error = null, argsRef = {} }) {
  return (cmd, args, opts) => {
    argsRef.args = args;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', stdout);
      if (stderr) proc.stderr.emit('data', stderr);
      if (error) proc.emit('error', new Error(error));
      else proc.emit('close', code);
    });
    return proc;
  };
}

describe('oneshot adapter（claude -p 收口）', () => {
  it('claudePArgs：-p + 额外 args + prompt', () => {
    expect(claudePArgs('p', { args: ['--safe-mode', '--no-session-persistence'] })).toEqual(['-p', '--safe-mode', '--no-session-persistence', 'p']);
    expect(claudePArgs('p')).toEqual(['-p', 'p']);
  });

  it('spawnClaudeP：ok=true 收集 stdout/stderr；传入 NO_COLOR + safe args', async () => {
    const ref = {};
    const spawn = fakeSpawnOf({ code: 0, stdout: '  hi  ', stderr: 'warn' , argsRef: ref });
    const r = await spawnClaudeP({ prompt: 'x', args: ['--safe-mode'], spawn });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('  hi  ');
    expect(r.code).toBe(0);
    expect(ref.args).toEqual(['-p', '--safe-mode', 'x']);
  });

  it('spawnClaudeP error → { ok:false, error }；非零 → ok:false', async () => {
    const e = await spawnClaudeP({ prompt: 'x', spawn: fakeSpawnOf({ code: null, error: 'boom' }) });
    expect(e.ok).toBe(false);
    expect(e.error).toBe('boom');
    const c = await spawnClaudeP({ prompt: 'x', spawn: fakeSpawnOf({ code: 1, stderr: 'oops' }) });
    expect(c.ok).toBe(false);
    expect(c.code).toBe(1);
  });

  it('runOneShot：ok→text trimmed；非 ok→stderr 优先否则 exited', async () => {
    const ok = await runOneShot({ prompt: 'x', spawn: fakeSpawnOf({ code: 0, stdout: '  hi  ' }) });
    expect(ok).toEqual({ ok: true, text: 'hi' });
    const err = await runOneShot({ prompt: 'x', spawn: fakeSpawnOf({ code: 1, stderr: 'oops' }) });
    expect(err.ok).toBe(false);
    expect(err.error).toBe('oops');
    const cErr = await runOneShot({ prompt: 'x', spawn: fakeSpawnOf({ code: 2 }) });
    expect(cErr.error).toContain('claude -p exited 2');
  });
});
