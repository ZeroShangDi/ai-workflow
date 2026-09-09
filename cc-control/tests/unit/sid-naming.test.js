import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRunRegistry } = require('../../src/lib/run-registry.cjs');
const { createHost } = require('../../src/server/host.cjs');
const { buildSessionEnv, buildTmuxCommand } = require('../../src/server/session-launch.cjs');

// T1-069：tmux/目录按 cc-<sid>/.awf/runs/<sid> 命名接入。
// 注：messaging/inbox 已于 T1-065 删除，无 <sid>.sock 产物；命名接入集中在会话名 + per-run 目录。

describe('T1-069 sid 命名接入（cc-<sid> + .awf/runs/<sid>/）', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sid-'));
    fs.mkdirSync(path.join(tmp, '.awf'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const noopFactory = () => ({ sessionName: '', hasSession: () => false });

  it('registry slot sid → 会话名 cc-<sid>，与单 run 现状槽（无 sid）不冲突', () => {
    const reg = createRunRegistry({ projectRoot: tmp, adaptersFactory: noopFactory });
    const d = reg.slot();
    const a = reg.slot('a');
    const b = reg.slot('b');
    expect(a.ctx.runSessionName.endsWith('-a')).toBe(true);
    expect(b.ctx.runSessionName.endsWith('-b')).toBe(true);
    expect(a.ctx.runSessionName).not.toBe(b.ctx.runSessionName);
    expect(a.ctx.runSessionName).not.toBe(d.ctx.runSessionName); // 不与单 run 会话冲突
  });

  it('ensureLayout(sid) → 按 .awf/runs/<sid>/ 物化 per-run 目录；无 sid 槽不派生', () => {
    const reg = createRunRegistry({ projectRoot: tmp, adaptersFactory: noopFactory });
    const dirs = reg.ensureLayout('r1');
    const runDir = path.join(tmp, '.awf', 'runs', 'r1');
    expect(dirs).toEqual(expect.arrayContaining([
      runDir, path.join(runDir, 'logs'), path.join(runDir, 'context'),
      path.join(runDir, 'decisions'), path.join(runDir, 'meta'),
    ]));
    for (const d of dirs) expect(fs.existsSync(d)).toBe(true);
    // 单 run 现状槽（无 sid）：不派生 per-run 目录
    expect(reg.ensureLayout()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, '.awf', 'runs'))).toBe(true); // r1 已建
  });

  it('tmux/host 原语按 cc-<sid> 绑定（host.sessionName + session-launch 命令）', () => {
    const reg = createRunRegistry({ projectRoot: tmp, adaptersFactory: noopFactory });
    const slot = reg.slot('a');
    const host = createHost({ sessionName: slot.ctx.runSessionName });
    expect(host.sessionName).toBe(slot.ctx.runSessionName);
    expect(host.sessionName.endsWith('-a')).toBe(true);

    const env = buildSessionEnv(slot.ctx);
    expect(env.CC_SESSION).toBe(slot.ctx.runSessionName);
    const cmd = buildTmuxCommand(slot.ctx, { workdir: tmp, settingsPath: path.join(tmp, '.awf', 'run-settings.json') });
    expect(cmd.startsWith(`tmux new-session -d -s "${slot.ctx.runSessionName}"`)).toBe(true);
    expect(cmd).toContain(`CC_SESSION="${slot.ctx.runSessionName}"`);
  });
});
