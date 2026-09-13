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
const { extract } = require('../adapters/ports.cjs'); // 经端口契约的唯一门（extract 属非端口工具，同样只从这里出）

/**
 * @param {{ paths: { event: string, failed: string, needsInput: string }, stores: { state: object } }} deps
 *   paths  三个 jsonl 落点（可在 pcx 里，也可测试注入临时路径）
 *   stores state 存储（子 agent 落账写 state）
 */
function createSubagentRecorder({ paths, stores } = {}) {
  /**
   * 解析子 Agent 固定格式 RESULT（`RESULT: {json}`，在末条 assistant message 里）。
   * @param {object} body SubagentStop hook 载荷
   * @returns {object|null} { taskId, status, result?, files?, verdict?, architecture?, commits? }；无/非法 → null
   */
  function parseResult(body) {
    return extract.parseSubagentResult(body?.last_assistant_message);
  }

  /** 解析 NEEDS_INPUT（`NEEDS_INPUT: {json}`）→ { taskId, question, options?, context? }，否则 null */
  function parseNeedsInput(body) {
    return extract.parseNeedsInput(body?.last_assistant_message);
  }

  /** 追加一行 JSON 到 jsonl 落点；失败只打印不抛（观测落账绝不能反向阻断主流程） */
  function appendJsonl(file, record) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    } catch (e) {
      console.log(`[subagent-log] ${e.message}`);
    }
  }

  /**
   * 子 agent 生命周期事件（Start/Stop 原样留档到 subagent-events.jsonl）。
   * 纯留档：body 原样存，供事后排查「子 agent 何时起、何时停、hook 载荷长什么样」。
   */
  function logEvent(event, body) {
    appendJsonl(paths.event, { ts: new Date().toISOString(), event, body });
  }

  /**
   * 落账失败留档（subagent-failed.jsonl，供 CLI 补发判定）。
   * 记下 agentId、失败原因、以及从 RESULT 里尽力解析出的 resultTaskId（可能为 null）。
   */
  function logFailure(body, settled) {
    appendJsonl(paths.failed, {
      ts: new Date().toISOString(),
      agentId: body?.agent_id || body?.session_id || 'unknown',
      reason: settled?.reason,
      resultTaskId: (parseResult(body) || {}).taskId || null,
    });
  }

  /**
   * 上抛决策留档（subagent-needs-input.jsonl）：子 Agent 以 NEEDS_INPUT 请求人工介入时记录，
   * 宿主读它感知「有决策挂起」，据此暂停补位。
   */
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
   * SubagentStop 落账：把子 Agent 的 RESULT 写进 state（task status + exec.result/files/commits/verdict/architecture）。
   *
   * 经 stores.state.updateSync 做读改写的原子提交；mutator 返回 false 表示不写盘（校验失败时）。
   * 各类失败用 out.recoverable 区分：
   *   - 无有效 RESULT / state 读不出 / task 不存在 / 目标已是终态 → 不可恢复（多为 RESULT 写错 taskId 或重复落账），
   *     由调用方决定补发还是放弃；recoverable === false 明确表示「重发也没用」。
   *   - status 'failed'/'fail' 归一为 'blocked'，与 state 的状态机一致。
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
        // 已是终态：多半是 RESULT 里的 taskId 错写到了别的任务，或重复落账。重发无意义 → recoverable:false
        out = {
          ok: false,
          reason: `task ${result.taskId} already ${task.status}（RESULT taskId 可能错写）`,
          recoverable: false,
        };
        return false;
      }
      if (!task.exec) task.exec = {};
      // 'failed'/'fail' 统一映射为 state 的终态 'blocked'（state 无 failed 状态）
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
