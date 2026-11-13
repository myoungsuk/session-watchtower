#!/bin/bash
# Take a real screenshot of the extension: desktop VS Code on a virtual display (Xvfb), with made-up demo sessions in a throwaway home folder.
# Usage: xvfb-run -a -s "-screen 0 2400x2400x24" tools/screenshot/shoot.sh "<theme name>" <full.png> [scene]
# Scenes: side (default), toasts, search, file, review, summary, tabs, groups, roles, mcp — see helper/main.js. "gif" and "explorer" write numbered frames next to <full.png>.
# Needs: desktop VS Code (CODE_BIN), xvfb-run, ImageMagick (import), node, python3.
set -u
V="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$V/../.." && pwd)"
THEME="$1"; OUT="$2"; SCENE="${3:-side}"
CODE_BIN="${CODE_BIN:-/usr/share/code/code}"
# The demo workspace must not live under a Claude scratchpad path, or the extension hides its files as throwaway files.
RUN="$REPO/.shots/run-$$"; mkdir -p "$RUN/home" "$RUN/ws/web-app" "$RUN/ws/mobile-app" "$RUN/ud/User/globalStorage" "$RUN/ext"
sed "s/Default Dark Modern/$THEME/" "$V/settings.json" > "$RUN/ud/User/settings.json"
# Notifications fade after a few seconds, so that scene polls faster and is taken early.
if [ "$SCENE" = toasts ] || [ "$SCENE" = gif ]; then sed -i 's/^{/{\n  "claudeSessionChanges.pollSeconds": 2,/' "$RUN/ud/User/settings.json"; WAIT1="${WAIT1:-9}"; WAIT2="${WAIT2:-5}"; fi
# The Explorer scene shows the marks next to git's own marks, and its badge turns, so it polls faster too.
if [ "$SCENE" = explorer ]; then sed -i -e 's/"git.enabled": false/"git.enabled": true/' -e 's/^{/{\n  "claudeSessionChanges.pollSeconds": 2,/' "$RUN/ud/User/settings.json"; fi
# There is no window manager on the virtual display, so the side bar width and window size are written in advance.
python3 -I - "$RUN/ud/User/globalStorage" "${SIDEBAR:-300}" "${WIN_W:-1200}" "${WIN_H:-1200}" <<'PY'
import sqlite3, sys, json, os
d, side, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
c = sqlite3.connect(os.path.join(d, 'state.vscdb'))
c.execute('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
c.execute('INSERT INTO ItemTable VALUES (?, ?)', ('workbench.sideBar.size', side))
c.commit(); c.close()
json.dump({'windowsState': {'lastActiveWindow': {'uiState': {'mode': 1, 'x': 0, 'y': 0, 'width': w, 'height': h}}, 'openedWindows': []}}, open(os.path.join(d, 'storage.json'), 'w'))
PY
# Live processes for the "open" demo sessions.
PIDS=""; for i in 1 2 3 4 5 6 7; do sleep 900 & PIDS="$PIDS,$!"; done; PIDS="${PIDS#,}"
node "$V/demo.js" "$REPO" "$RUN/home" "$RUN/ws" "$PIDS" || exit 1
if [ "$SCENE" = groups ] || [ "$SCENE" = roles ]; then
  # a demo group with roles and a shared memo, written where the extension keeps its groups; plus uncommitted work in the demo repo
  GS="$RUN/ud/User/globalStorage/kms-labs.session-watchtower"; mkdir -p "$GS"
  printf '# Release crew team board\n\n## 0. Decisions waiting for the user\n\n| # | Question | Recommendation | Asked by |\n|---|---|---|---|\n| 1 | Ship the webhook retry change before Friday? | Yes | Add payment webhooks |\n\n## 1. Sessions and roles\n\n| Role | Session name | Scope | Doing now |\n|---|---|---|---|\n| Develop | Refactor auth middleware | src/middleware | token refresh |\n| Deploy | Add payment webhooks | src/api | waiting for approval |\n| Review | Fix flaky e2e tests | e2e | reviewing the auth change |\n\n## 4. Decision log\n\n- 11-12 10:41 "go with the session store" (Refactor auth middleware)\n' > "$RUN/home/board.md"
  node -e '
    const fs = require("fs"); const [demoFile, out, memo] = process.argv.slice(1); const d = JSON.parse(fs.readFileSync(demoFile, "utf8"));
    const m = (t, role) => [d.sids[t], { role, at: Date.now() }];
    const members = Object.fromEntries([m("Refactor auth middleware", "develop"), m("Add payment webhooks", "deploy"), m("Fix flaky e2e tests", "test"), m("Offline sync for drafts", "mobile")]);
    fs.writeFileSync(out, JSON.stringify({ groups: [{ id: "gdemo", name: "Release crew", memo, lead: d.sids["Refactor auth middleware"], members, at: Date.now() }] }));
  ' "$RUN/home/demo.json" "$GS/session-groups.json" "$RUN/home/board.md"
  node -e '
    const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const now = Date.now(); const M = 60000;
    const iso = (t) => new Date(t).toISOString();
    const add = (title, recs) => fs.appendFileSync(d.logs[title], recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const me = (t, text) => ({ type: "user", message: { role: "user", content: text }, cwd: d.web, timestamp: iso(t), origin: { kind: "human" } });
    const say = (t, text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, cwd: d.web, timestamp: iso(t) });
    add("Fix flaky e2e tests", [me(now - 4 * M, "Rerun the checkout test 20 times and tell me if it still fails"), say(now - 2 * M, "**The checkout test passed 20 of 20 runs after the wait fix.** The flake came from a missing wait on the payment frame.")]);
    add("Add payment webhooks", [me(now - 12 * M, "Use the retry helper for the webhook client, then build"), say(now - 9 * M, "**Retries are in; the build needs your approval to clear build/ first.**")]);
    add("Refactor auth middleware", [me(now - 15 * M, "go with the session store"), say(now - 13 * M, "**Switched to the session store; 3 files changed, tests next.**")]);
  ' "$RUN/home/demo.json"
  echo "// wip: token refresh" >> "$RUN/ws/web-app/src/middleware/auth.ts"
  mkdir -p "$RUN/ws/web-app/notes" && echo "scratch" > "$RUN/ws/web-app/notes/scratch.txt"
fi
if [ "$SCENE" = mcp ]; then
  # demo MCP settings in the throwaway home (names and types only matter), a project .mcp.json, a Codex config,
  # and a stand-in "claude" on PATH that prints a made-up "claude mcp list" result for the status check
  mkdir -p "$RUN/bin" "$RUN/home/.codex" "$RUN/ws/web-app/.claude"
  node -e '
    const fs = require("fs"); const [home, web] = process.argv.slice(1);
    fs.writeFileSync(home + "/.claude.json", JSON.stringify({
      mcpServers: { "docs-search": { type: "http", url: "https://docs.example.com/mcp" }, markitdown: { type: "stdio", command: "markitdown-mcp", args: [] } },
      claudeAiMcpEverConnected: ["claude.ai Notion", "claude.ai Google Drive"],
      cachedUsageUtilization: { fetchedAtMs: Date.now() - 8 * 60000, utilization: { limits: [
        { kind: "weekly_all", group: "weekly", percent: 67, severity: "normal", resets_at: new Date(Date.now() + 60 * 3600e3).toISOString(), scope: null },
        { kind: "weekly_scoped", group: "weekly", percent: 18, severity: "normal", resets_at: new Date(Date.now() + 60 * 3600e3).toISOString(), scope: { model: { display_name: "Fable" } } } ] } },
      projects: { [web]: { allowedTools: [], mcpServers: { "local-db": { type: "stdio", command: "db-mcp", args: [] } }, disabledMcpServers: ["markitdown"], hasTrustDialogAccepted: true } },
    }, null, 2));
    fs.writeFileSync(web + "/.mcp.json", JSON.stringify({ mcpServers: { "lint-rules": { command: "lint-mcp" }, browser: { command: "browser-mcp" } } }, null, 2));
    fs.writeFileSync(web + "/.claude/settings.local.json", JSON.stringify({ enabledMcpjsonServers: ["lint-rules"] }, null, 2));
    fs.writeFileSync(home + "/.codex/config.toml", "[mcp_servers.markitdown]\ncommand = \"markitdown-mcp\"\n\n[mcp_servers.openai-docs]\nurl = \"https://developers.example.com/mcp\"\nenabled = false\n");
  ' "$RUN/home" "$RUN/ws/web-app"
  printf '#!/bin/sh\nsleep 2\ncat <<X\nChecking MCP server health...\n\ndocs-search: https://docs.example.com/mcp (HTTP) - \342\234\224 Connected\nmarkitdown: markitdown-mcp - \342\212\230 Disabled for this project (re-enable via /mcp)\nlocal-db: db-mcp - \342\234\230 Failed to connect \342\200\224 Connection closed\nlint-rules: lint-mcp - \342\234\224 Connected\nbrowser: browser-mcp - \342\217\270 Pending approval (run claude to approve)\nplugin:github:github: https://api.example.com/mcp - \342\234\224 Connected\nplugin:pdf-viewer:pdf: node server.js - \342\234\224 Connected\nplugin:tickets:tracker: https://tickets.example.com/mcp - ! Needs authentication\nclaude.ai Notion: https://mcp.example.com - \342\234\224 Connected\nclaude.ai Google Drive: https://drive.example.com - \342\234\224 Connected\nX\n' > "$RUN/bin/claude"
  chmod +x "$RUN/bin/claude"
  PATH="$RUN/bin:$PATH"
  # hide the other two views of the side bar (VS Code keeps which views are hidden in the profile storage)
  python3 -I - "$RUN/ud/User/globalStorage/state.vscdb" <<'PY'
import sqlite3, sys, json
c = sqlite3.connect(sys.argv[1])
c.execute('INSERT INTO ItemTable VALUES (?, ?)', ('workbench.view.extension.claudeSessionChanges.state.hidden', json.dumps([
  {'id': 'claudeSessionChanges.sessions', 'isHidden': True}, {'id': 'claudeSessionChanges.tree', 'isHidden': True}, {'id': 'claudeSessionChanges.mcp', 'isHidden': False}])))
c.commit(); c.close()
PY
fi
# Start with a clean environment: variables of a VS Code remote shell (ELECTRON_RUN_AS_NODE ...) stop the desktop app from starting.
env -i HOME="$RUN/home" PATH="$PATH" DISPLAY="$DISPLAY" XAUTHORITY="${XAUTHORITY:-}" LANG="${LANG:-en_US.UTF-8}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}" SWT_SCENE="$SCENE" SWT_DEMO="$RUN/home/demo.json" \
"$CODE_BIN" --no-sandbox --disable-gpu --force-device-scale-factor=2 --user-data-dir="$RUN/ud" --extensions-dir="$RUN/ext" \
  --extensionDevelopmentPath="$REPO" --extensionDevelopmentPath="$V/helper" --locale=en --disable-workspace-trust --skip-welcome --skip-release-notes \
  --new-window "$RUN/ws/web-app" > "$RUN/code.log" 2>&1 &
CODE=$!
if [ "$SCENE" = gif ]; then
  # one frame about every 1.5 s while things happen: an edit, an approval, an overlapping edit, a session finishing
  sleep 10
  for i in $(seq -w 1 22); do
    case "$i" in 04) node "$V/demo-live.js" "$REPO" "$RUN/home" edit-auth;; 09) node "$V/demo-live.js" "$REPO" "$RUN/home" approve;; 13) node "$V/demo-live.js" "$REPO" "$RUN/home" overlap;; 18) node "$V/demo-live.js" "$REPO" "$RUN/home" finish;; esac
    import -window root "${OUT%.png}-$i.png"; sleep 1
  done
  kill $CODE 2>/dev/null; sleep 1; kill $(echo "$PIDS" | tr ',' ' ') 2>/dev/null
  [ "${KEEP:-0}" = 1 ] || { cd "$REPO" && rm -r ".shots/run-$$"; }
  exit 0
fi
if [ "$SCENE" = explorer ]; then
  # the file Explorer while a session edits two files (the Session Watchtower views are hidden): several frames, because the badge turns
  sleep "${WAIT1:-18}"
  node "$V/demo-live.js" "$REPO" "$RUN/home" edit-auth
  echo "// refreshed" >> "$RUN/ws/web-app/src/middleware/auth.ts"
  # a script-made change to a file the session already changed (no log record: found by its modification time), also changed for git
  printf '{\n  "name": "web-app",\n  "private": true\n}\n' > "$RUN/ws/web-app/package.json"
  sleep "${WAIT2:-6}"
  for i in $(seq -w 1 "${FRAMES:-10}"); do import -window root "${OUT%.png}-$i.png"; sleep 0.2; done
  kill $CODE 2>/dev/null; sleep 1; kill $(echo "$PIDS" | tr ',' ' ') 2>/dev/null
  [ "${KEEP:-0}" = 1 ] || { cd "$REPO" && rm -r ".shots/run-$$"; }
  exit 0
fi
sleep "${WAIT1:-28}"
# a live edit: overlap warning + the being-edited spinner (left out of the editor scenes, where the notification would cover the content)
case "$SCENE" in side|toasts) node "$V/demo-live.js" "$REPO" "$RUN/home";; esac
sleep "${WAIT2:-8}"
import -window root "$OUT"; echo "screenshot rc=$? $(stat -c %s "$OUT" 2>/dev/null) bytes"
kill $CODE 2>/dev/null; sleep 1; kill $(echo "$PIDS" | tr ',' ' ') 2>/dev/null
[ "${KEEP:-0}" = 1 ] || { cd "$REPO" && rm -r ".shots/run-$$"; }
