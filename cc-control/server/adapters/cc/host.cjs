'use strict';
/**
 * host.cjs — host 基座：tmux 原语与派发节奏（会话名参数化，支持 cc-<sid>）
 *
 * 本模块 createHost({ sessionName }) 产出参数化的 tmux 原语
 * （hasSession/sendText/sendPrompt/sendEnter/sendCtrlC/capture），会话名由调用方传
 * run-context.runSessionName（cc-<sid>）。execFileSync 可注入（测试）。
 *
 * 「tmux 原语」只有这一份实现：同目录的旧单例 cc/tmux.cjs 方法体与本文件逐条相同，
 * 仅包装不同（单例 / `SESSION` / global 注入钩子），其单例导出在本树从无消费者 —— 已删。
 * 新代码一律经 adapters/ports.cjs 取 host，不直连本文件。
 *
 * ## 为什么有 sendPrompt（T-P1-02）
 * 「文本与回车分两次发、中间留节奏」是 **tmux 的机制细节**，不是编排知识。此前
 * `ENTER_DELAY_MS` 在 `server/config.cjs`、由 executor / web api 各自 sleep 后分两次调用
 * sendText/sendEnter —— 平台细节漏到上层。现在节奏下沉进本 adapter：上层只说
 * 「提交一段输入」（`sendPrompt`），cc 侧实现成「sendText → 等 ENTER_DELAY_MS → sendEnter」。
 */

// 默认 exec 取值做成惰性函数：宿主环境/测试可能在 require 之后才替换 child_process，
// 直接 `= require(...).execFileSync` 会在模块加载那一刻就锁死，测试无法注入。
const DEFAULT_EXEC = () => require('child_process').execFileSync;

/**
 * 注文本与回车之间的间隔（ms）。tmux send-keys 分两次（文本、回车），必须留出间隔让
 * 交互会话的输入框先收下文本，再单独收到回车 —— 同帧发送会丢回车。
 * **每次调用时读 env**（不锁死在模块加载那一刻），便于测试设 `CC_ENTER_DELAY_MS=0`。
 */
function enterDelayMs() {
  return Number(process.env.CC_ENTER_DELAY_MS || 200);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ sessionName?: string, execFileSync?: Function }} opts
 *   sessionName 缺省 'cc'；多 run 传 `${session}-${sid}`（run-context.runSessionName）
 *   execFileSync 缺省落到 child_process.execFileSync（测试注入用，见 DEFAULT_EXEC 注释）
 * @returns {{ sessionName: string, hasSession(), sendText(text), sendPrompt(text), sendEnter(), sendCtrlC(), capture() }}
 */
function createHost({ sessionName = 'cc', execFileSync = DEFAULT_EXEC() } = {}) {
  // 所有方法共用的一条 exec 通道：统一 utf8 编码（capture 要拿字符串而非 Buffer）
  function tmux(args) {
    return execFileSync('tmux', args, { encoding: 'utf8' });
  }
  const host = {
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
  /**
   * 提交一段输入（能力方法）：文本 → 等节奏 → 回车。
   * 上层不该知道「分两次发」这件事；节奏值属于本 adapter（见文件头 T-P1-02 说明）。
   * 用闭包（而非 `this`）调内部原语：端口句柄常被解构后调用，`this` 不可靠。
   * @param {string} text 要提交的输入（prompt / slash 命令 / 决策应答）
   */
  host.sendPrompt = async (text) => {
    host.sendText(text);
    await sleep(enterDelayMs());
    host.sendEnter();
  };
  return host;
}

module.exports = { createHost };
