import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pp = require('../../server/shared/project-paths.cjs');
const runContext = require('../../server/shared/run-context.cjs');

const SERVER = path.resolve(new URL('../../server', import.meta.url).pathname);

// 「.awf 布局」是外部形状，只允许一个知情者（见 .awf/RULES.md）。
// 本文件钉住两件事：访问器形状稳定；以及**全树没有第二处知道这个布局**。

function sourceFiles(dir = SERVER) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'public') out.push(...sourceFiles(full));
    } else if (/\.(cjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 剔除块注释与行注释（注释里提到 `.awf/...` 是正常的，那是在解释而非构造路径） */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

describe('server · 项目布局单源（project-paths）', () => {
  const root = '/tmp/awf-layout';

  it('访问器给出各产物的位置', () => {
    expect(pp.awfDir(root)).toBe(`${root}/.awf`);
    expect(pp.stateFilePath(root)).toBe(`${root}/.awf/state.json`);
    expect(pp.stateLockPath(root)).toBe(`${root}/.awf/state.lock`);
    expect(pp.configFilePath(root)).toBe(`${root}/.awf/config.json`);
    expect(pp.logsDir(root)).toBe(`${root}/.awf/logs`);
    expect(pp.runMetaPath(root)).toBe(`${root}/.awf/logs/run-meta.json`);
    expect(pp.contextUsagePath(root)).toBe(`${root}/.awf/context/usage.json`);
    expect(pp.handoffPath(root)).toBe(`${root}/.awf/context/handoff.md`);
    expect(pp.versionsDir(root)).toBe(`${root}/.awf/versions`);
    expect(pp.decisionsRunsDir(root)).toBe(`${root}/.awf/decisions/runs`);
    expect(pp.dynamicPlanningDir(root)).toBe(`${root}/.awf/dynamic-planning`);
  });

  it('每 run 分片带 sid 参数（拼法不泄漏给调用方）', () => {
    expect(pp.runStateFilePath(root, 'r1')).toBe(`${root}/.awf/runs/r1/state.json`);
    expect(pp.runStateLockPath(root, 'r1')).toBe(`${root}/.awf/runs/r1/state.lock`);
    expect(pp.runsDir(root)).toBe(`${root}/.awf/runs`);
  });

  it('run-context 的路径表与访问器同源（不再各拼各的）', () => {
    const ctx = runContext.buildRunContext({ projectRoot: root, env: {} });
    expect(ctx.statePath).toBe(pp.stateFilePath(root));
    expect(ctx.runConfigPath).toBe(pp.configFilePath(root));
    expect(ctx.runSettingsPath).toBe(pp.settingsFilePath(root));
    expect(ctx.logsDir).toBe(pp.logsDir(root));
    expect(ctx.runMetaPath).toBe(pp.runMetaPath(root));
    expect(ctx.contextUsagePath).toBe(pp.contextUsagePath(root));
    expect(ctx.decisionsDir).toBe(pp.decisionsRunsDir(root));
  });

  it('有 sid 时：每 run 分片键生效，覆盖同名键（现状记录，非期望语义）', () => {
    // run-context 的单 run 表与 perRun 表共用 `runMetaPath` 这个名字：有 sid 时 perRun 覆盖它，
    // 于是 `.awf/logs/run-meta.json` 在那个 ctx 上取不到。消费方（shared/store.cjs）用的是**无 sid** 的
    // storeCtx，所以当前无害；但同一个键两种含义是隐患 —— 谁拿 nameCtx 去读就会静默拿到另一个文件。
    const noSid = runContext.buildRunContext({ projectRoot: root, env: {} });
    const withSid = runContext.buildRunContext({ projectRoot: root, sid: 'r1', env: {} });
    expect(noSid.runMetaPath).toBe(pp.runMetaPath(root));
    expect(withSid.runMetaPath).toBe(`${root}/.awf/runs/r1/meta/run-meta.json`);
    expect(withSid.runMetaPath).not.toBe(noSid.runMetaPath);
    // 其余单 run 键不受影响（名字不同，不冲突）
    expect(withSid.statePath).toBe(noSid.statePath);
    expect(withSid.logsDir).toBe(noSid.logsDir);
  });

  it('全树只有 project-paths.cjs 知道 .awf 布局（防回退）', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      if (file.endsWith(path.join('shared', 'project-paths.cjs'))) continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      // 形态一：path.join(..., '.awf', ...)；形态二：把 '.awf' 拼进数组常量
      const hits = code.match(/path\.join\([^)]*["']\.awf["'][^)]*\)|\[\s*["']\.awf["']/g);
      if (hits) offenders.push(`${path.relative(SERVER, file)}: ${[...new Set(hits)].join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
