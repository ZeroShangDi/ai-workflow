#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "=== Syntax Check ==="
node --check "$ROOT/bin/awf.js"
node --check "$ROOT/src/server/server.cjs"
node --check "$ROOT/tools/awf-state/server.cjs"
node --check "$ROOT/tools/awf-session/server.cjs"
node --check "$ROOT/tools/awf-oneshot/server.cjs"
echo "All entry points ok"

echo ""
echo "=== npm pack dry-run ==="
cd "$ROOT" && npm pack --dry-run 2>&1 | head -20

echo ""
echo "=== Build verified ==="
