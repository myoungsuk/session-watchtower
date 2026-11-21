# Changelog

## Unreleased

- **Mark reviewed.** Each changed file has a checkbox: tick it once you have looked at the file. A newer change to that file in the session clears the tick by itself. Ticks are kept per session and file (newest 500).

## 0.38.0

- **Codex sessions can be renamed, and show their Codex names.** The pencil button used to say Codex sessions cannot be renamed, and the list showed a Codex chat's first question even after you named it in Codex. Watchtower now reads the names Codex keeps in `~/.codex/session_index.jsonl`, and renames a Codex chat the way Codex does: it briefly starts `codex app-server` (from the Codex VS Code extension, or the `codex` CLI on PATH), sends `thread/name/set`, and stops it. Codex writes the name itself; Watchtower does not edit Codex's files. Where no Codex program can be started, Watchtower says so.

## 0.37.0

- **`/clear` keeps the session in its group.** `/clear` starts a new conversation with a new session ID, so it used to drop out of its group and lose its role tag. Now the new conversation takes over the old one's place, role and lead badge, and shows the name you gave the old one (so the board's *Sessions and roles* table still matches) until you rename it. It is recognised when the same Claude Code process switches to a conversation whose log starts with `/clear`, or, when no window saw that moment, when a `/clear` conversation in the same folder starts within 10 seconds of the old one ending and only one old conversation fits. The old conversation goes to Archived. `/resume` into another conversation and a later, unrelated `/clear` are not taken over, and once you remove the new conversation from the group it is not put back.

## 0.36.3

- **Phone board on Android: the ChatGPT app opens, not the website.** In 0.36.2 Chrome opened the chatgpt.com website when the app did not take the link. The button now hands `https://chatgpt.com/codex` to the ChatGPT app directly (Android package `com.openai.chatgpt`), and goes to the website only when the app does not take it (board copied from session-board 1d70dea).

## 0.36.2

- **Phone board on Android: Open in ChatGPT does something.** The ChatGPT app on Android does not take `codex://` links, so the button did nothing there. On Android it now hands the same link to the app through an intent address and, when the app does not take it, Chrome goes to Codex in the ChatGPT app (`https://chatgpt.com/codex`). The button copies the chat title and says which chat to pick.
- **Codex answers are labeled Codex**, not Claude, in the phone board's conversation view (board copied from session-board f011351).

## 0.36.1

- **Phone board: open a Codex chat in the ChatGPT app.** When this computer is connected to Codex remote access in the ChatGPT app, a Codex session's *Open in ChatGPT* button (waiting card, conversation header, bottom bar) opens that chat there through `codex://threads/<id>`. OpenAI documents this link only for the desktop app and it has been reported to work on iPhone, so the conversation view says when it opens; if it does not, continue in VS Code (board copied from session-board 06c5ae1).

## 0.36.0

- **Settings in the Sessions view's `…` menu.** *Choose what New session opens (Claude Code / Codex)* switches the New session button without searching the settings, marking the current choice, and *Open all Watchtower settings* opens every Watchtower setting. The button's tooltip now points to that menu.
- **Phone board: Codex sessions say "view only".** Their answer button showed *RC off*, as if `/rc` could turn it on. The answer button is a Claude Code Remote Control link, which Codex sessions do not have, so the waiting card, the conversation header and the bottom bar now say *Codex · view only* (board copied from session-board ab26ba0).

## 0.35.0

- **Phone setup that walks you through.** The phone panel now checks each step on this computer (Tailscale installed → signed in → `tailscale serve` forwards the board's port) and marks the one to do next. Step 3 shows the serve command for this system (PowerShell on Windows) with a *Run it in a terminal* button, and says what to do the first time: open the `login.tailscale.com` address, turn on HTTPS certificates and leave Funnel off.
- **No QR code that cannot work.** Until the phone can actually reach the board, the panel hides the phone QR code and the code, and says why (the `127.0.0.1` link only opens on this computer). Before, the phone scanned a `127.0.0.1` link and got a connection error.
- **Tailscale found on Windows without restarting VS Code.** When `tailscale` is not on VS Code's PATH (Tailscale installed after VS Code started), Watchtower also looks in the usual install folders.
- The panel and *How it works* open the full setup guide in the README, now with steps for Windows, Mac and Linux and a troubleshooting table (QR opening another app, `127.0.0.1` on the phone, *Connection needed*, a forwarded port).

## 0.34.0

- **The board says when the roles table cannot be read.** When a group's shared memo is linked but its *Sessions and roles* table cannot be read, the board warns (the tags then show the roles set by hand) and copies a note for the lead with the exact table shape Watchtower reads.
- **A deploy move is flagged.** When the board table gives the deploy role to a session that did not have it, the board and a one-time notification ask you to check that the user approved it, until you confirm. Watchtower does not undo it; a deploy role you set by hand counts as approved, and a shrinking or first deploy assignment is not flagged.
- The lead's note and the lead request now say to update the *Doing now* cell (and the role cell) of the table every time the lead sends an instruction, so the tags keep up with the real work.
- **Checklists come with a scoreboard script.** When the lead creates the checklists, it also writes a short script that recounts the item states and rewrites the scoreboard between `<!-- progress-scoreboard:begin -->` and its end marker, with `--check` for tests or CI. Item lines use fixed state words (passed, partly, left, blocked, failed) and the test checklist a layer.
- A screenshot scene for the Codex new agent (`codexnew`) confirmed that *New Codex Agent* opens a Codex tab.

## 0.33.0

- **New session can open Codex.** The setting `newSessionTool` chooses what the Sessions view's **New session** button opens: `claude` (a new Claude Code conversation, as before) or `codex` (a new Codex chat: the Codex extension's *New Codex Agent*, its sidebar chat if that fails, or the Codex CLI in a terminal when the extension is not installed). The button's tooltip says which one.
- **The ⚠ badge can clear the overlap warning.** Clicking the ⚠ badge on a session row lists the files that another session also changed, with who changed them. Pick one to compare both changes or stop the warning for it, or stop the warning for all of them at once. Before, the only places were the notification at that moment and the `overlapIgnore` setting.
- The built-in phone board gets 12 fixes from a review of session-board (71f9dc6): no endless reload on the phone when a merged board refuses, a broken cookie no longer errors, the reading thread restarts after a crash, multi-line private keys in changed lines are hidden, file names with spaces or non-ASCII letters in commits, a waiting notification is not repeated after 24 hours, and smaller fixes on the page.

## 0.32.3

- The phone board also notices when a session that writes in English is waiting for your decision (it already did for Korean). Copied from session-board be753fd; on 46 recent sessions no Korean verdict changed.
- Tests stop a single test after 3 minutes instead of waiting forever (one full run hung once in the built-in board test and could not be reproduced in 4 later runs).

## 0.32.2

- **The phone link is https only when Tailscale serve really points at the board.** Before, having Tailscale installed was enough for the panel to make an https link and say "This computer is ready", even when `tailscale serve` was not set up yet, or pointed at another port (such as a separately installed board), so the phone could not open the link or reached the wrong board. Now Watchtower checks `tailscale serve status`; if the board's port is not served, the panel says it is not ready yet and shows the `tailscale serve` command, and the computer button opens the board through VS Code instead.

## 0.32.1

- **The phone board speaks English.** Its pages, the connection screens, error messages and phone notifications are in English unless the browser's language is Korean, and the board's settings have a language switch (automatic, 한국어, English). Copied from session-board e36f672. Session titles and conversations stay as written.

## 0.32.0

- **The lead checks the team documents.** The lead session request and the lead's role note now ask the lead to look for a plan, a design, a development checklist and a test checklist in the project (a file with another name that does the same job counts) and to recommend creating only the missing ones: once, not for a small change, never again after you say no, and only after you approve. Watchtower itself does not judge by file names.
- New templates for the four documents. Both checklists start with a progress scoreboard: `Passed n / m (p%)` with a 10-cell bar, a table per stage with right-aligned numbers, and the test checklist has a table per test layer (automated, real environment, human check). The counting rules come with it: only items with evidence pass, the numbers are recounted from the items, and the session that changes a state updates the scoreboard in the same change.
- The team board template has a *Documents* line under the title with the paths of these documents.

## 0.31.3

- **A lead without a shared memo gets the board template.** The lead's role note, when no shared memo is linked yet, now includes the team board template (decisions waiting for the user at the top) and says to keep its section numbers, names and order. Before, the lead could create a board in any shape, and the user's section ended up in the middle.
- The board template has an eighth rule: keep the board to short status lines and put long text such as research results in separate files, with only their paths on the board.
- The built-in phone board gets a way back to the start on wide screens (click the title, or "All" button), copied from session-board 12b2a20.

## 0.31.2

- **Codex chats no longer vanish after the time range.** Codex chats older than the time range (for example 30 minutes) were not looked for at all, so after a while, or after restarting VS Code, they were missing from the list and from *Archived*. They are now listed like Claude sessions: this folder's Codex chats up to `sessionListDays`, other folders' for a shorter time, and old ones go to *Archived* by the usual rule. Review sub-threads stay under their chat.
- Reading them is light: only the start of each old Codex file (up to 64 KB for review threads) and its last record, and the result is cached, so later starts read nothing new.

## 0.31.1

- **Finished Codex chats are idle, not off.** Codex has no process per conversation and any chat can be continued after VS Code restarts, so a Codex session whose last activity is within 6 hours now shows as idle (or "just finished" for the first 10 minutes) instead of off. Older ones show as off. It also counts in *Open*. A Codex session in the middle of a turn is still working.
- The built-in phone board now has the wide computer layout (counts at the top, waiting cards in a grid, "working now | just finished" side by side, settings in a drawer), copied from session-board 3db18dd.

## 0.31.0

- **The phone board is built in.** Turn it on with *Phone board: turn on or off* (also in the Sessions view's `…` menu); no separate program to install. It is off by default and, when on, listens on this computer only (`127.0.0.1:5290`, setting `phoneBoard.port`); your phone reaches it through your own Tailscale (`tailscale serve`, never Funnel). Phones and browsers connect with a one-time code, and *Phone board: disconnect all phones and browsers* cancels them all.
- With several VS Code windows, the first one serves the board and another takes over within 30 seconds when it closes. `phoneBoard.enabled` is a per-computer setting, so a remote window turns it on for that server only.
- A separately installed session-board keeps working: if it already runs on the port, Watchtower uses it instead of starting its own. If the port shows another computer's board (forwarded by VS Code) or another program, Watchtower says so and asks for another port.
- New settings: `phoneBoard.enabled`, `phoneBoard.port`, `phoneBoard.label` (name at the top of the board) and `phoneBoard.pushDelaySeconds` (notification delay, 0 = off). The board comes from the session-board project, copied unchanged into `board/` (`board/SOURCE.txt`). The board's pages are in Korean for now.

## 0.30.0

- **See the phone board on a computer too.** The Sessions view has a computer button next to the phone button (and the command *Phone board: open it in this computer's browser*). It opens the board at the same address as the phone link, so a browser connected once goes straight in. If the board says the device is not connected yet, **Connect this browser** in the notification connects it with a fresh one-time code. Without Tailscale it opens this computer's own board address through VS Code, which also works from a remote window.
- The Sessions view header stays on one line in a narrow side bar: the icon buttons are a little narrower, and when the buttons would still wrap, *New session* shows only its **+** (the name is in its tooltip).

## 0.29.0

- **Sessions from other folders open with one click.** Claude Code opens a conversation only in a window with its folder open, so before, clicking a session from another folder only said where to open it. Now it brings up the VS Code window of that folder and that window opens the conversation. When no window has that folder open, Watchtower asks first and then opens it in a new window (on the same remote server for a remote window).
- The hand-over is a small request file in Watchtower's own storage with the session ID, its folder and the time. Only a window with that folder open takes it, only one window takes it, and a request older than two minutes is dropped, so a conversation never opens in the wrong folder or later by surprise.
- **Files changed outside the session's folder are found.** When a command changes a file in another repository by its full path (for example a Python snippet that writes `/path/to/other-repo/note.txt`, as the Codex panel does), Watchtower now also looks in the repositories of the existing paths written in the command, not only in the folder the command ran in. Applies to Codex and Claude shell commands; such files are marked as estimated, like other script changes.
- **Codex sessions stop "thinking" when the turn ends.** A Codex session whose last record is the end of a turn (`task_complete` or `turn_aborted`) is shown as idle right away, instead of working for another 90 seconds. A session still in the middle of a turn keeps the 90-second rule.

## 0.28.5

- **No dead end on the board's "connection needed" page.** "Also open it in this computer's browser" (was "Open the board here") now opens the board with the current code, so this browser gets connected instead of stopping at the board's "connection needed" page; the panel then says the phone needs a new link.
- Running *Phone board: make a link* on a computer without session-board now says first that the phone board is a separate program that is not published yet, with *How it works*.
- Tests now clear `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `BOARD_STATE_DIR`, so they can never read or change your real settings.

## 0.28.4

- **Codex sessions open in the Codex panel.** When the Codex extension (openai.chatgpt) is installed, clicking a Codex session opens that conversation in the Codex panel (`vscode://openai.chatgpt/local/<id>`); without it, it still continues in a terminal with `codex resume`.
- **Old Codex chats no longer jump to the top.** The Codex extension appends a settings record (and a short review sub-thread) to old conversations when it starts, which made weeks-old chats look like they had just been working. The last activity of a Codex session is now the time of its last real record, not the file time.
- **The phone button only shows when a phone board is installed on this computer** (its run.json or a folder with cli.js), so it no longer appears on machines that only see another computer's board through a forwarded port.

## 0.28.3

- **No computer names in the phone panel.** The phone panel and the phone button's tooltip no longer show the board's name or this computer's network address (they meant nothing to someone else installing it). The panel just says this computer is ready.

## 0.28.2

- **Phone board setup, step by step.** The phone panel now starts with an example of the board on a phone and walks through the setup from scratch: install Tailscale on the phone (QR code or store links), sign in with the same account, prepare this computer (install links for Windows, Mac and Linux and the `tailscale serve` command, folded away as done when the board already has a private address), scan the board code, and turn on notifications. Only the listed Tailscale pages can be opened from the panel.

## 0.28.1

- **The phone board explains itself.** The phone panel now says what the phone board shows (sessions, changes and conversations, read-only) and that the phone reaches it over the private network only. When no board runs, the command says what the phone board is and offers *How it works*. The README states that session-board is a separate program that is not published yet.

## 0.28.0

- **Phone board.** When a phone board (session-board, a separate program) runs on this computer, the Sessions view shows a phone button. It opens a panel with a QR code, link and code for your phone, made by the board's own `cli.js pair` (once, within 10 minutes; never saved). Watchtower only checks whether the board is running and never starts or stops it. Settings `phoneBoard.ports` and `phoneBoard.folder`.

## 0.27.0

- **Codex MCP switches.** Codex servers in the MCP Servers view can now be turned off or on: the extension changes only the `enabled` line of that server's table in `~/.codex/config.toml` (for every folder, as Codex has no per-folder setting), keeps a copy of the original the first time, checks that the change stayed, and offers Undo. A server written on one line stays read-only.
- Fixed: turning a server off and undoing it right away could show a false "the change did not stay" warning.
- README pictures for plan usage, the team roster and folded board parts; the session counts and usage item now always sit side by side.

## 0.26.2

- Fixed: on a group board, the shared memo jumped back to the top every few seconds while sessions worked, because the board was redrawn on every update. The board now skips a redraw when nothing changed and keeps the scroll position of the memo, the file list and the page.

## 0.26.1

- **The lead can link the board itself.** When a group has no shared memo, the lead writes the board file's full path into a request file next to the team roster; the extension links it within seconds, deletes the request and notes the result in the roster. The lead's role note now says how, describes the roles table format, and ends with what to do right away (read the roster, link the board, give every session a role, tell them, report to the user).

## 0.26.0

- **Usage stays fresh.** While you use Claude, the extension has Claude Code re-check your plan usage every 15 minutes by running Claude Code's own local `claude -p /usage` (no model call, no saved conversation, no MCP servers; about 3 seconds of CPU). A click on the usage item re-checks now. The extension still never reads your login. Setting `usageRefreshMinutes` (0 = never).
- **Session counts on the right**, next to the usage.
- **The lead hands out roles on its own.** Each group gets a team roster file (names, tools, states, message addresses, roles, who joined or left), rewritten when the group changes. The lead's role note points to it and tells the lead to give new sessions a role and a first instruction, share out the work of sessions that left, and tell sessions about changes directly.
- Short runs started through the SDK (`claude -p`) no longer count as running sessions, as in Claude Code's own list.

## 0.25.1

- **Per-model limits.** The usage item now reads the limits list Claude Code saves today: the overall weekly limit and a model's own weekly limit (for example `Claude 83% · Fable 21%`), how much of the weekly limit that model may use, and which products the week's usage came from. Older saved values still work.
- The usage item moved to the right side of the status bar, and it turns yellow when Claude Code itself marks a limit as a warning.

## 0.25.0

- **Plan usage in the status bar.** Shows how much of your Claude Code and Codex limits you have used (`Claude 67% · Codex 23%`, the highest limit of each); hover for every limit, its reset time and how old the value is. Claude's number is the usage Claude Code saves in `~/.claude.json`; Codex's comes from the latest Codex log. No network requests: the extension only checks the two files' size and time, and reads them when they change. Setting `usageStatusBar`.
- **Fold any part of a group board.** Waiting for you, Sessions, Instructions and results and Shared memo each fold with a click on their heading, and the board remembers it per group. What you folded in 0.24.1 is kept.

## 0.24.1

- **Fold Instructions and results.** Click the heading on a group board to fold the section away or open it again (also with Enter or Space). The board remembers it for each group, also after closing the board or reloading the window.

## 0.24.0

- **MCP Servers view.** A new view (collapsed at the bottom of the side bar) lists the MCP servers Claude Code uses in this folder: added by you, added for this folder, the project's `.mcp.json` (with its approval state), plugins and claude.ai connectors, plus Codex's servers from `~/.codex/config.toml` (shown only).
- **Turn a server off for this folder.** Each Claude Code server has a switch that does what `/mcp disable` and `/mcp enable` do: it changes this folder's `disabledMcpServers` list in `~/.claude.json`, under the same lock file Claude Code uses, and checks a moment later that the change stayed. *Undo* is on the notification and at the top of the view. New sessions use the change.
- **Check status** runs `claude mcp list` in this folder only when you press it, and shows each server as connected, needs sign-in, failed, not set up, waiting for approval or off. Commands, URLs, headers and environment variable values are never shown.

## 0.23.0

- **Board and group in line.** When a group's team board lists sessions that are not in the group, or the group has sessions the board does not list, the group board shows both lists. Sessions found on this computer can be added to the group with one click (one by one or all), and *Copy a note for the lead* asks the lead to add or remove rows. The group stays the list of the team; the extension never edits the board file.

## 0.22.0

- **The lead stands out.** A group's lead gets a crown badge, sits at the top of the group in the Sessions view and on the board, and the board opens with a lead card (state and *Open conversation*). There is one lead per group: picking *Lead* for another session moves it, and unchecking it leaves the group without a lead.
- The team board no longer hides the lead: the lead is a fixed position, so a different role in the board table shows next to the lead badge instead of replacing it. A custom role such as "QA lead" does not make a session the lead.
- The role note for the lead says so, and the other sessions' roles in a role note now follow the team board too.

## 0.21.1

- Fixed: with a group board open, a role change in the team board file could leave the old role tag in the Sessions view, because the board read the file first and the Sessions view then saw nothing new.

## 0.21.0

- **Roles follow the team board.** The lead and the deployer stay fixed; the other roles change task by task. When a group's shared memo has a *Sessions and roles* table, the role tags are read from it (dashed border) and change as soon as the lead edits the table, even with the board closed. Roles set by hand apply only to sessions the table does not list. Works with the team board template and with tables that use the same column names.
- The board warns when more than one session has the deploy role, or the lead role.
- The lead request, the role note and the board template now say that roles other than lead and deploy are not fixed, that a session never reviews or tests its own change, and that the lead updates the roles table when it hands out work.

## 0.20.0

- **Start a team with a lead session.** The team request now makes the session you paste it into the lead: it recommends the team, creates a team board from a detailed template (decisions waiting, sessions and roles, tasks and order, reports, decision log, shared resources, rules, handoff), writes the first instruction for each working session, and from then on takes reports and gives instructions. A new *Lead* role is in the role list, and *Create a memo file* uses the same board template.
- **Instructions and results:** split into pages (setting `boardPageSize`, 20 by default), each session has its own color (also in the Sessions table), and clicking a session name opens that session.

## 0.19.1

- **Codex in groups.** Instructions and results on the board now include what you typed to Codex sessions and the first line of Codex's final answer (review and sub-agent threads are left out). Conversation search finds Codex messages too.
- The role note marks Codex teammates and, in a group that mixes Claude Code and Codex, tells the session to exchange work through the shared memo, because the two cannot message each other.
- *Plan the team* asks which tool the sessions will use (Claude Code, Codex or both) when Codex is in use, adjusts the request, and can open Codex in a terminal.

## 0.19.0

- **Plan the team.** Describe what you will build and how many sessions you can run, and the extension copies a request to paste into a Claude session: it lists the roles and what each does, rules of thumb for choosing the number of sessions, and asks for a table of sessions with roles and first steps, the work that must not run at the same time, and a first instruction for each session. Available on a board (it then also lists the group's sessions) and from the Sessions view menu before any group exists.

## 0.18.1

- **Pick roles from a list.** Setting a role opens a list of the roles most projects need: Watch, Plan, Design, Develop, Test, Review, Docs, Deploy, Security and Research, each with a line about what it does. Check one or more, or type your own role and check it. The role note describes these roles too.

## 0.18.0

- **Role note.** A button on each board row copies a note to paste into that session: its group and role, what the role does (for common roles), the other sessions, the shared memo and five rules for working together. A role tag alone is only a label; this is how a session learns its role, also in a brand-new project with no team rules yet.
- **Getting started** steps at the top of a board until every session has a role and a memo is linked.
- *Create a memo file* asks where: in the project folder (you pick the place; sessions read it without asking) or in the extension's storage. The new file has sections for decisions waiting, the decision log and handoff. An existing file is linked, never overwritten.

## 0.17.3

- Instructions and results on the board: the copy button is gone and the text takes the full width. Each row shows three lines; click a row to read all of it.

## 0.17.2

- The board's "What you said" is now **Instructions and results**: each message you typed to the group comes with the first line of the session's last answer to it. Notes that Claude Code inserts (interruptions, summaries of long conversations) and messages from other sessions are left out, the same message sent to several sessions is shown once, and *Copy with time* appears only on the row under the mouse.
- *Copy board as Markdown* includes the ten latest instructions and results.

## 0.17.1

- Fixed: the board's "Changes no session log explains" listed every uncommitted file no session had touched, including backups and files that had sat outside git for weeks. It now lists only files changed within the time range.

## 0.17.0

- **Session groups.** Put sessions that work together in a group (group button on a session row, or *Add sessions…* on the board) and give each a role such as *watch*, *develop* or *deploy*. A group sits at the top of the Sessions view. A session belongs to one group; groups are shared by all VS Code windows on the computer.
- **Group board.** One page per group: sessions waiting for you with the command they want to run, a table of the sessions (role, state, doing now, files changed, files not committed yet, commits, last conversation), uncommitted files that no session log explains, your messages to the group with *Copy with time*, and a shared Markdown memo file (link an existing coordination board or create one). *Copy board as Markdown* copies a snapshot. The board never types into a session.
- New commands: New group, Open a group board, Rename a group, Delete a group.

## 0.16.1

- Only the conversation you have in front of you is shaded now: the Claude Code tab that is showing (one per editor group). In 0.16.0 every open conversation tab was shaded, which marked almost the whole list.

## 0.16.0

- **Sessions open in a tab stand out.** In the Sessions view, a conversation that is open in an editor tab of this window gets a shaded row with a bar on the left, and the color legend explains it. Claude Code's tabs only show the session name, so tabs are matched by name (also when Claude Code cuts a long name short with `…`).

## 0.15.0

- **Shorter time ranges.** The clock button of the Changed files view now also offers 10, 20, 30, 40 and 50 minutes, and `lookbackHours` accepts decimals (0.5 = 30 minutes). Short ranges show as "Last 10 min".
- **Open a session from another program.** A link such as `vscode://kms-labs.session-watchtower/open?title=<session name>&folder=<folder>` opens that session's conversation in the VS Code window that receives it, for example from a desktop notification. It finds the session by a hash of its ID (`key`) or by its name; a name cut short with `…` matches the start. When several sessions have the name, you pick one. Only sessions already in the list can be opened, and nothing in the link is run or typed.

## 0.14.0

- **Marks in the file Explorer.** The file a session is editing right now gets a turning badge and a green name in VS Code's own Explorer and on its editor tab; the folders above it get a green dot, and an edit that waits for your approval gets a blue `!`. VS Code does not let extensions animate the file icon itself, so the badge is what turns (a still dot with *Reduce Motion* on). Setting `explorerMarks`, on by default.
- **The side bar no longer has to be open.** While a session is working in this folder, its log is now read every few seconds even when the Session Watchtower views are hidden (a few milliseconds per check). Before, the overlap warning only appeared while one of the views was visible.
- Fixed: with the views hidden, a session that was working normally could be reported as "may be stuck" after 10 minutes, because the time of its last log line was not refreshed.
- Fixed: turning off `notifyWaiting` also turned off the "may be stuck" notification.

## 0.13.0

- **Overlap warning.** When a session changes a file that another session also changed, the file is marked `⚠ <session name> too`, the session row gets a `⚠ n` tag, and a notification offers *Compare both changes* and *Don't warn for this file*. Only certain changes count (not guesses), and a closed session whose change is already committed does not count. Settings `notifyOverlap` and `overlapIgnore` (glob patterns; Claude Code's memory folder is ignored by default). The command *Warn about overlapping edits for every file again* forgets the files you silenced.
- **"May be stuck" notification.** A session in this folder that has been working for 10 minutes without writing anything new to its log gets a warning (setting `notifyStuckMinutes`, 0 = off). A long command without output looks the same.
- **Search conversations.** Find a session by what you typed in it, not just by its title: the `…` menu of the Sessions view, or Enter in the title filter box. The first search reads all logs once; later searches only read new lines. Only your own messages are indexed, and the index stays in the extension's private storage.
- **Which sessions changed this file?** New entry in the right-click menu of the Explorer and of editor tabs.
- **Copy a summary.** Copies a Markdown summary of the changes (files, lines, time span, commits) for one session or for all sessions of this folder. No AI is called.
- **Subagents.** A working session shows *N subagents working* in its second line.
- **Rename a session** with the pencil button or the right-click menu. The name is stored the way Claude Code stores it, so it also shows in Claude Code's own list. This is the only thing the extension writes outside its own storage: one title line appended to that session's log.
- The status bar now counts this folder only; other folders are mentioned in its tooltip.
- *Review all changes* shows real file paths in its headers.
- The README is rewritten with real screenshots of each feature and a short animation.
- The description no longer says "read-only", because of the rename feature. Project files are still never touched.

## 0.12.1

- Fixed: clicking an image or another non-text file in the Changed files view showed a "cannot open" error. Such files now open in their own viewer.

## 0.12.0

- **Files changed by scripts are listed before they are committed.** When a session runs a command that Claude Code keeps no file record for (python, node, a formatter …), uncommitted files in that repository that changed while the command ran are added as a guess (`?`). Commands that only read (`ls`, `cat`, `grep`, `git status` …) are left out, and so are changes already explained by another record. Codex commands are handled the same way.
- **Load older work on demand.** A session with no changes inside the time range now has a button that loads the files it changed in its last stretch of work.
- **Waiting notification.** A notification appears when a session in this folder starts waiting for your approval or answer (setting `notifyWaiting`, on by default).
- **Shorter session rows in the Changed files view**: file count first, then the time — the icon already shows the state. Only "needs approval / needs answer" keeps its words.
- New Marketplace picture, now a real screenshot. `npm run shot` takes it: desktop VS Code on a virtual display with made-up demo sessions. The dark and light themes were both checked this way.
- Fixed: numbers in two tooltips could come out as "undefined".

## 0.11.6

- **Clicking a Codex session now opens it**: it continues in a terminal with the Codex CLI (`codex resume <id>`), started in that session's folder, so it also works for sessions from other folders. Needs the `codex` command on the machine.

## 0.11.5

- The number on the **Open** button now counts this folder only, like the header does; open sessions in other folders are mentioned in the tooltip.

## 0.11.4

- The filter button is now called **Open** instead of *Active*: its number counts sessions that are open right now (working, waiting or idle, in any folder), which was easy to misread as "working". Its tooltip shows how many are in this folder and in other folders.

## 0.11.3

- **Codex: changed files work again with current Codex versions.** Recent Codex writes its edits as a script (`tools.apply_patch(...)` inside an `exec` call); those sessions showed no changed files at all. They are read now, failed patches are left out, and line counts only count lines that really changed. Checked against Codex's own per-file records in real logs: 2,094 of 2,132 edits found (98%).
- Codex review and sub-agent threads are folded into the session that started them instead of each showing up as its own session (341 log files in one month were really 12 sessions).
- Codex sessions that were started days ago and are still in use are found, and commits made by Codex are listed.
- New sessions (Claude Code and Codex) appear at the next check instead of after up to 30 seconds.
- Folder groups are easier to tell apart from sessions: an *Other folders* caption, a folder icon and a count pill on *Archived*. Sessions that ran in a git worktree are grouped under their repository with a *worktree* tag.
- Sessions that have neither a title nor a first question are hidden unless they are running or changed files.

## 0.11.2

- Folder groups for **other folders** now also list recent sessions that are not running, with the same timing as the main list (the `archiveAfter` setting, at most 14 days). Before, only running sessions of other folders were shown.

## 0.11.1

- **The "being edited" spinner now also works for files changed by scripts** (python, sed, formatters …). Claude Code often records nothing for those, so 0.11.0 only showed the spinner for its Edit/Write tools. A working session's files are now also checked on disk.
- **Choose when sessions move to Archived**: new setting `archiveAfter` and a clock button on the Archived section — same as Claude Code (default), 1 to 30 days, or never. Useful if you archive sessions by hand in Claude Code, which other extensions cannot see.
- Old sessions that have neither a title nor a first question (for example sessions that only received a message from another session) are left out of the list, as in Claude Code.

## 0.11.0

- **The Sessions view now lists the same sessions as Claude Code's own list.** This folder's sessions are shown even when nothing is running — before, a session disappeared after a restart until you opened it again. They are sorted by last conversation, newest first.
- **Archived section.** Sessions with no conversation for longer than Claude Code's *Archive Inactive Sessions* setting are collected in a collapsed *Archived* section, and a new archive button moves a session there by hand (restore brings it back). An archived session returns by itself when it gets a new message. Sessions archived by hand inside Claude Code cannot be detected.
- **Times are now based on the last conversation**, not on when the log file was last touched. A session that was only reopened no longer shows as *Just finished*.
- **Files being edited right now** get a green spinner in the Changed files view (a blue bell while an edit waits for your approval).
- Row buttons now appear only on the row under the mouse, in place of the time, so titles are no longer cut short to make room for them.
- New setting `sessionListDays` (default 90).
- If the Sessions view says *There is no data provider registered* after updating from 0.6.0, reload the window once.

## 0.10.0

- **Much faster first read**: large logs are read only from where the selected time range starts, and recent commits are read with one git call per repository instead of one per commit. In our test the first read went from about 4.5 s to 0.7 s (646 MB → 119 MB read, 150 → 10 git calls) with identical results.
- Sessions that were read first are shown while the rest is still loading.
- New setting `sessionDetails`: turn off the second line for a compact one-line list.
- *Review all changes* now tells you when files were left out because there is no recorded change to compare.
- Tests are part of the repository (`npm test`).

## 0.9.1

- The change-size tooltip now says what it counts: lines added and removed within the time range of the Changed files view, with every edit counted.

## 0.9.0

- **What it is doing now**: working and waiting sessions show their current step (*Running: …*, *Editing …*, *Thinking…*) on a second line; also in tooltips and the status bar tooltip.
- **Change size** per session: `+added −removed` and a five-square green/red bar.
- **Color legend** behind a new **?** button in the Sessions view.
- Checked in light themes.
- Description and keywords now mention Codex.
- Fixed: Claude Code's API request copies in the log were read as new tool calls, which made finished steps look unfinished and slowed the first read.

## 0.8.0

- **Review all changes**: one click opens every file a session changed in a multi-file diff. Edit-tool and commit-only files now compare against the file as the session left it, so other sessions' later edits don't get mixed in.
- **Status bar summary** of working · waiting · just finished sessions, with a warning color while a session waits for you.
- **Codex sessions** (`~/.codex/sessions`, `apply_patch` edits) shown with a *Codex* tag.
- Extra "waiting for you" signal from approval-hook marker files (`attentionMarkerDir`).
- Read cache: reopening VS Code no longer re-reads all logs (about 4 s → under 0.1 s in our test).
- File colors now follow git: green `A` created, yellow `M` modified, red `D` deleted, grey `?` guessed. The purple `C` and yellow `S` marks are gone.
- Fixed: diffs split into several hunks could show "Could not read the content".

## 0.7.1

- Sessions view toolbar: **New session**, **Active** (show running sessions only) and search by title.
- Screenshot in the README; source code and issue tracker on GitHub.
- No longer marked as preview.

## 0.7.0

- Sessions view redrawn with larger rows, like Claude Code's own session list.
- Status colors now match Claude Code: green working, blue waiting for you, orange just finished (last 10 minutes), grey idle.
- New "Just finished" state.

## 0.6.1

- Changed files view: sessions from other folders are grouped by folder and collapsed, like the Sessions view.

## 0.6.0

- English user interface by default; Korean is used automatically when VS Code's display language is Korean.

## 0.5.0 — first public preview

- Session status view: working / waiting (approval or answer) / idle / off, with time in state; current-folder sessions first, other folders grouped and collapsed.
- Changed files per session from Edit/Write results, Claude Code shell edit records, session commits and shell-command guesses.
- Click a session to open its Claude Code conversation; click a file to open a diff.
- Read-only; parsing on a worker thread with incremental reads.
