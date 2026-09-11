#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "=== Render plugin config ==="
node "$ROOT/scripts/render-config.mjs"

echo "=== Syntax Check ==="
node --check "$ROOT/src/awf.js"
node --check "$ROOT/src/server/server.cjs"
node --check "$ROOT/plugin/core/mcp/awf-state/server.cjs"
node --check "$ROOT/plugin/core/mcp/awf-session/server.cjs"
node --check "$ROOT/plugin/core/mcp/awf-oneshot/server.cjs"
echo "All entry points ok"

echo ""
echo "=== 结构门禁（check-architecture；T1-114）==="
# 有未豁免违例即非 0，直接中断构建（set -e）。豁免项默认只报不拦；--strict 才要求豁免表为空
node "$ROOT/scripts/check-architecture.mjs"

echo ""
echo "=== Web 构建（web/ → src/server/public；T1-118）==="
# T1-093 的接线（vite outDir + server SPA）一直在，但没有环节触发构建 —— 依赖缺失时**明确报错**，
# 不静默跳过（确要跳过得显式 AWF_SKIP_WEB=1，且会打醒目警告）
node "$ROOT/scripts/build-web.mjs"

echo ""
echo "=== npm pack dry-run ==="
cd "$ROOT" && npm pack --dry-run 2>&1 | head -20

echo ""
echo "=== Build verified ==="
