# Nutshell — VS Code Extension

Registers your workspace's docs folder with a running
`nutshell-server` so it shows up as a `<Name> (N)` row
on your G2 glasses. Also auto-spawns the server if none is running, copies API
keys, transforms existing docs into G2-friendly format, and more.

The extension is a **client**. It does not host the server itself. The server
is a separate process; the extension just talks to it over HTTP.

## Architecture

```text
 VS Code A (project Alpha)  ──┐
 VS Code B (project Beta)   ──┼──► nutshell-server (single process)
 VS Code C (project Gamma)  ──┘             │
                                            ▼
                                       Phone + Glasses
                                    (one row per project)
```

- First VS Code window to activate spawns the server (if none is running)
- Every window registers its own project with a stable UUID stored in
  `.vscode/nutshell-project-id`
- A 30 s heartbeat re-registers the project — automatic recovery from
  server restarts, no manual re-mapping needed
- Server survives VS Code closing; stops when every client unregisters and
  the last window that spawned it explicitly stops it

## Requirements

- VS Code ≥ 1.80
- Node 18+ (bundled with VS Code)
- A reachable `nutshell-server` on the configured port (auto-spawned by
  default)
- Optional: [Claude Code CLI](https://claude.ai/code) for the
  **Transform Docs for G2** feature. Not needed for pass-through or URL relay.

## Install (development)

```bash
cd nutshell-vscode
npm install   # links nutshell-server from the sibling folder
```

Then in VS Code: `F5` to launch an Extension Development Host window, or
package with `vsce package`.

## Quick start

1. Open a workspace folder
2. `Cmd+Shift+P` → **Nutshell: Configure for Workspace**
3. Pick a mode:
   - **Point at an existing folder** — serves your existing `docs/` folder as-is
   - **Transform existing docs into G2 format** — creates a gitignored
     `nutshell-docs/` mirror reformatted for the glasses (uses Claude Code)
   - **URL relay only** — no files, just the browser extension channel
4. The status bar shows a broadcast icon when running
5. **Nutshell: Copy API Key** — paste it into the phone app and browser extension

## Commands

| Command | What it does |
| --- | --- |
| Nutshell: Start Server | Adopt a running server, or spawn one if none is running |
| Nutshell: Stop Server | Stop **only** the server this extension spawned |
| Nutshell: Restart Server | Stop + start |
| Nutshell: Configure for Workspace | Interactive mode + project name + paths |
| Nutshell: Transform Docs for G2 | Re-run the full Claude Code transform |
| Nutshell: Copy API Key | Copy `.nutshell-api-key` contents to clipboard |
| Nutshell: Enter Server Key | Paste an externally-issued API key and save it to this workspace |
| Nutshell: Show Address and Key | Notification banner |
| Nutshell: Unregister This Project | Remove this workspace's project from the server |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nutshell.mode` | `passthrough` | `passthrough` / `transform` / `urlOnly` |
| `nutshell.sourceDocsPath` | `docs` | Folder to serve (passthrough) or read from (transform) |
| `nutshell.outputDocsPath` | `nutshell-docs` | Transform output folder (auto-gitignored). Use `.nutshell-docs` for a hidden variant. |
| `nutshell.port` | `4242` | Server port |
| `nutshell.name` | workspace folder name | Display name on the phone |
| `nutshell.autoStart` | `true` | Start automatically when the workspace opens |
| `nutshell.autoTransformOnSave` | `false` | Transform mode: re-transform a source file when saved |
| `nutshell.apiKey` | `""` | API key for an externally-started server. Saved to `.nutshell-api-key` on first heartbeat. |

## Transform flow

When you pick **Transform existing docs**:

1. The extension asks for the source folder (e.g. `docs/`) and an output folder
   (default `nutshell-docs/`)
2. Output folder is created and added to `.gitignore`
3. A `## Nutshell G2 docs mirror` section is appended to `CLAUDE.md`
   telling future LLMs how to keep the mirror in sync
4. Every `.md` / `.mdx` / `.txt` under the source is piped through `claude -p`
   with the reformat-note spec, and the output written to the matching path
   under the output folder
5. Server restarts pointing at the output folder

The spec lives in `nutshell-server/prompts/reformat-note.txt` — the same prompt
the phone app uses when reformatting notes on demand.

## Why in-process

Running the server inside the extension host means one VS Code window runs
one server. No port collisions from multiple terminals, no orphaned processes,
no child-process lifecycle management. When VS Code closes, the server closes
with it.
