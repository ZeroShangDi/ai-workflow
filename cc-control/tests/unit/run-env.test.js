import { describe, it, expect } from 'vitest';

import {
  commandConfigEnv,
  runSessionEnv,
  serverSpawnEnv,
  withoutRunIdentity,
} from '../../src/lib/run-env.cjs';

const PARENT = {
  PATH: '/bin',
  CC_SESSION: 'cc-paaaaaaaaaaaa',
  CC_PROJECT: '/parent',
  CC_WORKDIR: '/parent',
  CC_AWF_STATE_SERVER: '1',
  CC_SID: 'parent-run',
  CC_PORT: '8787',
};

describe('run 环境边界', () => {
  it('清除父 run 身份但保留控制平面端口和普通环境', () => {
    expect(withoutRunIdentity(PARENT)).toEqual({ PATH: '/bin', CC_PORT: '8787' });
    expect(PARENT.CC_SESSION).toBe('cc-paaaaaaaaaaaa'); // 不修改输入
  });

  it('run 会话内的新命令不把完整 CC_SESSION 当作基础 session', () => {
    expect(commandConfigEnv(PARENT)).toEqual({ PATH: '/bin', CC_PORT: '8787' });
  });

  it('顶层用户显式 CC_SESSION 仍保留覆盖语义', () => {
    expect(commandConfigEnv({ CC_SESSION: 'workflow', CC_PORT: '9000' })).toEqual({
      CC_SESSION: 'workflow', CC_PORT: '9000',
    });
  });

  it('server 子进程只接收基础 session 和目标项目身份', () => {
    const env = serverSpawnEnv({
      env: PARENT,
      projectRoot: '/child',
      port: 8899,
      baseSession: 'cc',
    });
    expect(env).toEqual({
      PATH: '/bin',
      CC_SESSION: 'cc',
      CC_PORT: '8899',
      CC_PROJECT: '/child',
    });
  });

  it('tmux 子会话只接收本次完整 session，且不泄漏父 CC_SID', () => {
    const env = runSessionEnv({
      env: PARENT,
      projectRoot: '/child',
      port: 8899,
      sessionName: 'cc-pbbbbbbbbbbbb',
    });
    expect(env).toEqual({
      PATH: '/bin',
      CC_SESSION: 'cc-pbbbbbbbbbbbb',
      CC_WORKDIR: '/child',
      CC_PROJECT: '/child',
      CC_PORT: '8899',
      CC_AWF_STATE_SERVER: '1',
    });
    expect(env).not.toHaveProperty('CC_SID');
  });
});
