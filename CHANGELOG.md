# Changelog

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
