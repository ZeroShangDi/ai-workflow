#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "=== Unit Tests ==="
if ls "$ROOT/tests/unit/"*.test.js &>/dev/null; then
  node --test "$ROOT/tests/unit/"*.test.js
else
  echo "(no unit tests yet)"
fi

echo ""
echo "=== Integration Tests ==="
if [ -f "$ROOT/tests/integration/smoke.sh" ]; then
  bash "$ROOT/tests/integration/smoke.sh"
else
  echo "(smoke.sh not found)"
fi

echo ""
echo "=== All tests passed ==="
