#!/usr/bin/env bash
# env.sh — AWF × DSH 隔离实验环境（P2-3）
#
# 纪律：**绝不触碰用户真实 `~/.dsh`**。本文件把 DSH_HOME 强制指到隔离目录，并在
# 指向真实 home 时直接报错退出（防呆），所有实验脚本都必须先 `source` 它。
#
# 用法：
#   source scripts/probe/dsh/env.sh
#
# 可覆盖：AWF_DSH_PROBE_HOME / AWF_PROBE_WEB_PORT / AWF_PROBE_PROFILE
# 参考：执行记录 F11/F12（真实 home 被运行中进程持有；运行时数据持续写入）

set -u

PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AWF_PROBE_DIR="$PROBE_DIR"
export AWF_REPO_ROOT="$(cd "$PROBE_DIR/../../.." && pwd)"
export AWF_PROBE_PLUGIN_SRC="$PROBE_DIR/fixtures/probe-plugin"
# 生产插件（AWF 的 DSH host 半侧）：与探针插件一起装进隔离 profile
export AWF_DSH_PLUGIN_SRC="$AWF_REPO_ROOT/dsh-plugin"

# ── DSH_HOME：隔离 + 防呆 ──
export DSH_HOME="${AWF_DSH_PROBE_HOME:-/tmp/awf-dsh-probe}"
case "$DSH_HOME" in
  "$HOME/.dsh"|"$HOME/.dsh/"*)
    echo "[probe] 拒绝：DSH_HOME 指向真实 home（$DSH_HOME）。实验一律用隔离目录。" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

export AWF_PROBE_WEB_PORT="${AWF_PROBE_WEB_PORT:-39081}"
export AWF_PROBE_PROFILE="${AWF_PROBE_PROFILE:-awf-probe}"
export AWF_PROBE_URL_FILE="$DSH_HOME/probe-url.txt"

mkdir -p "$DSH_HOME"

# 离线复用用户已装的包（本机无 pnpm，F13）：把隔离 home 的 `profiles/node_modules` 指向真实 home
# 那份（187 个 hoisted 包，靠 Node 的父目录 node_modules 查找生效 —— NODE_PATH 对 ESM 无效）。
# 这是**只读复用**：实验流程不跑 `dsh plugin add`（那才会写这个目录），
# 且 guard.sh 的指纹里带了这份目录的顶层清单当哨兵 —— 真被写穿会报 DIFF。
if [[ ! -e "$DSH_HOME/profiles/node_modules" && -d "$HOME/.dsh/profiles/node_modules" ]]; then
  mkdir -p "$DSH_HOME/profiles"
  ln -sfn "$HOME/.dsh/profiles/node_modules" "$DSH_HOME/profiles/node_modules"
fi

# 凭据：符号链接进隔离 home（不读、不打印、不复制内容）
if [[ ! -e "$DSH_HOME/.credentials.yaml" && -f "$HOME/.dsh/.credentials.yaml" ]]; then
  ln -sfn "$HOME/.dsh/.credentials.yaml" "$DSH_HOME/.credentials.yaml"
fi

echo "[probe] DSH_HOME=$DSH_HOME profile=$AWF_PROBE_PROFILE port=$AWF_PROBE_WEB_PORT"
