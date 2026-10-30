'use strict';

/**
 * auto-recovery.cjs — Run 失败后启动独立的 w-monitor CC。
 *
 * w-monitor 仍拥有全部侦查/修复/验证策略。本模块只创建独立 tmux 会话、启动现有命令，
 * 并在该监控实例写出 monitor_exited 后退出并回收自己创建的会话。
 */

const fs = require('node:fs');
const path = require('node:path');
const { projectSessionEnv } = require('../../shared/session-env.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STARTUP_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 10_000;
const POLL_MS = 1_000;

function appendedEvents(file, offset) {
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return { offset, events: [] };
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
      const events = buffer.subarray(0, bytes).toString('utf8').split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      return { offset: size, events };
    } finally { fs.closeSync(fd); }
  } catch {
    return { offset, events: [] };
  }
}

function createAutoRecovery({ ctx, sessionFor, forgetSession, observability } = {}) {
  let inFlight = false;
  const ownedSessions = new Set();

  async function waitForMonitorExit({ sessionName, logPath, offset }) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let started = false;
    for (;;) {
      const read = appendedEvents(logPath, offset);
      offset = read.offset;
      for (const event of read.events) {
        if (event.monitorSession !== sessionName) continue;
        if (event.event === 'monitor_started') started = true;
        if (event.event === 'monitor_exited') return true;
      }
      if (!ctx.adapters.ports.session.exists({ sessionName })) return false;
      if (!started && Date.now() >= deadline) {
        observability.notice('monitor', 'warn', `独立 w-monitor 会话 ${sessionName} 启动未完成，回收该会话`);
        return false;
      }
      await sleep(POLL_MS);
    }
  }

  async function closeOwnedSession(sessionName, host) {
    if (!ownedSessions.has(sessionName)) return;
    try {
      if (ctx.adapters.ports.session.exists({ sessionName })) {
        try { await host.sendPrompt('/exit'); } catch (error) {
          observability.notice('monitor', 'warn', `独立 w-monitor 会话 ${sessionName} 未响应 /exit：${error.message}`);
        }
        const deadline = Date.now() + CLOSE_TIMEOUT_MS;
        while (Date.now() < deadline && ctx.adapters.ports.session.exists({ sessionName })) await sleep(POLL_MS);
      }
      if (ctx.adapters.ports.session.exists({ sessionName })) {
        ctx.adapters.ports.session.kill({ sessionName });
      }
    } catch (error) {
      observability.notice('monitor', 'warn', `回收独立 w-monitor 会话 ${sessionName} 失败：${error.message}`);
    } finally {
      ownedSessions.delete(sessionName);
    }
  }

  async function onRunEvent(event) {
    if (event?.type !== 'run.stopped' || event.payload?.status !== 'error') return false;
    if (inFlight || ctx.adapter !== 'cc') return false;

    if (!ctx.adapters.ports.session.exists()) return false;

    const sessionFactory = ctx.adapters.impls?.host;
    if (typeof sessionFactory !== 'function') return false;

    inFlight = true;
    const sessionId = `monitor-${require('node:crypto').randomUUID().replaceAll('-', '')}`;
    const sessionName = `${ctx.nameCtx.session}-${sessionId}`;
    const host = sessionFactory({ sessionName });
    const logPath = path.join(ctx.logsDir, 'w-monitor.jsonl');
    let offset = 0;
    try { offset = fs.statSync(logPath).size; } catch { /* 首次启动时日志尚不存在 */ }

    try {
      const env = projectSessionEnv(process.env, {
        projectRoot: ctx.projectRoot,
        port: ctx.port,
        sessionName,
      });
      env.CC_SID = sessionId; // 监控 CC 的 hooks 只更新自己的槽，不翻动主 Run 的 ready/busy 状态
      env.AWF_STATE_SID = 'project'; // state MCP 忽略监控 sid，读写项目主 state
      env.AWF_SESSION_TARGET_SID = 'project'; // session MCP 指向项目主 Run 的 CC
      env.CC_CLOSE_SESSION_ON_EXIT = '1'; // Claude 退出后只回收这个独立 tmux session
      ownedSessions.add(sessionName); // start 即使中途抛错，也只回收这个随机生成的专属会话名
      ctx.adapters.ports.session.start({ projectRoot: ctx.projectRoot, env });

      const monitorSession = sessionFor(sessionId);
      const sessionStartAt = Date.now();
      while (monitorSession.sessionSeq < 1 && Date.now() - sessionStartAt < STARTUP_TIMEOUT_MS) {
        if (!ctx.adapters.ports.session.exists({ sessionName })) throw new Error('独立监控会话在 SessionStart 前已退出');
        await sleep(POLL_MS);
      }
      if (monitorSession.sessionSeq < 1) throw new Error('独立监控会话等待 SessionStart 超时');

      await host.sendPrompt(
        `AWF_AUTO_MONITOR_SESSION=${sessionName}\n`
        + '这是 AWF Run 失败后临时启动的独立监控会话。请先读取 state；若仍有 pending/active 任务且 mode 为 idle，'
        + '调用 awf_mode 将 mode 设为 run，然后立即运行现有 /w-monitor 命令。它会侦查主 Run 的 CC，'
        + '需要时按既有流程暂停、修复、复核或恢复。不要关闭、停止或向主 Run 的 CC 发送未经 w-monitor 工具批准的操作。'
        + `本实例的监控日志事件请附加 monitorSession=${sessionName}。w-monitor 写出 monitor_exited 后退出本 CC（/exit）。`,
      );
      observability.notice('monitor', 'warn', `Run ${event.runId || ''} 失败，已启动独立 w-monitor CC：${sessionName}`);

      const exited = await waitForMonitorExit({ sessionName, logPath, offset });
      if (exited) observability.notice('monitor', 'info', `独立 w-monitor ${sessionName} 已完成侦查/修复并退出`);
      await closeOwnedSession(sessionName, host);
      return true;
    } catch (error) {
      observability.notice('monitor', 'warn', `自动启动 w-monitor 失败：${error.message}`);
      await closeOwnedSession(sessionName, host);
      return false;
    } finally {
      forgetSession?.(sessionId);
      inFlight = false;
    }
  }

  function stop() {
    for (const sessionName of [...ownedSessions]) {
      try { ctx.adapters.ports.session.kill({ sessionName }); } catch { /* 关闭时尽力回收自有会话 */ }
      ownedSessions.delete(sessionName);
    }
  }

  return { onRunEvent, stop, get inFlight() { return inFlight; } };
}

module.exports = { createAutoRecovery, appendedEvents, STARTUP_TIMEOUT_MS, CLOSE_TIMEOUT_MS, POLL_MS };
