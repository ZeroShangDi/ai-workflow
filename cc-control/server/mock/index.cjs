'use strict';
/**
 * mock/index.cjs — 测试替身（tmux / 日志 / state 落盘）
 *
 * 用途：让新 server **脱离 cli、脱离真 tmux** 也能被测。server 对外的副作用只有四类
 * （见 `projects/context.cjs` 的「出口」），把它们替掉，整个 server 就是纯逻辑，可单测。
 *
 * 定位：这是**测试脚手架**，不是产品的降级路径 —— 不参与生产装配、不进 ports 名册。
 */

/**
 * host 替身（原 createMockTmux）：记录所有注入调用，可注入 hasSession 结果。
 * @param {{ session?: string, hasSession?: boolean }} [opts] 会话名 / 初始存活状态
 * @returns host 原语集：calls 顺序记录注入操作；setAlive 可动态改存活（模拟会话中途死掉）
 */
function createMockTmux({ session = 'cc-mock', hasSession = true } = {}) {
  const calls = [];
  let alive = hasSession;
  return {
    sessionName: session,
    calls,
    hasSession: () => alive,
    setAlive: (v) => { alive = !!v; },
    sendText: (text) => calls.push({ op: 'sendText', text }),
    // 能力方法：替身只记一次 sendPrompt（不模拟文本+回车的两次机制），与 host 契约对齐（T-P1-02）
    sendPrompt: (text) => calls.push({ op: 'sendPrompt', text }),
    sendEnter: () => calls.push({ op: 'sendEnter' }),
    sendCtrlC: () => calls.push({ op: 'sendCtrlC' }),
    capture: () => '',
  };
}

/**
 * 日志替身：记录通知/决策/prompt/choice，不落盘。
 * captureFromTranscript / resetTranscript 为 no-op —— transcript 捕获不是被测重点，只需满足调用面。
 */
function createMockLogger() {
  const prompts = [];
  const notices = [];
  const decisions = [];
  const choices = [];
  return {
    prompts, notices, decisions, choices,
    logPrompt: (t) => prompts.push(t),
    logNotice: (kind, msg) => notices.push({ kind, msg }),
    logDecision: (d) => decisions.push(d),
    logChoice: (q, v) => choices.push({ q, v }),
    captureFromTranscript: () => {},
    captureSubagentTranscript: () => {},
    resetTranscript: () => {},
  };
}

/**
 * state 落盘替身：内存态 + updateSync 语义（mutator 返回 false 表示不写）。
 * 读/写都做深拷贝进出，保证调用方拿到的 state 与内部态彼此隔离（避免测试里无意间共享引用）。
 * @param {object} [initialState] 初始 state（会被深拷贝，调用方后续改原对象不影响替身）
 * @returns {object} current（读当前态）/ set（整体替换）/ state（对齐真实 store 的 readSync/updateSync）
 */
function createMockStores(initialState = {}) {
  let state = JSON.parse(JSON.stringify(initialState));
  return {
    get current() { return state; },
    set: (s) => { state = JSON.parse(JSON.stringify(s)); },
    state: {
      readSync: () => JSON.parse(JSON.stringify(state)),
      // mutator 在草稿上改；返回 false → 丢弃草稿不写（与真实 JsonFileStore.updateSync 约定一致）
      updateSync: (mutator) => {
        const draft = JSON.parse(JSON.stringify(state));
        const changed = mutator(draft);
        if (changed !== false) state = draft;
        return changed;
      },
    },
  };
}

module.exports = { createMockTmux, createMockLogger, createMockStores };
