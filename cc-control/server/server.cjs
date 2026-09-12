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

const registry = createProjectRegistry({ env: process.env });
const BOOT = () => registry.runtimeFor(registry.bootRoot);
const PORT = BOOT().ctx.port;

const api = createApi({
  registry,
  stopServer: () => bootstrap.stop(),
});

const bootstrap = createBootstrap({
  registry,
  handler: api.handle,
  onUpgrade: api.handleUpgrade,
  projectRoot: BOOT().ctx.projectRoot,
  sessionName: BOOT().ctx.runSessionName,
});
api.setTouch(bootstrap.touch);

// ---- lifecycle（对外 API，与旧 server.cjs 同名同义）----

function start(port = PORT) {
  for (const rt of registry.all()) rt.subagent.reset();
  return bootstrap.start(port).then((r) => {
    console.log(`[server] listening http://127.0.0.1:${r.port} project=${BOOT().ctx.projectRoot} pid=${process.pid} at ${new Date().toISOString()}`);
    return r;
  });
}

function stop() {
  return bootstrap.stop();
}

// ---- test helpers（定向 boot 上下文，与旧单槽导出等价）----

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

function _resetForTest() {
  registry.reset();
  const { resetRunMeta } = require('./observability/metrics.cjs');
  resetRunMeta(BOOT().ctx.projectRoot);
}

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

if (require.main === module) {
  for (const rt of registry.all()) rt.subagent.reset();
  bootstrap.listen(PORT);
}
