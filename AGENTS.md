# Repository Guide for AI Coding Agents — `nutshell-vscode`

Canonical onboarding file for agents contributing to the VS Code extension.
Read top-to-bottom before touching code. [CLAUDE.md](CLAUDE.md) delegates
here plus adds Claude-specific notes.

---

## What this is

`nutshell-vscode` is a VS Code extension that **registers your workspace's
docs folder as a project with a running `nutshell-server`**, so the docs
show up as a `<Name> (N)` row on your Even Realities G2 glasses.

Design principle: **the extension is a client, not a host.** Earlier 0.1.x
versions embedded the server in-process — that caused port collisions when
the server was also running manually, and made it awkward to run multiple
VS Code windows against one shared server. Since 0.2.0 the extension either
adopts an already-running server or spawns one as a detached child
process (tracked via `.nutshell-server.pid`).

Bonus features:

- **Transform** mode: pipes your existing docs through `claude -p` with a
  reformat spec to produce a G2-friendly mirror folder, auto-gitignored.
- **Copy API Key** / **Enter Server Key** commands for the key-exchange
  flow with the phone and browser extension.

Published to the VS Code Marketplace (planned) as `nutshell`.

---

## Quick start (development)

```bash
cd nutshell-vscode
npm install   # links `nutshell-server` from ../nutshell-server
# In VS Code: F5 → Extension Development Host window
```

In the host window: `Cmd+Shift+P` → **Nutshell: Configure for Workspace**,
pick a mode, run. Or **Nutshell: Start Server** to just launch the server.

---

## Repo layout

```
.
├── package.json           # VS Code manifest — commands, config, activation
├── extension.js           # activate/deactivate + command handlers + heartbeat
│
├── lib/
│   ├── crypto.js          # Node PSK AES-GCM (mirrors nutshell-server/lib/crypto.js)
│   ├── server-client.js   # probe/spawn/kill server; register / push / admin endpoints
│   ├── project-id.js      # ensure UUID in .vscode/nutshell-project-id
│   ├── doc-sources.js     # multi-folder symlink root + resolveDocSources helper
│   ├── push-driver.js     # remote-mode chokidar watcher + snapshot/upsert/delete
│   ├── transform.js       # spawn `claude -p` per file, write reformatted output
│   ├── gitignore.js       # ensure transform output folder is gitignored
│   └── claude-md.js       # append "nutshell mirror" harness to CLAUDE.md
│
├── .vscode/launch.json    # F5 config for the dev host
├── docs/
│   ├── architecture.md    # How the extension works (key resolution, lifecycle)
│   ├── commands.md        # Every command + its ID
│   └── transform.md       # G2 reformat flow
│
├── AGENTS.md · CLAUDE.md · README.md
└── .vscodeignore          # Files to exclude from the packaged .vsix
```

---

## Core architecture

### Server lifecycle

```text
VS Code activates
     │
     ▼
probe GET /health on nutshell.port
     │
┌────┴───────────────────────────────────────┐
│                                            │
server running                          nothing
     │                                       │
     ▼                                       ▼
adopt it                            spawn nutshell-server
     │                              (detached, --no-docs,
     │                               writes .nutshell-server.pid)
     │                                       │
     ▼                                       ▼
read .nutshell-api-key                wait for /health
     │                                       │
     └───────────────────┬───────────────────┘
                         ▼
            ┌────────────┴────────────┐
            │                         │
       fs mode (local)         push mode (remote)
            │                         │
            ▼                         ▼
   POST /projects/register    POST /projects/register
   {id, name, docsPath}       {id, name, files: [...]}
                                      │
                                      ▼
                              chokidar watches local
                              source roots; on change
                              POST /projects/files/upsert
                              on unlink
                              POST /projects/files/delete
            │                         │
            └────────────┬────────────┘
                         ▼
                 30 s heartbeat timer
                 — fs mode: idempotent re-register
                 — push mode: re-snapshot only when our
                   id is missing from /health.projectIds
```

On `deactivate`: best-effort `POST /projects/unregister`. The server stays
running — that's intentional so the phone keeps streaming even after the
VS Code window closes. "Stop Server" only kills processes *this* extension
spawned (tracked via `.nutshell-server.pid`).

### Key resolution order

The heartbeat tries three sources, in order, to find the PSK:

1. **`<workspace>/.nutshell-api-key`** — the normal path. Present when the
   extension spawned the server itself (server writes key to its CWD =
   workspace root).
2. **`nutshell.apiKey`** workspace setting — fallback for when the server
   was started outside VS Code (e.g. `npm run start:llm` from the server
   folder, which writes the key to *that* folder, not your workspace). On
   first use this setting's value is copied into `.nutshell-api-key` so
   future reads find it via path 1.
3. **One-shot prompt** — if neither source yields a key but `/health`
   reports a running server, the extension fires a one-time warning
   notification with an **Enter Key** button → `nutshell.enterKey` command
   → `showInputBox` → save to `.nutshell-api-key`.

If all three paths fail, the heartbeat logs the miss and bails silently.
Status bar stays in the "server up, no project" state so the user can tell.

### Modes (`nutshell.mode` setting)

| Mode | Source folder | Use when |
|---|---|---|
| `passthrough` | `<workspace>/<sourceDocsPath>` | You have a docs folder already in the right shape |
| `transform` | `<workspace>/<outputDocsPath>` | You want to reformat existing docs into a G2-friendly mirror |
| `urlOnly` | `null` | Workspace isn't a docs project — just want browser-extension URL relay |

Changing `nutshell.*` settings disposes the push driver (in remote mode)
and triggers a fresh heartbeat — the next register snapshots with the
new settings (via `onDidChangeConfiguration`).

### Server modes (`nutshell.serverMode` setting)

This setting decides whether the extension talks to a local server it
can spawn, or a remote one it can only call. It also drives **how**
project files reach the server:

| Server mode | How files get there | Live updates |
|---|---|---|
| `local`  | `POST /projects/register {docsPath}`. Server reads disk via chokidar. | Server's chokidar broadcasts file events. |
| `remote` | `POST /projects/register {files: [...]}` snapshot, then `POST /projects/files/upsert` and `/delete` per change. Server caches in memory. | Extension's chokidar (in `lib/push-driver.js`) watches local source roots and pushes events. |

Push mode (remote) doesn't materialize the `.nutshell-docs-root/` symlink
folder on disk — it walks the configured source roots directly and namespaces
file IDs the same way (`<linkName>/<rel>` for multi-source, bare relative
path for single-source) so the phone sees the same content layout in either
mode.

The push driver's lifecycle:

- Created lazily on the first remote-mode heartbeat.
- `snapshot()` scans every source root, `POST /projects/register` with the
  full set, then starts the chokidar watcher (with `awaitWriteFinish` so
  half-saved files aren't read).
- Subsequent heartbeats are no-ops as long as our project's UUID is in
  `health.projectIds`. If the server restarts and the id is gone, the
  next heartbeat re-snapshots and re-pushes everything.
- Disposed on serverMode flip, deactivate, or any `nutshell.*` config
  change (so the next heartbeat rebuilds with fresh settings).

### Project identity

UUID v4 generated by `ensureProjectId()` on first activation, persisted to
`.vscode/nutshell-project-id`. The server uses this ID as the primary key
for the project, so renaming the workspace display name or moving the
docs folder doesn't duplicate the project.

### Transform flow

See [`docs/transform.md`](docs/transform.md) for the full spec. Short
version:

1. Walk `sourceDocsPath` for `.md` / `.mdx` / `.txt`.
2. Pipe each file through `claude -p` with the reformat harness (loaded
   from `../nutshell-server/prompts/reformat-note.txt`).
3. Write the output to the matching path under `outputDocsPath`.
4. Add the output folder to `.gitignore`.
5. Append a "Nutshell G2 docs mirror" harness block to `CLAUDE.md` so
   future LLMs know to keep the mirror in sync.

Requires the `claude` CLI on PATH. Fails with a helpful message if missing.

---

## Commands

Full reference in [`docs/commands.md`](docs/commands.md). At a glance:

| Command | ID | What it does |
|---|---|---|
| Nutshell: Start Server | `nutshell.start` | Adopt running server or spawn one |
| Nutshell: Stop Server | `nutshell.stop` | Kill *only* servers this extension spawned |
| Nutshell: Restart Server | `nutshell.restart` | stop + start |
| Nutshell: Configure for Workspace | `nutshell.configure` | Interactive mode + paths + name |
| Nutshell: Transform Docs for G2 | `nutshell.transform` | Re-run the full reformat |
| Nutshell: Copy API Key | `nutshell.copyKey` | Clipboard the key file contents |
| Nutshell: Enter Server Key | `nutshell.enterKey` | Paste externally-issued key into this workspace |
| Nutshell: Show Address and Key | `nutshell.showBanner` | Notification with copy actions |
| Nutshell: Unregister This Project | `nutshell.unregister` | Drop this workspace from the server's registry |
| `nutshell.showMenu` | (internal) | Status-bar click target — QuickPick of common commands |

---

## Conventions

### Code style

- CommonJS (`require`/`module.exports`). The extension API is CJS-only.
- Node 18+ (bundled with VS Code ≥ 1.80).
- No bundler. `extension.js` is the entry; `lib/` files are required as-is.
- **No emojis in log output.** `outputChannel` gets lines like
  `[2026-04-24T12:00:00Z] heartbeat register failed: ...`. The status bar
  uses VS Code's built-in `$(radio-tower)` / `$(circle-slash)` icons —
  those are codicons, not emojis.

### Logging

All logs go through `log()` → `outputChannel.appendLine(...)`. Click the
**Nutshell** output channel in VS Code to see them. Don't write to
`console.log` from extension code — the output panel is easier to grep and
survives window reloads.

### Versioning

- `package.json` version bumps for any release.
- Patch for bug fixes, minor for new commands/settings, major for breaking
  config changes.
- Reminder — the sibling server's `package.json` tracks its own version.
  Don't bump it from here.

---

## What NOT to do

- **Don't embed `createServer()` from `nutshell-server` at runtime.** That's
  the pre-0.2.0 pattern that caused port collisions. The dependency exists
  in `package.json` only so we can resolve the CLI path for dev. At runtime
  we spawn the CLI as a detached child.
- **Don't kill servers you didn't spawn.** `stopServer` checks
  `.nutshell-server.pid` — only kills the process recorded there.
- **Don't commit `.nutshell-api-key`, `.nutshell-server.pid`, or
  `.nutshell-server.log`.** All gitignored; verify before staging.
- **Don't block activation on network.** The `onStartupFinished` activation
  event + lazy heartbeat is the right pattern. Never `await` a server
  request in `activate()` — that hangs the window if the server is slow.
- **Don't prompt the user repeatedly.** The `keyPromptShown` flag ensures
  the "Enter Key" warning fires once per session; don't shortcut around it.
- **Don't rename the extension ID (`nutshell`) or command prefix.** VS Code
  settings (`nutshell.*`) and command IDs are the public contract.

---

## Related

### Sibling repos

| Repo | Relationship |
|---|---|
| [`nutshell-server`](https://github.com/double-r-squared/nutshell-server) | The server we spawn and register projects with |
| [`nutshell-browser`](https://github.com/double-r-squared/nutshell-browser) | MV3 extension sharing the same PSK scheme |
| [`even` (phone app)](https://github.com/refact0r/even) | Reads projects we register and renders them on the glasses |

### Docs

- [`docs/architecture.md`](docs/architecture.md) — extension internals + key resolution order
- [`docs/commands.md`](docs/commands.md) — every command in detail
- [`docs/transform.md`](docs/transform.md) — the reformat pipeline
- [`README.md`](README.md) — user-facing overview
