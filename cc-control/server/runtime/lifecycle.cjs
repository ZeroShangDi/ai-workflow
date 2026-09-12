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

/**
 * @param {object} deps
 * @param {object} deps.registry   项目注册表（all() → runtime，读 runHost 判活跃）
 * @param {Function} deps.handler  (req, res) → Promise（即 api.handle）
 * @param {Function} deps.onUpgrade (req, socket) → void
 * @param {string} deps.projectRoot boot 项目根（启动横幅用）
 * @param {string} deps.sessionName boot 会话名（启动横幅用）
 */
function createBootstrap({ registry, handler, onUpgrade, projectRoot, sessionName }) {
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
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
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
