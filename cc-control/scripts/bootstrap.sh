#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

SESSION="${CC_SESSION:-cc}"
WORKDIR="${CC_WORKDIR:-$ROOT/sandbox}"
# 固定 inbox socket 路径（cross-session messaging）：CLI 用同一路径注入派生指令
MESSAGING_SOCKET="${CC_MESSAGING_SOCKET:-$WORKDIR/.awf/messaging.sock}"

command -v tmux >/dev/null 2>&1 || { echo "tmux not found. Install with: brew install tmux" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "claude not found on PATH" >&2; exit 1; }
# node 用于插件 MCP server 启动，须在 PATH 上
command -v node >/dev/null 2>&1 || { echo "node not found on PATH" >&2; exit 1; }

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists. Kill it with: tmux kill-session -t $SESSION"
  exit 0
fi

# 插件 + hooks + MCP 由项目 .claude/settings.json 注册加载（awf init 本地注入 / 全局 claude plugin install），
# bootstrap 只负责启动 tmux + claude，不做任何插件渲染/加载。
# bypassPermissions: 免除文件读写、命令执行等权限确认，避免阻塞自动化工作流
# --settings .awf/run-settings.json: statusLine + crossSessionInbound（多 agent 滑动窗口注入需要 accept）
# env -u: 去掉会关闭 cross-session messaging 的变量（telemetry/feature-flag 类），仅影响本 claude 会话
# --messaging-socket-path: 固定 inbox socket 路径，CLI 无需猜（隐藏 flag，2.1.227 确认存在）
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
  "env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -u DISABLE_TELEMETRY -u DO_NOT_TRACK -u DISABLE_GROWTHBOOK claude --permission-mode bypassPermissions --messaging-socket-path \"$MESSAGING_SOCKET\" --settings \"$WORKDIR/.awf/run-settings.json\""

# 增大回滚缓冲，避免长会话旧消息被 tmux 截断（capture-pane -S - 依赖它）
tmux set-option -t "$SESSION" history-limit 100000

# Trust prompt — bypassPermissions 下仍可能出现，nudge Enter 消除
sleep 3
tmux send-keys -t "$SESSION" Enter
