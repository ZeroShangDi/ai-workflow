import { describe, it, expect } from 'vitest';
import { STRIP_ENV, buildSessionEnv, buildClaudeArgs, buildTmuxCommand, runSettingsPath } from '../../src/server/session-launch.cjs';

describe('session-launch — claude 会话启动构建（cc/host 基座）', () => {
  const ctx = { runSessionName: 'cc-r1' };

  it('buildSessionEnv：注入 CC_SESSION 并剥离 telemetry 变量', () => {
    const env = buildSessionEnv(ctx, { baseEnv: { A: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' } });
    expect(env.CC_SESSION).toBe('cc-r1');
    expect(env.DISABLE_TELEMETRY).toBeUndefined();
    expect(env.DO_NOT_TRACK).toBeUndefined();
    expect(STRIP_ENV).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
  });

  it('buildClaudeArgs：bypassPermissions + settings', () => {
    const args = buildClaudeArgs(ctx, { settingsPath: '/s.json' });
    expect(args).toContain('claude');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--settings');
    expect(args).toContain('/s.json');
    expect(args).not.toContain('--messaging-socket-path');
  });

  it('buildTmuxCommand：tmux new-session + env -u + claude（含会话名/settings）', () => {
    const cmd = buildTmuxCommand(ctx, { workdir: '/w', settingsPath: '/w/.awf/run-settings.json' });
    expect(cmd.startsWith('tmux new-session -d -s "cc-r1"')).toBe(true);
    expect(cmd).toContain('-c "/w"');
    expect(cmd).toContain('env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
    expect(cmd).toContain('CC_SESSION="cc-r1"');
    expect(cmd).toContain('--permission-mode bypassPermissions');
    expect(cmd).not.toContain('--messaging-socket-path');
    expect(cmd).toContain('--settings "/w/.awf/run-settings.json"');
  });

  it('runSettingsPath 落在 .awf/run-settings.json', () => {
    expect(runSettingsPath('/proj')).toBe('/proj/.awf/run-settings.json');
  });

  it('buildSessionEnv：ctx 带 projectRoot/sid 时注入 CC_PROJECT/CC_SID（多项目路由）', () => {
    const ctx2 = { runSessionName: 'cc-pabc123', projectRoot: '/proj/b', sid: 'pabc123' };
    const env = buildSessionEnv(ctx2, { baseEnv: { A: '1' } });
    expect(env.CC_SESSION).toBe('cc-pabc123');
    expect(env.CC_PROJECT).toBe('/proj/b');
    expect(env.CC_SID).toBe('pabc123');
    expect(env.A).toBe('1');
  });

  it('buildSessionEnv：仅 projectRoot（无 sid）只注入 CC_PROJECT', () => {
    const env = buildSessionEnv({ runSessionName: 'cc-x', projectRoot: '/proj/b' }, { baseEnv: {} });
    expect(env.CC_PROJECT).toBe('/proj/b');
    expect(env.CC_SID).toBeUndefined();
  });

  it('buildTmuxCommand：envPrefix 携带 CC_PROJECT/CC_SID', () => {
    const ctx2 = { runSessionName: 'cc-pabc123', projectRoot: '/proj/b', sid: 'pabc123' };
    const cmd = buildTmuxCommand(ctx2, { workdir: '/proj/b', settingsPath: '/proj/b/.awf/run-settings.json' });
    expect(cmd).toContain('CC_PROJECT="/proj/b"');
    expect(cmd).toContain('CC_SID="pabc123"');
    expect(cmd).toContain('CC_SESSION="cc-pabc123"');
  });
});
