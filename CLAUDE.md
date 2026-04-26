# CLAUDE.md — `nutshell-vscode`

Claude Code entry point. The canonical guide — architecture, commands,
conventions, gotchas, key-resolution order — lives in
[`AGENTS.md`](AGENTS.md). **Read it before making changes.**

This file only adds Claude-specific notes.

---

## Before editing code

1. Read [`AGENTS.md`](AGENTS.md).
2. For server-facing work, cross-reference the server repo's
   [`docs/api.md`](../nutshell-server/docs/api.md) — any wire change needs
   matching edits here (usually in `lib/server-client.js`).
3. For transform work, open [`docs/transform.md`](docs/transform.md) and
   the reformat spec at `../nutshell-server/prompts/reformat-note.txt`.

## Tooling quirks

- **No test suite.** Manual flow:
  1. Open this folder in VS Code, press `F5` → Extension Development Host
  2. In the host: `Cmd+Shift+P` → **Nutshell: Configure for Workspace**
  3. Watch the **Nutshell** output channel for heartbeat logs
- **`F5` uses `.vscode/launch.json`.** Don't delete it.
- **VS Code reloads the extension** when you save `extension.js` only if
  the dev host is using auto-reload. Usually easier to quit and re-press
  `F5`.
- **The `nutshell-server` dependency is a local file link** (`file:../nutshell-server`).
  Changing the server requires `npm install` here to pick up the new CLI.

## Transform flow needs the `claude` CLI

If you're running the `nutshell.transform` command during dev, ensure the
Claude Code CLI is on `PATH`. Otherwise the command fails fast with a
helpful error pointing to claude.ai/code.

## Key-exchange troubleshooting

If the heartbeat silently stops registering:

1. Check **Nutshell** output channel — a missing-key log line tells you the
   heartbeat is finding the server but not the key.
2. `Cmd+Shift+P` → **Nutshell: Enter Server Key** → paste the key shown in
   the server's terminal output.
3. If the key is still rejected, the server's
   `.nutshell-api-key` may have rotated — copy the current value from the
   server's CWD.

## Memory

The assistant's structured scratch lives in
[`../loggingagent.md`](../loggingagent.md) at the workspace root.
Project knowledge goes in AGENTS.md and docs/; never copy logging-agent
content into project docs.

## Style

- Logs go through `log()` → the output channel. Don't use `console.log`.
- No emojis (VS Code codicons like `$(radio-tower)` are fine — those are
  icons, not decoration).
- CommonJS only — the VS Code extension API requires it.
