# Architecture

`nutshell-vscode` is a VS Code extension that **embeds** `nutshell-server`
inside the VS Code extension host process. When you open a workspace, it
spins up the server pointing at the workspace's docs folder; when VS Code
closes, the server shuts down with it.

This is different from most "developer tool" extensions that shell out to
a CLI. VS Code extensions run in Node.js, so we can just `require` the
server library and call `createServer()` directly — no subprocess, no port
management, no log forwarding, no orphaned daemons.

## Flow

```text
VS Code starts with workspace open
         │
         ▼
   extension activates
         │
         ▼
   probe GET /health on nutshell.port
         │
    ┌────┴────────────────────────────────────┐
    │                                         │
  server running                           nothing
    │                                         │
    ▼                                         ▼
 adopt it                              spawn nutshell-server
    │                                  (detached child, writes
    ▼                                   .nutshell-server.pid)
 read .nutshell-api-key                        │
    │                                         ▼
    │                                    wait for /health
    │                                         │
    └────────────────────┬────────────────────┘
                         ▼
               POST /projects/register
                 {id, name, docsPath}
                         │
                         ▼
                 30 s heartbeat timer
                  (re-register, refresh
                   status bar)

VS Code closes
         │
         ▼
   POST /projects/unregister
   (best-effort; server keeps running)
```

## Files

```text
nutshell-vscode/
├── package.json              # VS Code manifest (commands, config, activation)
├── extension.js              # activate/deactivate + commands + heartbeat
├── lib/
│   ├── crypto.js             # Node-side PSK AES-GCM (mirrors server)
│   ├── server-client.js      # /health probe, spawn/kill, register/unregister
│   ├── project-id.js         # .vscode/nutshell-project-id UUID helper
│   ├── transform.js          # spawn `claude -p` per file, write output
│   ├── gitignore.js          # ensure nutshell-docs/ is in .gitignore
│   └── claude-md.js          # append harness block to CLAUDE.md
├── .vscode/launch.json       # F5 configuration for the dev-host
├── .vscodeignore
├── docs/                     # This folder
└── README.md                 # High-level overview
```

## Commands

All registered in `package.json` under `contributes.commands`, handled in
`extension.js`. See [`commands.md`](commands.md) for the full reference.

```text
nutshell.start          ← Start the embedded server
nutshell.stop           ← Stop it
nutshell.restart        ← stop + start
nutshell.configure      ← Interactive mode + path picker
nutshell.transform      ← Run the G2 doc transform
nutshell.copyKey        ← Copy API key to clipboard
nutshell.showBanner     ← Notification with address + key
nutshell.showMenu       ← QuickPick menu (status bar click target)
```

## Settings surface

```json
{
  "nutshell.mode": "passthrough" | "transform" | "urlOnly",
  "nutshell.sourceDocsPath": "docs",
  "nutshell.outputDocsPath": "nutshell-docs",
  "nutshell.port": 4242,
  "nutshell.name": "",
  "nutshell.autoStart": true,
  "nutshell.autoTransformOnSave": false
}
```

Changes to these trigger a restart of the server so the new config takes
effect. Watched by `vscode.workspace.onDidChangeConfiguration`.

## Server lifecycle

- **Startup**: if `autoStart` is true AND a workspace folder is open, the
  extension calls `startServer()` on activation. The server's `docsPath` is
  resolved against the first workspace folder's root; its `keyFilePath` is
  `<root>/.nutshell-api-key` so keys survive across VS Code restarts for
  the same workspace
- **Shutdown**: `deactivate()` calls `server.stop()`. Also called on any
  error during startup (e.g. `EADDRINUSE` — port in use, usually because
  a `nutshell-server` CLI is also running)
- **Restart**: on config change or explicit command. Just stop + start.
  State (connected WS clients) is lost on restart

## Three serving modes

`nutshell.mode` drives what the server is configured with:

### `passthrough`

Server's `docsPath` = `<workspace>/<sourceDocsPath>`. Files are served
as-is; the watcher broadcasts edits.

```text
.
└── docs/
    ├── README.md
    └── guides/getting-started.md
      → served verbatim to the glasses
```

### `transform`

Server's `docsPath` = `<workspace>/<outputDocsPath>`. The extension expects
the user to populate that folder via the **Transform Docs for G2** command
(or enable `autoTransformOnSave`).

```text
.
├── docs/                      ← source (human-editable)
│   └── README.md
└── nutshell-docs/             ← auto-generated mirror, gitignored
    └── README.md              ← G2-formatted version
      → served to the glasses
```

Side effects when you first configure transform mode:

1. Output folder added to `.gitignore` (see `lib/gitignore.js`)
2. A `## Nutshell G2 docs mirror` block appended to `CLAUDE.md` inside
   marker tags (see `lib/claude-md.js`)

### `urlOnly`

Server's `docsPath` = `null`. No file serving; just URL relay + (optionally)
the LLM proxy. Useful when the workspace isn't a docs project and the user
only cares about the browser-extension flow.

## Transform implementation

See [`transform.md`](transform.md) for the full flow.

TL;DR: the extension walks the source folder, runs each `.md`/`.mdx`/`.txt`
file through `claude -p` with the reformat harness (loaded from
`nutshell-server/prompts/reformat-note.txt`), and writes the transformed
output to the mirror path.

## Status bar

```text
$(radio-tower) Nutshell      ← running (normal background)
$(circle-slash) Nutshell     ← stopped (warning background)
```

Click → runs `nutshell.showMenu`, which shows a QuickPick of available
commands based on current state.

## Why child process, not in-process embed

Earlier versions (0.1.x) embedded `createServer()` directly in the extension
host. That worked but caused problems:

- **Port conflicts** — if you ran `nutshell-server` from a terminal *and*
  opened VS Code, both tried to own `:4242`
- **Many-to-one didn't fit** — opening two VS Code windows tried to start
  two servers. The user wanted one server, many clients
- **Lifecycle confusion** — closing VS Code killed the server, which broke
  phone connections mid-session

The 0.2.0 model: **one server, many clients.** The extension:

- Never imports `createServer()` at runtime
- Spawns `nutshell-server` as a detached child using the sibling package's
  CLI, or falls back to a globally installed `nutshell-server` on PATH
- Tracks the PID in `.nutshell-server.pid` so **Stop Server** knows what to
  kill (only kills what this extension spawned — won't touch manually-started
  servers)
- Survives VS Code close: the detached process stays alive, the phone keeps
  streaming

`nutshell-server` is still a dev dependency so we can find its CLI for the
local-sibling development flow. At runtime it's just invoked as a
subprocess.

## Security touch points

- Keys are stored under the workspace root in `.nutshell-api-key` — same
  file pattern as the standalone server. Make sure the workspace has that
  file in its gitignore (the user's responsibility, not ours — we don't
  auto-gitignore it because the file might legitimately live outside the
  repo)
- The extension never reaches the internet. It serves content from disk
  and proxies to `localhost:11434` if Ollama is configured

## Key resolution order

The heartbeat resolves the API key in this order:

1. **`<workspace>/.nutshell-api-key`** — written by the extension when it
   spawns the server itself (the normal path)
2. **`nutshell.apiKey`** workspace setting — fallback for when the server was
   started outside VS Code (e.g. `npm run start:llm` from the server folder,
   which writes the key file in that folder, not in the workspace). When this
   setting is used, the extension persists it to `.nutshell-api-key` on first
   heartbeat so future reads find it via path 1
3. **Prompt** — if neither source yields a key but `/health` reports a server
   running, the extension fires a one-time `showWarningMessage` with an
   **Enter Key** button that routes to the `nutshell.enterKey` command

If all three paths are exhausted, the heartbeat logs the miss to the output
channel and bails out without registering. The status bar stays in the
"server up, no project" state so the user can tell something's off.

## Open issues

- **No `devDependencies`** — no `@types/vscode` or bundler configured yet.
  For publishing you'd want these + `vsce package`
- **No tests** — VS Code extension testing needs `vscode-test`. Manual
  testing via F5 (Extension Development Host) is the current flow
- **One workspace folder assumed** — multi-root workspaces pick the first
  folder. Could be smarter

## See also

- [`transform.md`](transform.md) — G2 doc transform flow
- [`commands.md`](commands.md) — full command reference
- `../README.md` — install + quickstart
- `../../nutshell-server/docs/architecture.md` — server internals
