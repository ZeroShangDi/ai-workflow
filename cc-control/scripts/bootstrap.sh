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
# --settings .awf/run-settings.json: statusLine（上下文占用显示）
# env -u: 去掉 telemetry/feature-flag 类变量（T1-065：cross-session messaging 已降级 tmux）
#
# run 会话 env 一律显式赋值（T1-098 真 run 回归暴露）：
#   tmux 新建会话里进程拿到的环境 = tmux **全局** env（= 当初启动 tmux server 的那个 run 的环境），
#   而不是调用 bootstrap 的本进程 env。并发多 run / 机器上残留别项目会话时，claude 会继承
#   别项目的 CC_PROJECT/CC_WORKDIR，后果有两处（均已在真 run 现场复现）：
#     1. hook 网关按 CC_PROJECT 组 `&p=` 路由 → 事件落到别人的项目槽，本 run 槽永远收不到
#        SessionStart/Stop，第二次派发卡 `still busy (ready timeout)`，run 直接异常终止；
#     2. 插件级 awf-state MCP 的 PROJ_ROOT = AWF_PROJECT_ROOT || CC_PROJECT → 读写别的项目 state。
#   故 CC_SESSION/CC_WORKDIR/CC_PROJECT/CC_PORT/CC_AWF_STATE_SERVER(/CC_SID) 全部在 claude 前显式赋值，
#   不依赖 tmux 会话环境。新增 run 级变量时同步加到这里。
ENV_ASSIGNS="CC_SESSION=\"$SESSION\" CC_WORKDIR=\"$WORKDIR\""
if [ -n "${CC_PROJECT:-}" ]; then ENV_ASSIGNS="$ENV_ASSIGNS CC_PROJECT=\"$CC_PROJECT\""; fi
if [ -n "${CC_PORT:-}" ]; then ENV_ASSIGNS="$ENV_ASSIGNS CC_PORT=\"$CC_PORT\""; fi
if [ -n "${CC_AWF_STATE_SERVER:-}" ]; then ENV_ASSIGNS="$ENV_ASSIGNS CC_AWF_STATE_SERVER=\"$CC_AWF_STATE_SERVER\""; fi
if [ -n "${CC_SID:-}" ]; then ENV_ASSIGNS="$ENV_ASSIGNS CC_SID=\"$CC_SID\""; fi

tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
  "env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -u DISABLE_TELEMETRY -u DO_NOT_TRACK -u DISABLE_GROWTHBOOK $ENV_ASSIGNS claude --permission-mode bypassPermissions --settings \"$WORKDIR/.awf/run-settings.json\""

# 增大回滚缓冲，避免长会话旧消息被 tmux 截断（capture-pane -S - 依赖它）
tmux set-option -t "$SESSION" history-limit 100000

# Trust prompt — bypassPermissions 下仍可能出现，nudge Enter 消除
sleep 3
tmux send-keys -t "$SESSION" Enter
