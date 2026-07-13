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
echo "wrote hooks -> $WORKDIR/.claude/settings.json"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists. Kill it with: tmux kill-session -t $SESSION"
  exit 0
fi

# Detached session with a fixed, wide geometry so the TUI renders predictably.
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" "claude"
echo "started tmux session '$SESSION' running claude in $WORKDIR"

# First run in a fresh dir shows a "trust this folder?" prompt whose default is
# accept — nudge Enter once. Harmless (empty submit) if no prompt is shown.
sleep 3
tmux send-keys -t "$SESSION" Enter

echo
echo "watch live:   tmux attach -t $SESSION   (detach: Ctrl-b then d)"
echo "stop session: tmux kill-session -t $SESSION"
