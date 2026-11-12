#!/bin/bash
# Take a real screenshot of the extension: desktop VS Code on a virtual display (Xvfb), with made-up demo sessions in a throwaway home folder.
# Usage: xvfb-run -a -s "-screen 0 2400x2180x24" tools/screenshot/shoot.sh "<theme name>" <full.png>
# Needs: desktop VS Code (CODE_BIN), xvfb-run, ImageMagick (import), node, python3.
set -u
V="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$V/../.." && pwd)"
THEME="$1"; OUT="$2"
CODE_BIN="${CODE_BIN:-/usr/share/code/code}"
# The demo workspace must not live under a Claude scratchpad path, or the extension hides its files as throwaway files.
RUN="$REPO/.shots/run-$$"; mkdir -p "$RUN/home" "$RUN/ws/web-app" "$RUN/ws/mobile-app" "$RUN/ud/User/globalStorage" "$RUN/ext"
sed "s/Default Dark Modern/$THEME/" "$V/settings.json" > "$RUN/ud/User/settings.json"
# There is no window manager on the virtual display, so the side bar width and window size are written in advance.
python3 -I - "$RUN/ud/User/globalStorage" "${SIDEBAR:-380}" "${WIN_W:-1200}" "${WIN_H:-1090}" <<'PY'
import sqlite3, sys, json, os
d, side, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
c = sqlite3.connect(os.path.join(d, 'state.vscdb'))
c.execute('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
c.execute('INSERT INTO ItemTable VALUES (?, ?)', ('workbench.sideBar.size', side))
c.commit(); c.close()
json.dump({'windowsState': {'lastActiveWindow': {'uiState': {'mode': 1, 'x': 0, 'y': 0, 'width': w, 'height': h}}, 'openedWindows': []}}, open(os.path.join(d, 'storage.json'), 'w'))
PY
# Live processes for the "open" demo sessions.
PIDS=""; for i in 1 2 3 4 5 6; do sleep 900 & PIDS="$PIDS,$!"; done; PIDS="${PIDS#,}"
node "$V/demo.js" "$REPO" "$RUN/home" "$RUN/ws" "$PIDS" || exit 1
# Start with a clean environment: variables of a VS Code remote shell (ELECTRON_RUN_AS_NODE ...) stop the desktop app from starting.
env -i HOME="$RUN/home" PATH="$PATH" DISPLAY="$DISPLAY" XAUTHORITY="${XAUTHORITY:-}" LANG="${LANG:-en_US.UTF-8}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}" \
"$CODE_BIN" --no-sandbox --disable-gpu --force-device-scale-factor=2 --user-data-dir="$RUN/ud" --extensions-dir="$RUN/ext" \
  --extensionDevelopmentPath="$REPO" --extensionDevelopmentPath="$V/helper" --locale=en --disable-workspace-trust --skip-welcome --skip-release-notes \
  --new-window "$RUN/ws/web-app" > "$RUN/code.log" 2>&1 &
CODE=$!
sleep "${WAIT1:-28}"
touch "$RUN/ws/web-app/src/middleware/auth.ts"   # a working session's file "just changed" → the being-edited spinner
sleep "${WAIT2:-8}"
import -window root "$OUT"; echo "screenshot rc=$? $(stat -c %s "$OUT" 2>/dev/null) bytes"
kill $CODE 2>/dev/null; sleep 1; kill $(echo "$PIDS" | tr ',' ' ') 2>/dev/null
[ "${KEEP:-0}" = 1 ] || { cd "$REPO" && rm -r ".shots/run-$$"; }
