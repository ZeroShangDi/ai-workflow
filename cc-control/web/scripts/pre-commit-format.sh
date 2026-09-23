#!/usr/bin/env bash
# 提交前自动格式化（web 侧）。
#
# 由仓库根 scripts/pre-commit 委托调用，参数 = 本次暂存的文件（仓库根相对路径）。
# 放在 web 下而不是根 scripts/：这条规则随 web 项目变，不随仓库其他部分变。
#
# 边界与代价：
#   · 只处理暂存区里 cc-control/web 下的文件；
#   · prettier 作用在**磁盘文件**上，所以若同一文件还有未暂存的改动，它们会被一并
#     格式化并暂存。遇到这种情况会打一条警告 —— 要精细分块提交就先把改动 stash 掉。
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(git -C "$WEB_DIR" rev-parse --show-toplevel)"
# web 相对仓库根的路径 —— 钩子传进来的暂存文件名就是这个口径
PREFIX="cc-control/web/"

files=()
for path in "$@"; do
  [[ "$path" == "$PREFIX"* ]] || continue
  files+=("${path#"$PREFIX"}")
done
[[ ${#files[@]} -eq 0 ]] && exit 0

PRETTIER="$WEB_DIR/node_modules/.bin/prettier"
if [[ ! -x "$PRETTIER" ]]; then
  echo "  ⚠ 跳过格式化：找不到 $PRETTIER（先在 cc-control/web 跑 npm install）" >&2
  exit 0
fi

# 先记下「本来就有未暂存改动」的文件，格式化后提醒
dirty=()
for rel in "${files[@]}"; do
  git -C "$REPO_ROOT" diff --quiet -- "$PREFIX$rel" || dirty+=("$PREFIX$rel")
done

(cd "$WEB_DIR" && "$PRETTIER" --write --ignore-unknown -- "${files[@]}")

git -C "$REPO_ROOT" add -- "${files[@]/#/$PREFIX}"

if [[ ${#dirty[@]} -gt 0 ]]; then
  echo ""
  echo "  ⚠ 这些文件本来还有未暂存的改动，已被一并格式化并暂存："
  for f in "${dirty[@]}"; do echo "    • $f"; done
  echo "    （要分开提交的话，提交前先 git stash）"
fi

exit 0
