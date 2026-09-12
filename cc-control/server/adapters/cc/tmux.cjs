'use strict';
/**
 * tmux.cjs — cc tmux 原语（单例形态）
 *
 * 职责：把「对某个 tmux 会话发键 / 抓屏」的 shell 调用封成一组具名函数，是 server 侧与运行中的
 * Claude Code 会话交互的底层通道：sendText 发消息、sendEnter 提交、sendCtrlC 打断、capture 抓屏。
 *
 * 边界与形态：
 *   - 本文件是**单例**导出：模块加载时即按 run-context 装配出的会话名建好默认实例，并把方法展开导出，
 *     以兼容既有 `require('.../tmux.cjs').sendText(...)` 的写法（server/projects/context.cjs 等在用）。
 *     需要按任意会话名实例化（多 project / 多 run）时用 createTmux。
 *   - 它是 host **端口** 的旧路径；新代码应经 adapters/ports.cjs 取 host（见 cc/host.cjs），
 *     不要再新增对本文件的直接依赖。
 *   - 会话名不写死：经 run-context 从 config runtime.session / CC_SESSION 装配，无 sid 时回落基础名。
 */

// 测试注入点：vitest 无法 mock 被原生 require 的 CJS 依赖，提供显式注入钩子。
// 生产环境不设置 global.__CC_EXEC_FILE_SYNC__，回落到 child_process。
const execFileSync = global.__CC_EXEC_FILE_SYNC__ || require('child_process').execFileSync;

// 会话名单源：经 run-context 装配（config runtime.session / CC_SESSION；无 sid 回落基础名）
const { buildRunContext } = require('../../core/run-context.cjs');

/**
 * 按会话名构建 tmux 原语集合（单 server 多项目时每项目一个实例，会话名唯一）。
 * @param {string} sessionName tmux 会话名（如 `cc` / `cc-<projectSid>`）
 * @returns {{ SESSION, hasSession(), sendText(text), sendEnter(), sendCtrlC(), capture() }}
 */
function createTmux(sessionName) {
  // 固化为闭包局部量：后续所有方法闭包捕获它，实例行为不受外部后续改名影响
  const SESSION = sessionName;

  function tmux(args) {
    return execFileSync('tmux', args, { encoding: 'utf8' });
  }

  /** 会话是否存在（has-session 以退出码表意，故 try/catch 而非看输出） */
  function hasSession() {
    try {
      tmux(['has-session', '-t', SESSION]);
      return true;
    } catch {
      return false;
    }
  }

  /** 以字面文本发送（-l）：不做 tmux 键名解析，消息体里的 Enter 等不会变成按键 */
  function sendText(text) {
    tmux(['send-keys', '-t', SESSION, '-l', text]);
  }

  /** 回车提交当前输入（发送键名 Enter） */
  function sendEnter() {
    tmux(['send-keys', '-t', SESSION, 'Enter']);
  }

  /** 发 Ctrl+C 打断正在跑的 Claude 响应（等价交互式里按 Ctrl+C） */
  function sendCtrlC() {
    tmux(['send-keys', '-t', SESSION, 'C-c']);
  }

  /** 抓取 pane 全文：-p 到 stdout，-S - 从回滚起点开始（否则只抓可见区，旧消息会丢） */
  function capture() {
    return tmux(['capture-pane', '-t', SESSION, '-p', '-S', '-']);
  }

  return { SESSION, hasSession, sendText, sendEnter, sendCtrlC, capture };
}

// 默认单会话实例（兼容既有 import：buildRunContext 无 sid → runSessionName = 基础会话名）。
// 展开（...defaultTmux）是为让顶层具名导出（sendText 等）与 createTmux 并存。
const defaultTmux = createTmux(buildRunContext({ env: process.env }).runSessionName);

// 同时导出默认实例的方法（展开）与工厂 createTmux：老调用点用前者，需要多会话/多 run 的用后者
module.exports = { ...defaultTmux, createTmux };
