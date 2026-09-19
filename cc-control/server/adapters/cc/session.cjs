'use strict';
/**
 * session.cjs — cc 会话生命周期端口（启动 / 复用探测 / 停止 / 接入观看）
 *
 * **T-P1-03 收口**：`cli/lib/session.cjs` 与 `cli/commands/attach.cjs` 里原有 5 处 tmux 直连
 * （display-message 取 cwd、kill-session、bash bootstrap.sh 起会话、send-keys Enter 兜底、
 * attach）全部下沉到这里；`session` 端口从 `not-landed` 转正为 `factory`。
 * 上层只说「确保会话在 / 停掉会话 / 接进去看」，不知道命令名。
 *
 * 约定（沿用原 CLI 实现，都是真机踩出来的）：
 *   - `cwd()` **空输出必须判为 null**：tmux 对不存在的会话返回空串且退出码 0，
 *     `path.resolve('')` 会静默取进程 cwd，令「是否复用现场」的相等判断恒真。
 *   - `kill()` / `nudge()` 幂等：会话不在时忽略，不抛。
 *   - 起会话走 `scripts/bootstrap.sh`（tmux new-session + claude），脚本路径由装配期注入。
 */

// 默认 exec 取值做成惰性函数（同 host.cjs：测试可能在 require 之后才替换 child_process）
const DEFAULT_EXEC = () => require('node:child_process').execFileSync;

/**
 * @param {{ sessionName?: string, bootstrapScriptPath?: string, execFileSync?: Function }} opts
 *   sessionName          会话名（cc-<sid>）
 *   bootstrapScriptPath  起会话的脚本（缺省注入自 run-context；start() 必需）
 *   execFileSync         注入的 exec（测试用；生产走系统 tmux）
 * @returns {{ sessionName, exists(), cwd(), start({ projectRoot, env }), kill(), nudge(), attach({ stdio }) }}
 */
function createSessionPort({ sessionName = 'cc', bootstrapScriptPath, execFileSync = DEFAULT_EXEC() } = {}) {
  // 统一 utf8：cwd() 要拿字符串而非 Buffer
  function tmux(args, extra) {
    return execFileSync('tmux', args, { encoding: 'utf8', ...extra });
  }
  return {
    sessionName,
    /** 会话是否存在。has-session 以退出码表意，故 try/catch */
    exists() {
      try {
        tmux(['has-session', '-t', sessionName]);
        return true;
      } catch {
        return false;
      }
    },
    /** 会话当前工作目录；不存在 / 空输出 → null（见文件头：空串不能当路径用） */
    cwd() {
      try {
        const out = tmux(['display-message', '-p', '-t', sessionName, '#{pane_current_path}']);
        const value = String(out || '').trim();
        return value || null;
      } catch {
        return null;
      }
    },
    /**
     * 启动会话：跑 bootstrap.sh（tmux new-session + claude）。调用方负责先 kill 旧会话。
     * @param {{ projectRoot: string, env?: object }} opts projectRoot 作为 cwd；env 为会话环境
     * @returns {{ ok: true }}
     * @throws {Error} 未注入 bootstrapScriptPath
     */
    start({ projectRoot, env } = {}) {
      if (!bootstrapScriptPath) {
        throw new Error('session adapter: 缺少 bootstrapScriptPath（装配期由 run-context 注入）');
      }
      execFileSync('bash', [bootstrapScriptPath], { stdio: 'ignore', cwd: projectRoot, env });
      return { ok: true };
    },
    /** 结束会话（幂等：不存在就算了） */
    kill() {
      try {
        tmux(['kill-session', '-t', sessionName], { stdio: 'ignore' });
      } catch { /* 已不在 */ }
    },
    /** 补一记回车：消除文件夹信任弹窗 / 唤醒空闲输入框（幂等） */
    nudge() {
      try {
        tmux(['send-keys', '-t', sessionName, 'Enter'], { stdio: 'ignore' });
      } catch { /* 无会话忽略 */ }
    },
    /** 接入观看实时对话（阻塞式；stdio 默认交给终端） */
    attach({ stdio = 'inherit' } = {}) {
      execFileSync('tmux', ['attach', '-t', sessionName], { stdio });
    },
  };
}

module.exports = { createSessionPort };
