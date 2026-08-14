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
echo "=== npm pack dry-run ==="
cd "$ROOT" && npm pack --dry-run 2>&1 | head -20

echo ""
echo "=== Build verified ==="
