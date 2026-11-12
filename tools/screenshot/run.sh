#!/bin/bash
# npm run shot [-- dark|light [out.png]] → a cropped side bar screenshot (activity bar + side bar + status bar).
set -eu
V="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$V/../.." && pwd)"
MODE="${1:-dark}"; OUT="${2:-$REPO/.shots/side-$MODE.png}"
THEME="Default Dark Modern"; [ "$MODE" = light ] && THEME="Default Light Modern"
mkdir -p "$REPO/.shots"
xvfb-run -a -s "-screen 0 2400x2180x24" "$V/shoot.sh" "$THEME" "$REPO/.shots/full-$MODE.png"
python3 -I "$V/crop.py" "$REPO/.shots/full-$MODE.png" "$OUT" "${SIDEBAR:-380}"
