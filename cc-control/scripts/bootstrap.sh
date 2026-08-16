#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

SESSION="${CC_SESSION:-cc}"
WORKDIR="${CC_WORKDIR:-$ROOT/sandbox}"

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
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
  "claude --permission-mode bypassPermissions"

# 增大回滚缓冲，避免长会话旧消息被 tmux 截断（capture-pane -S - 依赖它）
tmux set-option -t "$SESSION" history-limit 100000

# Trust prompt — bypassPermissions 下仍可能出现，nudge Enter 消除
sleep 3
tmux send-keys -t "$SESSION" Enter
