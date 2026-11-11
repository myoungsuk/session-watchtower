# Changelog

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
