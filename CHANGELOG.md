# Changelog

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
