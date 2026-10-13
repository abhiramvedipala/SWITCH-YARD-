#!/usr/bin/env bash
# <xbar.title>Switchyard — agents need you</xbar.title>
# <xbar.desc>Shows how many Switchyard items need you, from the local /api/attention feed.</xbar.desc>
# Install: copy into your xbar (or SwiftBar) plugins folder and `chmod +x` it. Reads the token from
# ~/.switchyard/ui-session and only talks to 127.0.0.1. Requires `jq`.
PORT="${SWITCHYARD_PORT:-4777}"
TOKEN_FILE="$HOME/.switchyard/ui-session"
[ -r "$TOKEN_FILE" ] || { echo "SY ·"; echo "---"; echo "Switchyard not set up"; exit 0; }
JSON=$(curl -fsS -m 2 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "http://127.0.0.1:$PORT/api/attention" 2>/dev/null) || { echo "SY ○"; echo "---"; echo "Switchyard core not running"; exit 0; }
COUNT=$(echo "$JSON" | jq '.items | length')
if [ "$COUNT" -gt 0 ]; then echo "SY ● $COUNT | color=#f59e0b"; else echo "SY ✓"; fi
echo "---"
echo "$JSON" | jq -r '.items[] | "\(.nodeTitle): \(.text | gsub("\n"; " ") | .[0:60]) | href=http://127.0.0.1:'"$PORT"'"'
echo "Open Switchyard | href=http://127.0.0.1:$PORT"
