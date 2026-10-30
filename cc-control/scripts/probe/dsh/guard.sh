#!/usr/bin/env bash
# guard.sh — 真实 `~/.dsh` 配置面指纹（证明实验对它零副作用）
#
#   bash scripts/probe/dsh/guard.sh snapshot   # 实验前记指纹
#   bash scripts/probe/dsh/guard.sh check      # 实验后复核 → IDENTICAL / DIFF（差异逐条列出）
#
# 口径（依据 F12）：只覆盖**配置面**——`profiles/**` 的 `package.json` / `cordis*.yml` 与
# `settings.yaml`；`sessions/`、`storages/`、`attachments/` 等运行期数据由 dsh 持续写入，
# 计进去只会天天报 DIFF，反而没人看。
# 另排除 `.credentials.yaml`：凭据可能被运行中的 dsh 刷新，且它不是我们要动的配置。
#
# 只读：本脚本不写真实 home，只读文件算哈希。

set -euo pipefail

REAL_HOME="${REAL_DSH_HOME:-$HOME/.dsh}"
SNAP="${AWF_PROBE_GUARD_SNAPSHOT:-${AWF_DSH_PROBE_HOME:-/tmp/awf-dsh-probe}/guard.snapshot}"

fingerprint() {
  if [[ ! -d "$REAL_HOME" ]]; then
    echo "(real home absent: $REAL_HOME)"
    return 0
  fi
  (
    cd "$REAL_HOME"
    find . -type d -name node_modules -prune -o -type f \
      \( -name '*.yml' -o -name '*.yaml' -o -name 'package.json' \) -print 2>/dev/null \
      | LC_ALL=C sort \
      | grep -v '^\./\.credentials\.yaml$' \
      | while read -r f; do
          printf '%s %s\n' "$f" "$(shasum -a 256 "$REAL_HOME/${f#./}" | awk '{print $1}')"
        done
  )
  # 哨兵：隔离 home 的 profiles/node_modules 是指向这一份的符号链接（离线复用）。
  # 谁要是把它当安装目标写穿，顶层清单就会变 —— 这条就是那件事的探针。
  if [[ -d "$REAL_HOME/profiles/node_modules" ]]; then
    printf '%s\n' '--- profiles/node_modules listing ---'
    ( cd "$REAL_HOME/profiles/node_modules" && ls -1 2>/dev/null | LC_ALL=C sort )
  fi
}

case "${1:-}" in
  snapshot)
    mkdir -p "$(dirname "$SNAP")"
    fingerprint > "$SNAP"
    echo "[guard] snapshot -> ${SNAP} ($(wc -l < "$SNAP" | tr -d ' ') config files)"
    ;;

  check)
    [[ -f "$SNAP" ]] || { echo "[guard] 没有 snapshot，先跑 snapshot" >&2; exit 2; }
    now="$(mktemp)"
    fingerprint > "$now"
    if diff -u "$SNAP" "$now" > /tmp/awf-guard.diff 2>&1; then
      echo "[guard] IDENTICAL（真实 $REAL_HOME 配置面零改动）"
      rm -f "$now"
    else
      echo "[guard] DIFF —— 真实 $REAL_HOME 配置面发生变化：" >&2
      cat /tmp/awf-guard.diff >&2
      rm -f "$now"
      exit 1
    fi
    ;;

  *)
    echo "用法: guard.sh {snapshot|check}" >&2
    exit 2
    ;;
esac
