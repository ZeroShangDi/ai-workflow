'use strict';
/**
 * host.cjs — host 基座：tmux 原语（会话名参数化，支持 cc-<sid>）
 *
 * 现状 tmux.cjs 把 SESSION 定在模块顶（单 run 会话，经 run-context 装配基础名/cc-<sid>）。
 * 多 run 后需同一套原语作用于任意会话名。本模块 createHost({ sessionName }) 产出
 * 参数化的 tmux 原语（hasSession/sendText/sendEnter/sendCtrlC/capture），会话名由调用方
 * 传 run-context.runSessionName（cc-<sid>）。execFileSync 可注入（测试）。
 * 现状 server.cjs / cli 仍经 tmux.cjs 单会话；host 由 W1-040/069 按 cc-<sid> 接入。
 *
 * 与 cc/tmux.cjs 的关系：两者都是「tmux 原语」，但定位不同 ——
 *   - tmux.cjs  = 旧的单例（模块加载即建一个默认会话实例，导出具名函数），兼容既有 require；
 *   - host.cjs  = 新的工厂（显式传会话名，可造多个实例），是 host **端口** 的实现。
 * 新代码（尤其多 run / 多项目）应经端口取 host，不要再新增对 tmux.cjs 的直接依赖。
 */

// 默认 exec 取值做成惰性函数：宿主环境/测试可能在 require 之后才替换 child_process，
// 直接 `= require(...).execFileSync` 会在模块加载那一刻就锁死，测试无法注入。
const DEFAULT_EXEC = () => require('child_process').execFileSync;

/**
 * @param {{ sessionName?: string, execFileSync?: Function }} opts
 *   sessionName 缺省 'cc'；多 run 传 `${session}-${sid}`（run-context.runSessionName）
 *   execFileSync 缺省落到 child_process.execFileSync（测试注入用，见 DEFAULT_EXEC 注释）
 * @returns {{ sessionName: string, hasSession(), sendText(text), sendEnter(), sendCtrlC(), capture() }}
 */
function createHost({ sessionName = 'cc', execFileSync = DEFAULT_EXEC() } = {}) {
  // 所有方法共用的一条 exec 通道：统一 utf8 编码（capture 要拿字符串而非 Buffer）
  function tmux(args) {
    return execFileSync('tmux', args, { encoding: 'utf8' });
  }
  return {
    sessionName,
    /** 会话是否存在。has-session 以退出码表意，故 try/catch 而非看返回值 */
    hasSession() {
      try {
        tmux(['has-session', '-t', sessionName]);
        return true;
      } catch {
        return false;
      }
    },
    /** 以字面文本输入（-l）：不解析 tmux 键名，`Enter`/`C-c` 之类会原样打字进去 */
    sendText(text) {
      tmux(['send-keys', '-t', sessionName, '-l', text]);
    },
    /** 回车提交当前输入（注意：发送的是键名 Enter，不走 -l） */
    sendEnter() {
      tmux(['send-keys', '-t', sessionName, 'Enter']);
    },
    /** 发 Ctrl+C，等价交互式里打断当前响应；用于升级式干预 */
    sendCtrlC() {
      tmux(['send-keys', '-t', sessionName, 'C-c']);
    },
    /** 抓取 pane 全文；-p 输出到 stdout，-S - 从回滚起点开始（否则只抓可见区，旧内容会丢） */
    capture() {
      return tmux(['capture-pane', '-t', sessionName, '-p', '-S', '-']);
    },
  };
}

module.exports = { createHost };
