#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

# 全真 E2E 评测 — 真实 claude + tmux，消耗真实 token。
# 不参与 npm test，仅在需要时手动运行。详见 tests/eval/README.md
exec node "$ROOT/tests/eval/run-eval.mjs" "$@"
