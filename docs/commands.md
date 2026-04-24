# Command reference

All commands are available via the command palette (`Cmd+Shift+P` on macOS,
`Ctrl+Shift+P` on Linux/Windows). They're grouped under the **Nutshell**
category.

## `Nutshell: Start Server`

- **ID**: `nutshell.start`
- Probes `localhost:<port>/health`. If a server is already running, adopts it.
  Otherwise spawns `nutshell-server` as a detached child process
- Writes the child's PID to `.nutshell-server.pid` in the workspace root so
  **Stop Server** can find it later even across VS Code restarts
- Logs go to `.nutshell-server.log` (gitignored)

## `Nutshell: Stop Server`

- **ID**: `nutshell.stop`
- Kills the server process **only** if this extension spawned it (tracked via
  `.nutshell-server.pid`). Manually-started servers aren't touched
- Does NOT unregister our project — the server process going away drops
  everything. Use **Unregister This Project** if you want to stay running
  but drop this workspace's project

## `Nutshell: Restart Server`

- **ID**: `nutshell.restart`
- Stop + start. Equivalent to changing a `nutshell.*` setting (config
  changes auto-restart)

## `Nutshell: Configure for Workspace`

- **ID**: `nutshell.configure`
- Interactive QuickPick flow:
  1. Pick serving mode (passthrough / transform / urlOnly)
  2. For passthrough → pick the source folder
  3. For transform → pick source folder + output folder, then optionally
     run the transform immediately
  4. For urlOnly → no further prompts
- Writes choices into `.vscode/settings.json` (workspace-scoped) so they
  survive VS Code restarts
- For transform: also adds the output folder to `.gitignore` and appends
  the harness block to `CLAUDE.md`

## `Nutshell: Transform Docs for G2`

- **ID**: `nutshell.transform`
- **Transform mode only.** Re-runs the full G2 reformat across the source
  folder, writing outputs to the mirror folder
- Requires the `claude` CLI to be on PATH. If it isn't, the command fails
  with a helpful error (install Claude Code from claude.ai/code)
- Shows a progress notification with per-file status
- If `nutshell.autoTransformOnSave` is enabled, individual saves in the
  source folder auto-trigger a single-file re-transform — but the full
  command is still useful when many files have changed

## `Nutshell: Copy API Key`

- **ID**: `nutshell.copyKey`
- Copies the server's current API key to the clipboard
- Works even when the server is stopped (reads from `.nutshell-api-key` in
  the workspace root)
- Shows a confirmation toast
- If no key is found, offers to run **Enter Server Key** instead

## `Nutshell: Enter Server Key`

- **ID**: `nutshell.enterKey`
- Prompts for an API key (shown in the server's terminal output) and saves it
  to `<workspace>/.nutshell-api-key`
- Use this when the server was started **outside** VS Code (e.g. `npm run
  start:llm` from the `nutshell-server` folder). In that case the key file
  lives in the server's cwd, not in your workspace — without it, the extension
  has nothing to authenticate with and the heartbeat bails silently
- Also re-runs the heartbeat immediately so the project registers without
  waiting 30 s
- Alternative: set `nutshell.apiKey` in settings — the extension copies it
  into the key file on first heartbeat, so you only have to set it once

## `Nutshell: Show Address and Key`

- **ID**: `nutshell.showBanner`
- Shows a notification with `localhost:<port>` and offers **Copy key** /
  **Copy address** buttons
- Useful when you need to share the key with another device on the LAN

## `Nutshell: Unregister This Project`

- **ID**: `nutshell.unregister`
- POSTs `/projects/unregister` to drop this workspace's project from the
  server's registry. Useful for cleaning up stale projects from crashed
  VS Code sessions without restarting the server
- The next extension activation will re-register automatically via heartbeat

## `Nutshell: Show Menu` (internal)

- **ID**: `nutshell.showMenu`
- Bound to the status bar item click. Opens a QuickPick with the most
  common commands (start/stop, restart, configure, transform, copy key,
  enter server key, show banner) filtered to what makes sense given the
  current state
- Not usually run from the command palette directly, but not hidden

## Keybindings

No default keybindings ship. Users can assign them via the standard
**Preferences: Open Keyboard Shortcuts** → search for "Nutshell".

Suggested:

| Command | Suggested binding |
| --- | --- |
| `nutshell.showMenu` | `cmd+alt+n` (menu is the easiest catch-all) |
| `nutshell.copyKey` | `cmd+alt+shift+n` |

## See also

- [`architecture.md`](architecture.md) — how the extension works
- [`transform.md`](transform.md) — transform flow details
