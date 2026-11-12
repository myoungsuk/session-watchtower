# Changelog

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
