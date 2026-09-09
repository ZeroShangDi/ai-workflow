import { describe, it, expect } from 'vitest';

import { createHost } from '../../src/server/host.cjs';

function stubExec(outputs = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push(args);
    if (args[0] === 'has-session' && outputs.hasSession === false) {
      const e = new Error('no session');
      e.code = 1;
      throw e;
    }
    if (args[0] === 'capture-pane') return outputs.capture ?? 'pane';
    return '';
  };
  return { fn, calls };
}

describe('createHost — host 基座（会话名参数化 cc-<sid>）', () => {
  it('原语按传入 sessionName 命中 tmux 命令', () => {
    const { fn, calls } = stubExec();
    const host = createHost({ sessionName: 'cc-r1', execFileSync: fn });
    expect(host.sessionName).toBe('cc-r1');
    host.hasSession();
    host.sendText('hi');
    host.sendEnter();
    host.sendCtrlC();
    expect(calls).toEqual([
      ['has-session', '-t', 'cc-r1'],
      ['send-keys', '-t', 'cc-r1', '-l', 'hi'],
      ['send-keys', '-t', 'cc-r1', 'Enter'],
      ['send-keys', '-t', 'cc-r1', 'C-c'],
    ]);
  });

  it('hasSession：无会话抛错 → false；capture 返回 pane 文本', () => {
    const no = stubExec({ hasSession: false });
    expect(createHost({ sessionName: 'cc', execFileSync: no.fn }).hasSession()).toBe(false);
    const ok = stubExec({ capture: 'pane text' });
    expect(createHost({ sessionName: 'cc', execFileSync: ok.fn }).capture()).toBe('pane text');
  });

  it('缺省 sessionName = cc（单 run 兼容）', () => {
    const { fn } = stubExec();
    const host = createHost({ execFileSync: fn });
    expect(host.sessionName).toBe('cc');
  });
});
