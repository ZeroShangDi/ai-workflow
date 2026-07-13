#!/bin/bash
# PD-Control Demo Script
# Run after opening test-page.html in fullscreen (F11) in the Windows VM browser
set -e

HOST=${PD_HOST:-10.211.55.4}
CMD="python3 -m pd_control.cli"

echo "=== PD-Control Demo ==="
echo "Host: $HOST"
echo ""

# 1. Ping check
echo "--- 1. Connectivity ---"
$CMD ping --host $HOST
$CMD size --host $HOST
echo ""

# 2. Screenshot baseline
echo "--- 2. Taking baseline screenshot ---"
$CMD shot --host $HOST -o /tmp/demo-baseline.png
echo "Saved: /tmp/demo-baseline.png"
echo ""

# 3. Move mouse around - visible cursor movement
echo "--- 3. Mouse movement test ---"
echo "Move to center..."
$CMD move 960 540 --host $HOST
sleep 0.5
echo "Move to top-left..."
$CMD move 100 100 --host $HOST
sleep 0.3
echo "Move to sidebar..."
$CMD move 130 180 --host $HOST
sleep 0.3
echo ""

# 4. Click sidebar buttons one by one
echo "--- 4. Clicking sidebar buttons ---"
echo "Click Dashboard..."
$CMD click 130 105 --host $HOST
sleep 0.5
echo "Click Settings..."
$CMD click 130 160 --host $HOST
sleep 0.5
echo "Click Profile..."
$CMD click 130 218 --host $HOST
sleep 0.5
echo "Click Logout..."
$CMD click 130 275 --host $HOST
sleep 0.5
echo ""

# 5. Take screenshot to see log output
echo "--- 5. Screenshot after sidebar clicks ---"
$CMD shot --host $HOST -o /tmp/demo-after-clicks.png
echo "Saved: /tmp/demo-after-clicks.png"
echo ""

# 6. Click the main area buttons
echo "--- 6. Clicking action buttons ---"
echo "Click Save..."
$CMD click 370 110 --host $HOST
sleep 0.5
echo "Click Submit..."
$CMD click 470 110 --host $HOST
sleep 0.5
echo "Click Retry..."
$CMD click 580 110 --host $HOST
sleep 0.5
echo "Click Delete..."
$CMD click 680 110 --host $HOST
sleep 0.5
echo "Click Counter button..."
$CMD click 370 165 --host $HOST
sleep 0.3
$CMD click 370 165 --host $HOST
sleep 0.3
$CMD click 370 165 --host $HOST
sleep 0.5
echo "Click Toggle button..."
$CMD click 520 165 --host $HOST
sleep 0.3
$CMD click 520 165 --host $HOST
sleep 0.5
echo ""

# 7. Type text
echo "--- 7. Typing into text fields ---"
echo "Click first input field..."
$CMD click 400 230 --host $HOST
sleep 0.3
echo "Type text..."
$CMD type "Hello from CLI" --host $HOST
sleep 0.5
echo "Press Tab..."
$CMD key tab --host $HOST
sleep 0.3
echo "Type more text..."
$CMD type "Second field text" --host $HOST
sleep 0.5
echo ""

# 8. Drag test
echo "--- 8. Drag test ---"
echo "Drag from top-left to center of drag zone..."
$CMD drag 530 520 680 620 --host $HOST --duration 1.0
sleep 0.5
echo ""

# 9. Key combination test
echo "--- 9. Key combo: Select All + Delete ---"
echo "Click input and select all..."
$CMD click 400 230 --host $HOST
sleep 0.2
$CMD key a --ctrl --host $HOST
sleep 0.2
echo "Delete selected text..."
$CMD key backspace --host $HOST
sleep 0.3
echo "Type replacement..."
$CMD type "Replaced!" --host $HOST
sleep 0.5
echo ""

# 10. Slider test
echo "--- 10. Slider interaction ---"
echo "Click slider at 75%..."
$CMD click 500 410 --host $HOST
sleep 0.5
echo ""

# 11. Final screenshot
echo "--- 11. Final screenshot ---"
$CMD shot --host $HOST -o /tmp/demo-final.png
echo "Saved: /tmp/demo-final.png"
echo ""

echo "=== Demo Complete ==="
echo "Screenshots: /tmp/demo-baseline.png, /tmp/demo-after-clicks.png, /tmp/demo-final.png"
