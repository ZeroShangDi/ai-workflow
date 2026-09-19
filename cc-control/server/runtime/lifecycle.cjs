'use strict';
/**
 * bootstrap/index.cjs — 进程生命周期：启动 / 端口 / 空闲回收 / 优雅关闭
 *
 * 从 server.cjs 的 `start` / `stop` / `require.main` 段提取。它只依赖两样东西：
 *   - registry：遍历项目（空闲判定要问「还有没有 run 在跑」）
 *   - 一个 http server 实例（由装配根创建并注入，本模块不关心它挂了多少路由）
 *
 * 空闲回收语义（不变）：**全部项目都无 run 驱动**且空闲超时 → 自动关闭。
 * 「有 run 在跑」优先于空闲计时 —— 长任务读日志不算活动，但 run 活着就不能被回收。
 */

const http = require('node:http');
const { isIdleDue, idleDefaultMs } = require('./idle.cjs');

/** 关停兜底上限：长连接没被关干净时，最多等这么久也要给出结论（实测注释见 stop()） */
const CLOSE_FALLBACK_MS = 3000;

/**
 * @param {object} deps
 * @param {object} deps.registry   项目注册表（all() → runtime，读 runHost 判活跃）
 * @param {Function} deps.handler  (req, res) → Promise（即 api.handle）
 * @param {Function} deps.onUpgrade (req, socket) → void
 * @param {string} deps.projectRoot boot 项目根（启动横幅用）
 * @param {string} deps.sessionName boot 会话名（启动横幅用）
 * @param {Array<Function>} [deps.closeTransports] 关停前必须先关掉的**长连接**（由装配根注入）
 */
function createBootstrap({ registry, handler, onUpgrade, projectRoot, sessionName, closeTransports = [] }) {
  const server = http.createServer(handler);
  server.on('upgrade', onUpgrade || (() => {})); // 未注入 upgrade 处理器时挂空函数，避免事件无监听者报错

  let lastActivityAt = Date.now();
  /** 刷新最近活动时间（server 每次收到请求都会调用，空闲回收据此判「还有人在用」） */
  const touch = () => { lastActivityAt = Date.now(); };

  /** 任一项目有 run 在驱动（空闲回收判定） */
  function anyHostActive() {
    for (const rt of registry.all()) {
      if (!rt.runHost) continue;
      try {
        const snap = rt.runHost.snapshot();
        if ((snap?.runs || []).some((r) => r.status === 'queued' || r.status === 'running')) return true;
      } catch { /* ignore */ }
    }
    return false;
  }

  /**
   * 在 127.0.0.1 监听：port=0 时由系统分配（resolve 回真实端口）。
   * 一次性 error 监听用于捕获 EADDRINUSE 等启动失败 → reject；成功后立即移除，
   * 否则后续运行期错误会被这个「只该管启动」的 handler 误当启动失败。
   */
  function start(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  /** 停止：先停各项目 runHost（安全点收尾不再驱动），再关 http server。
   *  closeAllConnections 强制断开 keep-alive 长连接，否则 server.close 会一直等连接自然结束。
   *  @returns {Promise<void>} close 回调触发后 resolve */
  function stop() {
    for (const rt of registry.all()) {
      if (rt.runHost) { try { rt.runHost.stop(); } catch { /* ignore */ } }
    }
    // ① 先关长连接（尤其插件的 WS —— `upgrade` 上来的 socket **不在 http server 的连接表里**，
    //    `closeAllConnections()` 管不到它）。不关它，`server.close(cb)` 的回调要等 3s 兜底才触发。
    //    关闭器由**装配根**注入（server.cjs 同时认识 web 与 runtime），runtime 不反向依赖 web 层。
    //
    // ①② 两条**都是必需的**，实测（带一条 WS 连接 / 空闲阈值 0.8s / 检查粒度 0.3s）：
    //    两条都在 → 1027ms 退出；只留 ② → 4097ms（等满兜底）；两条都不要 → **永不退出**
    //    （`server.close(cb)` 回调不触发 → `stop().then(exit)` 不执行 → 进程不再 listen 却活着，
    //     插件仍连着它，新 server 收不到插件 —— 表现是 `awf plan` 报「指令通道未连接」而
    //     `awf server start` 说「已在运行」）。别把其中任何一条当冗余删掉。
    for (const close of closeTransports) {
      try { close(); } catch { /* 单个失败不阻断关停 */ }
    }
    // ② 兜底：万一还有别的长连接吊着，关停也不能无限等 —— Promise 必须给出结论
    //    （空闲回收的 `stop().then(() => process.exit(0))` 全靠它）。
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      server.close(finish);
      if (server.closeAllConnections) server.closeAllConnections();
      setTimeout(finish, CLOSE_FALLBACK_MS).unref();
    });
  }

  /** 常驻入口：监听 + 启动横幅 + 空闲回收定时器 */
  async function listen(port) {
    const { port: actual } = await start(port);
    console.log(`cc-control listening on http://127.0.0.1:${actual} (session '${sessionName}')`
      + ` pid=${process.pid} project=${projectRoot} at ${new Date().toISOString()}`);

    const idleMs = idleDefaultMs();
    // 只有阈值 >0 才启用空闲回收（0 = 禁用，用于测试或人工管理生命周期）
    if (idleMs > 0) {
      const idleCheckMs = Number(process.env.CC_SERVER_IDLE_CHECK_MS || 60000);
      const idleTimer = setInterval(() => {
        if (anyHostActive()) return; // 有 run 在驱动就不算空闲：长任务期间即使无请求也不能被回收
        if (isIdleDue({ now: Date.now(), lastActivityAt, idleMs })) {
          clearInterval(idleTimer);
          console.log(`[server] 空闲 ${Math.round(idleMs / 60000)}min 无活动且无 run 驱动，自动关闭（常驻回收）`);
          stop().then(() => process.exit(0));
        }
      }, idleCheckMs);
      if (idleTimer.unref) idleTimer.unref(); // 不阻止进程退出：进程要退时不该被这个 timer 拽住
    }
    return { port: actual, server };
  }

  return { server, start, stop, listen, touch, anyHostActive };
}

module.exports = { createBootstrap };
