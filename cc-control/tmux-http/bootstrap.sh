#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

SESSION="${CC_SESSION:-cc}"
WORKDIR="${CC_WORKDIR:-$ROOT/sandbox}"
PORT="${CC_PORT:-8787}"

command -v tmux >/dev/null 2>&1 || { echo "tmux not found. Install with: brew install tmux" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "claude not found on PATH" >&2; exit 1; }

# Render the hook settings (inject the server port) into the controlled workdir.
mkdir -p "$WORKDIR/.claude"
sed "s/__PORT__/$PORT/g" "$DIR/hooks/settings.json" > "$WORKDIR/.claude/settings.json"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists. Kill it with: tmux kill-session -t $SESSION"
  exit 0
fi

# Plugin dir — cc-plugins 包含 /w-dev /w-review 等自定义命令
PLUGIN_DIR="${CC_PLUGIN_DIR:-$ROOT/cc-plugins}"

# bypassPermissions: 免除文件读写、命令执行等权限确认，避免阻塞自动化工作流
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
  "claude --plugin-dir '$PLUGIN_DIR' --permission-mode bypassPermissions"

# Trust prompt — bypassPermissions 下仍可能出现，nudge Enter 消除
sleep 3
tmux send-keys -t "$SESSION" Enter
