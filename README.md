# Fireside

Fireside is a local multi-agent collaboration workspace for humans, Claude Code,
Codex CLI, and Gemini CLI. It gives agents a shared chat room, mission control
surface, permission prompts, run telemetry, saved briefings, context artifacts,
and task/checklist coordination.

This project is designed to run on your machine and call the provider CLIs that
are already installed and authenticated locally. It does not proxy through a
hosted Fireside service.

## Current Portability Status

Fireside is portable source code, but it is not yet a packaged desktop app.

It runs on Windows, macOS, and Linux with Node 20+ and the `claude`, `codex`,
and `gemini` CLIs available on `PATH`. The core server and Angular client are
standard Node/TypeScript. The native file/folder picker shells out to a
platform dialog: PowerShell `FolderBrowserDialog`/`OpenFileDialog` on Windows,
`osascript`'s `choose folder`/`choose file` on macOS, and `zenity` (with
`kdialog` as a fallback) on Linux. Linux users without either dialog tool will
need to install one to use the picker — typing paths manually still works.

## Prerequisites

- Node.js 20.10 or newer
- npm
- Git
- Claude Code CLI installed, authenticated, and available as `claude`
- Codex CLI installed, authenticated, and available as `codex`
- Gemini CLI installed, authenticated, and available as `gemini`

Run each provider CLI interactively once before using Fireside so it can finish
login, first-run setup, and local config creation.

## Quick Start

```powershell
git clone https://github.com/mattnb/fireside.git
cd fireside
npm install
Copy-Item .env.example .env
npm run verify:clis
npm run build
npm start
```

Open:

```text
http://127.0.0.1:8787
```

On macOS/Linux, use `cp .env.example .env` instead of `Copy-Item`.

## Development

For a single local server that serves the last built Angular bundle:

```powershell
npm run build:client
npm run dev:server
```

For live Angular reload and a separate backend:

```powershell
# terminal 1
npm run dev:server

# terminal 2
npm run dev:ui
```

The Angular dev server uses `client/proxy.conf.json` to reach the backend.

## Environment

Fireside loads `.env` automatically at server startup. Shell environment values
take precedence over `.env` values.

Copy `.env.example` to `.env` and adjust as needed.

Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIRESIDE_HOST` | `127.0.0.1` | HTTP/WebSocket bind host |
| `FIRESIDE_PORT` | `8787` | HTTP/WebSocket port |
| `FIRESIDE_DATA_DIR` | `./data` | SQLite DB, logs, fixtures, drafts, provider context |
| `FIRESIDE_UI_DIR` | auto | Static UI directory override |
| `FIRESIDE_MAX_PROMPT_CHARS` | `16000` | Upper bound for generated agent prompts |
| `FIRESIDE_LARGE_MESSAGE_CHARS` | `6000` | Threshold for writing large chat content to disk context |
| `FIRESIDE_RESUME_CLI_SESSIONS` | `true` | Reuse stored Claude/Codex/Gemini CLI sessions |
| `FIRESIDE_CODEX_MODEL` | unset | Optional Codex context telemetry model override |
| `FIRESIDE_CODEX_REASONING_EFFORT` | unset | Optional Codex reasoning label override |
| `FIRESIDE_CODEX_CONTEXT_WINDOW` | unset | Optional Codex context-window token override |
| `FIRESIDE_CODEX_AUTO_COMPACT_TOKENS` | unset | Optional Codex compaction threshold override |
| `LOG_LEVEL` | `info` | Server log level |

## Provider CLIs

Fireside shells out to local provider commands:

- Claude: `claude`
- Codex: `codex`
- Gemini: `gemini`

`npm run verify:clis` checks that those commands are installed and runnable. It
does not fully prove that every provider is authenticated. If an agent fails at
runtime, run that CLI directly in a terminal and finish any login or first-run
prompts.

## Runtime Data

Runtime data is intentionally ignored by git:

- `data/fireside.sqlite`
- `data/agent-context/`
- saved mission briefings
- attached fixtures and draft artifacts
- server logs
- local `.env`

Do not publish `data/` unless you intentionally want to share chat history,
mission state, local file paths, and provider session metadata.

## Useful Commands

```powershell
npm run verify:clis   # check provider CLI availability
npm run typecheck     # TypeScript typecheck
npm run lint          # ESLint
npm test              # Vitest suite
npm run build         # Angular client + server build
npm start             # run built app
```

## First Smoke Test

1. Start the app and open `http://127.0.0.1:8787`.
2. Create a room.
3. Use `Manage Agents` to choose Claude, Codex, and/or Gemini.
4. Optionally mark specific agents as `yolo` for autonomous multi-turn work.
5. Send a simple message such as:

```text
@codex reply with exactly: pong
```

You should see the run appear under the active work rail, then the agent reply
land in chat.

## Known Caveats

- The app is local-first and trusts your local CLI installations.
- Windows has the most testing miles. macOS and Linux paths are implemented
  but exercised less day-to-day.
- The native folder/file picker requires PowerShell on Windows, `osascript`
  on macOS (built in), and `zenity` or `kdialog` on Linux.
- Provider CLI output formats can change. Adapter tests cover current known
  behavior, but future CLI releases may require adapter updates.
- YOLO/full-auto modes can grant powerful local permissions. Use them only in
  rooms and paths where that is intentional.

## Publishing Checklist

Before pushing a public repo:

```powershell
git status --short
npm run verify:clis
npm run typecheck
npm run lint
npm test
npm run build
```

Confirm that `data/`, `.env`, logs, local SQLite files, and personal artifacts
are not staged.
