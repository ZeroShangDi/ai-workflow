'use strict';
/**
 * server.cjs — 装配根（唯一入口）
 *
 * 它只做一件事：**把三块装起来** —— 项目注册表、HTTP 面、进程生命周期。
 * 不再是那个 1599 行的单体：路由在 `api/`、生命周期在 `bootstrap/`、每项目能力在 `projects/runtime.cjs`、
 * 编排在 `run/`、决策在 `decision/`、观测在 `observability/`、cc 接入在 `adapters/`。
 *
 * 装配顺序有意义：registry 先建（boot 上下文），api 拿 registry，bootstrap 拿 api 的 handler；
 * `stopServer` 用箭头函数延迟取 bootstrap（打破构造期的循环引用）。
 */

const { createProjectRegistry } = require('./projects/registry.cjs');
const { createApi } = require('./api/index.cjs');
const { createBootstrap } = require('./bootstrap/index.cjs');

// ── 装配：三块按依赖顺序串起来 ──
const registry = createProjectRegistry({ env: process.env }); // ① 注册表（构造即预置 boot runtime）
const BOOT = () => registry.runtimeFor(registry.bootRoot);    // 取 boot 项目 runtime 的简写
const PORT = BOOT().ctx.port;                                 // ② 端口来自 boot 上下文（runtime-config）

const api = createApi({
  registry,                             // api 靠 registry 把 ?p 解析成对应 runtime
  stopServer: () => bootstrap.stop(),   // ③ 箭头延迟取 bootstrap：构造期 bootstrap 还没赋值，直接引用会 undefined
});

// bootstrap 拿 api 的 handler 与端口，反过来 api 的 /shutdown 又要回调 bootstrap.stop —— 用箭头打破这个构造期循环
const bootstrap = createBootstrap({
  registry,
  handler: api.handle,
  onUpgrade: api.handleUpgrade,
  projectRoot: BOOT().ctx.projectRoot,
  sessionName: BOOT().ctx.runSessionName,
});
api.setTouch(bootstrap.touch); // 把「活动刷新」注入 api：每个请求经 touch() 参与空闲回收计时

// ---- lifecycle（对外 API，与旧 server.cjs 同名同义）----

/** 启动 HTTP server；先复位各项目 subagent 记录，再交给 bootstrap 监听 */
function start(port = PORT) {
  for (const rt of registry.all()) rt.subagent.reset();
  return bootstrap.start(port).then((r) => {
    console.log(`[server] listening http://127.0.0.1:${r.port} project=${BOOT().ctx.projectRoot} pid=${process.pid} at ${new Date().toISOString()}`);
    return r;
  });
}

/** 优雅关闭（/shutdown 与 CLI 都走这里） */
function stop() {
  return bootstrap.stop();
}

// ---- test helpers（定向 boot 上下文，与旧单槽导出等价）----

/** 读 boot 会话内存态快照（测试断言用；waiters 恒空——已不在快照里暴露真实等待者） */
function _getState() {
  const rt = BOOT();
  return {
    state: rt.session.state,
    decisionPending: rt.session.decisionPending,
    waiters: [],
    contextReady: rt.session.contextReady,
    decisionGate: rt.session.decisionGate,
    decisionResume: rt.session.decisionResume,
    mainSessionId: rt.session.mainSessionId,
    activeAgents: rt.observability.activeAgentCount(),
  };
}

/** 测试复位：清空注册表（含所有 runtime）+ boot 的 run-meta（防用例间串状态） */
function _resetForTest() {
  registry.reset();
  const { resetRunMeta } = require('./observability/metrics.cjs');
  resetRunMeta(BOOT().ctx.projectRoot);
}

// 导出面：生命周期 + 测试助手 + 一组「转发到 boot 会话」的便捷方法（旧单槽 API 的兼容层）
module.exports = {
  server: bootstrap.server,
  start,
  stop,
  _getState,
  _resetForTest,
  setDecision: (d) => BOOT().session.setDecision(d),
  clearDecision: () => BOOT().session.clearDecision(),
  setReady: () => BOOT().session.setReady(),
  setBusy: () => BOOT().session.setBusy(),
  waitReady: (timeout) => BOOT().session.waitReady(timeout),
};

// 直接以 `node server.cjs` 运行时才真监听（被 require 时只导出，不起进程）
if (require.main === module) {
  for (const rt of registry.all()) rt.subagent.reset();
  bootstrap.listen(PORT);
}
