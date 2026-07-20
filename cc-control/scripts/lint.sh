#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "=== JS Syntax Check ==="
find "$ROOT" -name '*.js' -not -path '*/node_modules/*' -not -path '*/sandbox/*' | while read f; do
  node --check "$f" || exit 1
done
echo "All .js files pass syntax check"

echo ""
echo "=== JS (ESM) Syntax Check ==="
find "$ROOT" -name '*.cjs' -not -path '*/node_modules/*' | while read f; do
  node --check "$f" || exit 1
done
echo "All .cjs files pass syntax check"

echo ""
echo "=== ShellCheck ==="
if command -v shellcheck &>/dev/null; then
  find "$ROOT" -name '*.sh' -not -path '*/node_modules/*' | while read f; do
    shellcheck "$f" || exit 1
  done
  echo "All .sh files pass shellcheck"
else
  echo "(shellcheck not installed, skipping)"
fi

echo ""
echo "=== Lint passed ==="
