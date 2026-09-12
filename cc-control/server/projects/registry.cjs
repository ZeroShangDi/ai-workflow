'use strict';
/**
 * projects/registry.cjs — 项目注册表：懒建 runtime，缺省 root → boot。
 *
 * 与旧 `createProjectRegistry` 的差别：缓存的是 **runtime**（上下文 + 能力装配），不是裸 ctx。
 * 原因是运行态已经不在 ctx 上 —— 会话态在 runtime.session、宿主在 runtime.runHost，
 * 所以「按项目找到运行态在哪」这件事由 runtime 承载，registry 只负责**寻址与缓存**。
 *
 * 单实例多项目：整个 server 进程只有一份 registry，map 的每个 key 是一个项目根，value 是其 runtime。
 * 请求带 ?p 时经 resolveRuntime 找到/懒建对应 runtime，不带时落 boot —— 这就是「一 server 多项目」的全部机制。
 */

const path = require('node:path');
const { createProjectRuntime } = require('./runtime.cjs');

/**
 * @param {{ env?: object, bootRoot?: string, tmuxFactory?: Function, RunLogger?: Function }} [deps]
 *   bootRoot 缺省项目根（无 ?p 的请求落到这里）；缺省 env.CC_PROJECT 或 cwd
 */
function createProjectRegistry({ env = process.env, bootRoot, tmuxFactory, RunLogger } = {}) {
  const boot = path.resolve(bootRoot || env.CC_PROJECT || process.cwd());
  const map = new Map(); // projectRoot → runtime
  let bootRuntime = null; // boot 上下文最先构造，保证 no-p 落到与旧单槽一致的项目

  /** 归一化项目根：空 → boot；非空 → 绝对路径（保证 map key 唯一，'./a' 与 '/x/a' 不重复建） */
  function norm(root) {
    return root ? path.resolve(root) : boot;
  }

  /** 取某项目的 runtime（懒建）：命中缓存直接返回，否则新建并登记 */
  function runtimeFor(root) {
    const key = norm(root);
    const existing = map.get(key);
    if (existing) return existing;
    const created = createProjectRuntime({ projectRoot: key, env, tmuxFactory, RunLogger });
    map.set(key, created);
    if (key === boot && !bootRuntime) bootRuntime = created; // 记下 boot runtime 备用
    return created;
  }

  /**
   * 解析一次请求的项目 runtime：p（归一化）缺省 → boot；body.projectRoot 兜底。
   *
   * 注意（T1-110）：boot 兜底只对**读**类请求成立 —— 写类缺 ?p 已在入口 400 拒掉。
   * 此前 `p || bodyProjectRoot || projectRoot || boot` 让不带 ?p 的手工 curl 静默写进 boot 项目，
   * 2026-09-10 真机事故即由此而来（暂停了在跑的 run 4 小时）。
   */
  function resolveRuntime({ p, projectRoot, bodyProjectRoot } = {}) {
    return runtimeFor(p || bodyProjectRoot || projectRoot || boot);
  }

  /** 项目清单（供 /status 无 p 时列出所有已注册项目） */
  function list() {
    return [...map.values()].map((rt) => ({
      projectRoot: rt.ctx.projectRoot,
      runSessionName: rt.ctx.runSessionName,
      state: rt.session.state,
      decisionPending: rt.session.decisionPending,
      contextReady: rt.session.contextReady,
    }));
  }

  /** 全部 runtime（供 stop / 空闲判定 / 测试遍历，勿改其 key） */
  function all() {
    return [...map.values()];
  }

  /** 复位全部 runtime 的运行态（测试 / shutdown 用） */
  function reset() {
    for (const rt of map.values()) rt.reset();
  }

  // 预置 boot runtime（构造即注册，保证 /status 无 p 可立即响应且与原行为等价）
  runtimeFor(boot);

  return { bootRoot: boot, runtimeFor, resolveRuntime, list, all, reset, get size() { return map.size; } };
}

module.exports = { createProjectRegistry };
