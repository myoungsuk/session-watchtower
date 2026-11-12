#!/bin/bash
# npm run shot [-- <scene> [dark|light] [out.png]]
# Scenes: side (activity bar + side bar), toasts (notifications), search, file, review, summary. Output: .shots/<scene>-<theme>.png
set -eu
V="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$V/../.." && pwd)"
SCENE="${1:-side}"; MODE="${2:-dark}"; OUT="${3:-$REPO/.shots/$SCENE-$MODE.png}"
THEME="Default Dark Modern"; [ "$MODE" = light ] && THEME="Default Light Modern"
mkdir -p "$REPO/.shots"
if [ "$SCENE" = gif ]; then
  # animated picture of the side bar: frames → crop → half size → GIF
  rm -f "$REPO"/.shots/frame-*.png
  xvfb-run -a -s "-screen 0 2400x2400x24" "$V/shoot.sh" "$THEME" "$REPO/.shots/frame.png" gif
  for f in "$REPO"/.shots/frame-*.png; do python3 -I "$V/crop.py" "$f" "$f" side "${SIDEBAR:-300}" > /dev/null; done
  convert -delay 130 -loop 0 "$REPO"/.shots/frame-*.png -resize 50% -layers Optimize "${3:-$REPO/.shots/demo-$MODE.gif}"
  ls -la "${3:-$REPO/.shots/demo-$MODE.gif}" | awk '{print $5, $9}'
  exit 0
fi
xvfb-run -a -s "-screen 0 2400x2400x24" "$V/shoot.sh" "$THEME" "$REPO/.shots/full-$SCENE-$MODE.png" "$SCENE"
python3 -I "$V/crop.py" "$REPO/.shots/full-$SCENE-$MODE.png" "$OUT" "$SCENE" "${SIDEBAR:-300}"
