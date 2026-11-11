# Changelog

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
