'use strict';
/**
 * observability/subagent.cjs — 子 agent 观测与落账
 *
 * 抽象动机：原 server.cjs 里「解析子 agent RESULT → 写 state」和「往 jsonl 记事件」是八个散落函数，
 * 且都以裸 `pcx` 为首参到处穿透。这里收敛成一个 recorder 对象：**它需要什么就显式声明什么**
 * （paths + stores），不再依赖整个 pcx。
 *
 * 边界：只做「子 agent 的观测与落账」，不含调度/派发（那是 run 域），也不含日志落盘（那是 run-logger）。
 */

const fs = require('node:fs');
const path = require('node:path');
const extract = require('../adapters/cc/extract.cjs');

/**
 * @param {{ paths: { event: string, failed: string, needsInput: string }, stores: { state: object } }} deps
 *   paths  三个 jsonl 落点（可在 pcx 里，也可测试注入临时路径）
 *   stores state 存储（子 agent 落账写 state）
 */
function createSubagentRecorder({ paths, stores } = {}) {
  /** 解析子 Agent 固定格式 RESULT（`RESULT: {json}`）；成功返回结果对象，失败 null */
  function parseResult(body) {
    return extract.parseSubagentResult(body?.last_assistant_message);
  }

  /** 解析 NEEDS_INPUT（`NEEDS_INPUT: {json}`）→ { taskId, question, options?, context? }，否则 null */
  function parseNeedsInput(body) {
    return extract.parseNeedsInput(body?.last_assistant_message);
  }

  function appendJsonl(file, record) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    } catch (e) {
      console.log(`[subagent-log] ${e.message}`);
    }
  }

  /** 子 agent 生命周期事件（Start/Stop 原样留档） */
  function logEvent(event, body) {
    appendJsonl(paths.event, { ts: new Date().toISOString(), event, body });
  }

  /** 落账失败留档（供 CLI 补发判定） */
  function logFailure(body, settled) {
    appendJsonl(paths.failed, {
      ts: new Date().toISOString(),
      agentId: body?.agent_id || body?.session_id || 'unknown',
      reason: settled?.reason,
      resultTaskId: (parseResult(body) || {}).taskId || null,
    });
  }

  /** 上抛决策留档 */
  function logNeedsInput(body, needs) {
    appendJsonl(paths.needsInput, {
      ts: new Date().toISOString(),
      agentId: body?.agent_id || body?.session_id || 'unknown',
      taskId: needs.taskId,
      question: needs.question,
      options: needs.options || [],
      context: needs.context || null,
    });
  }

  /** 每次 run 启动清空补发/决策日志，避免跨 run 残留触发伪补发 */
  function reset() {
    for (const p of [paths.failed, paths.needsInput]) {
      try { fs.rmSync(p, { force: true }); } catch { /* 无权限时忽略 */ }
    }
  }

  /**
   * SubagentStop 落账：写 state（task status + exec.result/files/commits/verdict/architecture）。
   * @returns {{ ok: boolean, taskId?: string, status?: string, reason?: string, recoverable?: boolean }}
   */
  function settle(body) {
    const result = parseResult(body);
    if (!result) return { ok: false, reason: 'no valid RESULT in last_assistant_message' };
    let out;
    stores.state.updateSync((s) => {
      if (!s) { out = { ok: false, reason: 'state.json unreadable', recoverable: false }; return false; }
      const task = (s.tasks || []).find((t) => t.id === result.taskId);
      if (!task) { out = { ok: false, reason: `task ${result.taskId} not found` }; return false; }
      if (task.status === 'done' || task.status === 'blocked') {
        out = {
          ok: false,
          reason: `task ${result.taskId} already ${task.status}（RESULT taskId 可能错写）`,
          recoverable: false,
        };
        return false;
      }
      if (!task.exec) task.exec = {};
      task.status = (result.status === 'failed' || result.status === 'fail') ? 'blocked' : result.status;
      task.exec.completedAt = new Date().toISOString();
      if (result.result !== undefined) task.exec.result = result.result;
      if (result.files) task.exec.files = result.files;
      if (result.verdict !== undefined) task.exec.verdict = result.verdict;
      if (result.architecture !== undefined) task.exec.architecture = result.architecture;
      if (result.commits) { task.commits = task.commits || []; task.commits.push(...result.commits); }
      s.lastUpdated = new Date().toISOString();
      out = { ok: true, taskId: result.taskId, status: result.status };
      return true;
    });
    return out;
  }

  return { parseResult, parseNeedsInput, logEvent, logFailure, logNeedsInput, reset, settle };
}

module.exports = { createSubagentRecorder };
