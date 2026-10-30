#!/usr/bin/env bash
set -euo pipefail

PORT="${CC_PORT:-8787}"
B="http://127.0.0.1:$PORT"

hr(){ echo; echo "== $* =="; }
post(){ curl -s -X POST "$B$1" -H 'content-type: application/json' -d "$2"; echo; }
snap(){ curl -s "$B/status?snapshot=1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("state="+j.state);if(j.snapshot)console.log(j.snapshot)})'; }

hr "status"; curl -s "$B/status"; echo

hr "turn 1: remember the number"
post /send '{"text":"记住数字 7。只回复：OK"}'
sleep 3; snap

hr "turn 2: recall (proves multi-turn context)"
post /send '{"text":"我刚才让你记的数字是几？只回复那个数字"}'
sleep 3; snap

hr "clear context"
post /cmd '{"cmd":"/clear"}'
sleep 3; snap

hr "turn 3: recall after clear (should NOT know 7)"
post /send '{"text":"我刚才让你记的数字是几？"}'
sleep 3; snap

echo
echo "Read the snapshots above: turn 2 should say 7; turn 3 should not know it."
