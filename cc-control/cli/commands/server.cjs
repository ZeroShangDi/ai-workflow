'use strict';
/**
 * cli/commands/server.cjs — awf server start|stop|status
 *
 * 纯进程/HTTP 操作，无编排：start 拉起常驻 server，stop 请求它优雅退出，status 打印快照。
 */

const { buildContext } = require('../lib/context.cjs');
const { createClient } = require('../lib/client.cjs');
const session = require('../lib/session.cjs');

async function serverCommand(action) {
  const ctx = buildContext(process.cwd());

  if (action === 'start') {
    const r = await session.ensureServer(ctx);
    console.log(r.reused ? `已在运行（端口 ${ctx.port}）` : `已启动（端口 ${ctx.port}，日志 ${r.logPath}）`);
    return;
  }

  if (action === 'stop') {
    const r = await createClient({ port: ctx.port }).request('POST', '/shutdown', undefined, { timeoutMs: 3000 });
    console.log(r?.ok ? '已请求关闭' : `关闭失败：${r?.error || '未知错误'}`);
    return;
  }

  if (action === 'status') {
    const c = createClient({ port: ctx.port, project: ctx.projectRoot });
    const st = await c.getStatus();
    if (st?.ok === false) { console.log(`未运行（端口 ${ctx.port}）：${st.error}`); return; }
    console.log(JSON.stringify(st, null, 2));
    return;
  }

  console.error(`未知动作：${action}（可用 start | stop | status）`);
  process.exit(2);
}

module.exports = { serverCommand };
