# Session Watchtower for Claude Code

**See what every Claude Code session is doing — and exactly which files it touched.**

> Unofficial community extension. Not affiliated with or endorsed by Anthropic.

![Session Watchtower: sessions and changed files side by side](media/screenshot.png)

*Screenshot with demo data.*

## Features

- **Session status at a glance** — a roomy list in the same colors as Claude Code's session list: green working, blue waiting for your approval or answer, orange just finished, grey idle, hollow off — plus how long it has been in that state. Sessions in the current folder come first; sessions from other folders are grouped and collapsed below. A badge counts sessions that are waiting for you.
- **Changed files per session** — edits from Claude's Edit/Write tools, shell commands and git commits, with `+added −removed` line counts and times. Click a file to open a diff.
- **Jump to the conversation** — click a session to open it in Claude Code, or start a new one with **New session**.
- **Find sessions fast** — **Active** shows only running sessions; the search box filters by title.
- **Read-only and light** — never modifies your files. Parsing runs on a worker thread, and after the first pass only newly appended log lines are read.

## Where the data comes from

| Mark | Source | Accuracy |
|---|---|---|
| `M` / `A` | Results of Claude's Edit / Write tools | Exact |
| `M` / `A` | Claude Code's own records of files changed by shell commands (`bashEditDiff`) | Exact |
| `C` | Git commits made while the session's commit command ran | Exact |
| `S` (yellow) | Parsed from shell commands (`>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `touch`) and file modification time | Best effort |

Session status (working · waiting · idle) is read from the files Claude Code writes in `~/.claude/sessions/`. A session that became idle within the last 10 minutes is shown as *just finished*. A session that is not listed there is shown as *off*.

## Privacy

Everything stays on your machine. The extension only reads `~/.claude/projects` and `~/.claude/sessions` (and runs `git` in your repositories to list commit files). It makes no network requests and collects no telemetry.

## Requirements and limitations

- Claude Code must run on the same machine as the extension. Over Remote-SSH the extension runs on the remote host automatically.
- It relies on Claude Code's internal, undocumented file formats. A Claude Code update may break parts of it.
- Opening a conversation uses an internal Claude Code command (tested with Claude Code 2.1.322).
- Files written by scripts that Claude Code does not record and that are never committed cannot be detected.
- Codex sessions are not supported.
- The user interface is in English, and switches to Korean automatically when VS Code's display language is Korean.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeSessionChanges.lookbackHours` | 24 | How many hours of changes to show. Running sessions are always listed. |
| `claudeSessionChanges.showShellGuesses` | true | Show files guessed from shell commands (`S`). |
| `claudeSessionChanges.hideScratchpadFiles` | true | Hide Claude's throwaway scratchpad files (git worktrees inside it stay visible). |
| `claudeSessionChanges.includeSubagents` | true | Include files changed by subagents under their parent session. |
| `claudeSessionChanges.pollSeconds` | 5 | How often to check for new log lines while the view is visible. |

## Feedback and contact

Questions, bug reports and ideas are welcome: **k4858678@gmail.com**

## 한국어 요약

Claude Code 세션마다 지금 **작업 중인지 · 멈춰서 기다리는지 · 쉬는지**와 그 세션이 바꾼 파일을 한 창에서 봅니다. 이 폴더 세션이 위에, 다른 폴더 세션은 접힌 묶음으로 아래에 나옵니다. 세션을 누르면 Claude 대화 창이 열립니다. 파일은 읽기만 하며, 기록은 이 컴퓨터 밖으로 나가지 않습니다.

문의·버그 제보·아이디어: **k4858678@gmail.com**
