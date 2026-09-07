import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRunContext, ensureRunLayoutSync, INFRA_ROOT, SID_PATTERN } from '../../src/lib/run-context.cjs';

// run-context 装配器（W1-005 / T1-008）：纯派生，零副作用。
// 输入 { sid?, projectRoot?, env? } → 标识/路径/会话名/端口/settings 引用。
// 所有用例传显式 env（{}）与 projectRoot，避免依赖运行环境里的 CC_* 残留变量。

const ROOT = '/proj/run-root'; // 任意 run 项目根（.awf 宿主）

describe('标识与会话名', () => {
  it('无 sid：runSessionName 回落基础会话名（config runtime.session）', () => {
    const ctx = buildRunContext({ projectRoot: ROOT, env: {} });
    expect(ctx.sid).toBeNull();
    expect(ctx.session).toBe('cc');
    expect(ctx.runSessionName).toBe('cc');
  });

  it('有 sid：runSessionName = `${session}-${sid}`', () => {
    const ctx = buildRunContext({ sid: 'run_a1B-9', projectRoot: ROOT, env: {} });
    expect(ctx.runSessionName).toBe('cc-run_a1B-9');
  });

  it('CC_SESSION 覆盖基础会话名（config 单源默认之上）', () => {
    const ctx = buildRunContext({ projectRoot: ROOT, env: { CC_SESSION: 'wf' } });
    expect(ctx.session).toBe('wf');
    expect(ctx.runSessionName).toBe('wf');
    const sidCtx = buildRunContext({ sid: 'x', projectRoot: ROOT, env: { CC_SESSION: 'wf' } });
    expect(sidCtx.runSessionName).toBe('wf-x');
  });

  it('非法 sid 抛错（防路径/名称注入）', () => {
    for (const bad of ['../evil', 'a/b', 'a b', '']) {
      expect(() => buildRunContext({ sid: bad, projectRoot: ROOT, env: {} })).toThrowError(/非法 sid/);
    }
  });

  it('SID_PATTERN 导出且约束 64 字符内', () => {
    expect(SID_PATTERN.test('a')).toBe(true);
    expect(SID_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(SID_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});

describe('项目根与端口', () => {
  it('projectRoot 参数优先；缺省用 env.CC_PROJECT；再缺省用 cwd', () => {
    expect(buildRunContext({ projectRoot: ROOT, env: {} }).projectRoot).toBe(ROOT);
    expect(buildRunContext({ env: { CC_PROJECT: '/cc-env' } }).projectRoot).toBe('/cc-env');
    expect(buildRunContext({ env: {} }).projectRoot).toBe(process.cwd());
  });

  it('CC_PORT 覆盖端口（默认 config port 8787）', () => {
    expect(buildRunContext({ projectRoot: ROOT, env: {} }).port).toBe(8787);
    expect(buildRunContext({ projectRoot: ROOT, env: { CC_PORT: '9100' } }).port).toBe(9100);
  });

  it('infraRoot = cc-control 包根（经模块位置定位），且含 plugin/config.json 单源', () => {
    const ctx = buildRunContext({ projectRoot: ROOT, env: {} });
    expect(ctx.infraRoot).toBe(INFRA_ROOT);
    expect(path.isAbsolute(ctx.infraRoot)).toBe(true);
    expect(fs.existsSync(path.join(ctx.infraRoot, 'plugin', 'config.json'))).toBe(true);
  });
});

describe('.awf 现行单 run 布局路径', () => {
  const ctx = buildRunContext({ projectRoot: ROOT, env: {} });

  it('核心路径都锚定在 projectRoot/.awf 下', () => {
    expect(ctx.awfDir).toBe(`${ROOT}/.awf`);
    expect(ctx.statePath).toBe(`${ROOT}/.awf/state.json`);
    expect(ctx.runConfigPath).toBe(`${ROOT}/.awf/config.json`);
    expect(ctx.runSettingsPath).toBe(`${ROOT}/.awf/run-settings.json`);
    expect(ctx.contextUsagePath).toBe(`${ROOT}/.awf/context/usage.json`);
    expect(ctx.runMetaPath).toBe(`${ROOT}/.awf/logs/run-meta.json`);
    expect(ctx.logsDir).toBe(`${ROOT}/.awf/logs`);
    expect(ctx.decisionsDir).toBe(`${ROOT}/.awf/decisions/runs`);
  });

  it('messagingSocketPath：缺省 .awf/messaging.sock，CC_MESSAGING_SOCKET 覆盖', () => {
    expect(ctx.messagingSocketPath).toBe(`${ROOT}/.awf/messaging.sock`);
    const over = buildRunContext({ projectRoot: ROOT, env: { CC_MESSAGING_SOCKET: '/tmp/x.sock' } });
    expect(over.messagingSocketPath).toBe('/tmp/x.sock');
  });

  it('runDir 仅在有 sid 时派生（T1-018 每 run 布局锚点）', () => {
    expect(buildRunContext({ projectRoot: ROOT, env: {} }).runDir).toBeUndefined();
    expect(buildRunContext({ sid: 'abc', projectRoot: ROOT, env: {} }).runDir).toBe(`${ROOT}/.awf/runs/abc`);
  });
});

describe('settings / infra 引用', () => {
  const ctx = buildRunContext({ projectRoot: ROOT, env: {} });

  it('插件注册/安装单源与运行脚本路径', () => {
    expect(ctx.pluginSettingsPath).toBe(path.join(ctx.infraRoot, 'plugin', 'settings.json'));
    expect(ctx.infraConfigPath).toBe(path.join(ctx.infraRoot, 'plugin', 'config.json'));
    expect(ctx.serverScriptPath).toBe(path.join(ctx.infraRoot, 'src', 'server', 'server.cjs'));
    expect(ctx.bootstrapScriptPath).toBe(path.join(ctx.infraRoot, 'scripts', 'bootstrap.sh'));
    expect(ctx.repoDevSettingsPath).toBe(path.join(ctx.infraRoot, '.claude', 'settings.json'));
  });

  it('项目级 .mcp.json 锚定在 projectRoot', () => {
    expect(ctx.projectMcpJsonPath).toBe(`${ROOT}/.mcp.json`);
  });
});

describe('每 run 布局 .awf/runs/<sid>/（T1-018）', () => {
  it('有 sid：产出 runDir 及 state/logs/context/decisions/meta 子路径', () => {
    const ctx = buildRunContext({ sid: 'abc', projectRoot: ROOT, env: {} });
    expect(ctx.runDir).toBe(`${ROOT}/.awf/runs/abc`);
    expect(ctx.runStatePath).toBe(`${ROOT}/.awf/runs/abc/state.json`);
    expect(ctx.runLogsDir).toBe(`${ROOT}/.awf/runs/abc/logs`);
    expect(ctx.runContextDir).toBe(`${ROOT}/.awf/runs/abc/context`);
    expect(ctx.runUsagePath).toBe(`${ROOT}/.awf/runs/abc/context/usage.json`);
    expect(ctx.runDecisionsDir).toBe(`${ROOT}/.awf/runs/abc/decisions`);
    expect(ctx.runMetaPath).toBe(`${ROOT}/.awf/runs/abc/meta/run-meta.json`);
  });

  it('无 sid：不派生 run 子路径', () => {
    const ctx = buildRunContext({ projectRoot: ROOT, env: {} });
    expect(ctx.runStatePath).toBeUndefined();
    expect(ctx.runLogsDir).toBeUndefined();
  });

  it('ensureRunLayoutSync 物理建目录（有副作用），无 sid 为空操作', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-rclayout-'));
    const ctx = buildRunContext({ sid: 'r1', projectRoot: root, env: {} });
    const dirs = ensureRunLayoutSync(ctx);
    expect(dirs.length).toBeGreaterThan(0);
    expect(fs.existsSync(ctx.runDir)).toBe(true);
    expect(fs.existsSync(ctx.runLogsDir)).toBe(true);
    expect(fs.existsSync(ctx.runMetaPath ? path.dirname(ctx.runMetaPath) : ctx.runDir)).toBe(true);
    // 无 sid → 不建任何 run 目录
    const legacy = buildRunContext({ projectRoot: root, env: {} });
    expect(ensureRunLayoutSync(legacy)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
