#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "=== AI Eval Pipeline ==="
echo "Placeholder — 将在此运行自动化 AI 质量评测"
echo ""
echo "For each fixture in tests/eval/:"
echo "  1. awf init in clean sandbox"
echo "  2. awf plan with fixture requirements"
echo "  3. awf run --local"
echo "  4. Score outputs against expected"
echo ""
echo "Not yet implemented."
