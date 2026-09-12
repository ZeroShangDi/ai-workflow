'use strict';
/**
 * host.cjs — host 基座：tmux 原语（会话名参数化，支持 cc-<sid>）
 *
 * 现状 tmux.cjs 把 SESSION 定在模块顶（单 run 会话，经 run-context 装配基础名/cc-<sid>）。
 * 多 run 后需同一套原语作用于任意会话名。本模块 createHost({ sessionName }) 产出
 * 参数化的 tmux 原语（hasSession/sendText/sendEnter/sendCtrlC/capture），会话名由调用方
 * 传 run-context.runSessionName（cc-<sid>）。execFileSync 可注入（测试）。
 * 现状 server.cjs / cli 仍经 tmux.cjs 单会话；host 由 W1-040/069 按 cc-<sid> 接入。
 */

const DEFAULT_EXEC = () => require('child_process').execFileSync;

/**
 * @param {{ sessionName?: string, execFileSync?: Function }} opts
 *   sessionName 缺省 'cc'；多 run 传 `${session}-${sid}`（run-context.runSessionName）
 */
function createHost({ sessionName = 'cc', execFileSync = DEFAULT_EXEC() } = {}) {
  function tmux(args) {
    return execFileSync('tmux', args, { encoding: 'utf8' });
  }
  return {
    sessionName,
    hasSession() {
      try {
        tmux(['has-session', '-t', sessionName]);
        return true;
      } catch {
        return false;
      }
    },
    /** 以字面文本输入（-l） */
    sendText(text) {
      tmux(['send-keys', '-t', sessionName, '-l', text]);
    },
    /** 回车提交当前输入 */
    sendEnter() {
      tmux(['send-keys', '-t', sessionName, 'Enter']);
    },
    sendCtrlC() {
      tmux(['send-keys', '-t', sessionName, 'C-c']);
    },
    /** 抓取 pane 全文 */
    capture() {
      return tmux(['capture-pane', '-t', sessionName, '-p', '-S', '-']);
    },
  };
}

module.exports = { createHost };
