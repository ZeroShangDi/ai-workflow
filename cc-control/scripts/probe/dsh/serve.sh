#!/usr/bin/env bash
# serve.sh — 静默起停隔离探针后台（P2-3）
#
#   bash scripts/probe/dsh/serve.sh start   # 后台起 dsh web（--no-open，不弹浏览器）
#   bash scripts/probe/dsh/serve.sh wait    # 等就绪，并保存带 token 的 URL
#   bash scripts/probe/dsh/serve.sh stop    # 停（只杀本隔离实例）
#   bash scripts/probe/dsh/serve.sh url     # 打印 URL（无则空）
#
# 纪律：一律隔离 DSH_HOME；一律 --no-open（实验静默）。端口经 CLI 的 --port 传入，
# 不用 include patch 覆盖 webserver（F14：include patch 的 config 是浅覆盖，给不全就启动失败）。

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

LOG="$DSH_HOME/serve.log"
PIDFILE="$DSH_HOME/serve.pid"

case "${1:-}" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "[serve] 已在运行 pid=$(cat "$PIDFILE")"
      exit 0
    fi
    : > "$LOG"
    # 注意：`dsh web` 是 `--profile web` 的别名，**不接受**父级 `--profile`
    # （报 "web takes none of parent --profile ..."）。自定义 profile 要直接 boot，
    # app 自己的旗标跟在后面（本 profile 含 dsh-web-app，故 --port/--no-open 可用）。
    nohup dsh --profile "$AWF_PROBE_PROFILE" --port "$AWF_PROBE_WEB_PORT" --no-open >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    echo "[serve] started pid=$(cat "$PIDFILE") port=$AWF_PROBE_WEB_PORT log=$LOG"
    ;;

  wait)
    for _ in $(seq 1 60); do
      # 就绪判据：日志里出现带 token 的 URL（dsh 打印访问地址时才算真的服务起来了）
      url="$(grep -Eo "http://[^ ]*token=[A-Za-z0-9._-]+" "$LOG" 2>/dev/null | head -1 || true)"
      if [[ -n "$url" ]]; then
        echo "$url" > "$AWF_PROBE_URL_FILE"
        echo "[serve] ready"
        echo "[serve] url=$url"
        exit 0
      fi
      if [[ -f "$PIDFILE" ]] && ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "[serve] 进程已退出，日志尾部：" >&2
        tail -20 "$LOG" >&2
        exit 1
      fi
      sleep 1
    done
    echo "[serve] 等待超时（60s），日志尾部：" >&2
    tail -20 "$LOG" >&2
    exit 1
    ;;

  stop)
    if [[ -f "$PIDFILE" ]]; then
      pid="$(cat "$PIDFILE")"
      kill "$pid" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "[serve] stopped pid=$pid"
    else
      echo "[serve] 无 pidfile"
    fi
    ;;

  url)
    [[ -f "$AWF_PROBE_URL_FILE" ]] && cat "$AWF_PROBE_URL_FILE" || true
    ;;

  *)
    echo "用法: serve.sh {start|wait|stop|url}" >&2
    exit 2
    ;;
esac
