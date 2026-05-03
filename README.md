<p align="center">
  <img src="./icon.png" width="128" height="128" alt="Nutshell" />
</p>


<h1 align="center">Nutshell</h1>


<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=nutshell-app.nutshell-vscode"><img src="https://img.shields.io/badge/Install-VS%20Code%20Marketplace-blue" alt="Install on Marketplace" /></a>
</p>

<p align="center">
  Read your project's docs hands-free on Even Realities G2 smart glasses.
</p>

Drops a Nutshell row on your glasses for every VS Code window you open. Pick
**passthrough** to serve your existing `docs/` folder as-is, **transform** to
reformat your docs into a glasses-friendly mirror via Claude Code, or **URL
relay only** if you just want to ship browser-extension URLs through this
window's machine. Multiple VS Code windows share one local Nutshell server; a
30-second heartbeat keeps the project list on the phone in sync without manual
re-mapping.

> **What this isn't.** Nutshell only makes sense if you own a pair of Even
> Realities G2 smart glasses. Without the glasses + the companion phone app,
> the extension has nothing to send to.

Or from VS Code: `Cmd+Shift+P` → **Extensions: Install Extensions** → search
"Nutshell". Or grab the latest `.vsix` from the
[Releases](https://github.com/double-r-squared/nutshell-vscode/releases) page.

## 30-second quickstart

1. **Install the server.** It lives at
   [github.com/double-r-squared/nutshell-server](https://github.com/double-r-squared/nutshell-server).
   Clone it anywhere on your machine:

   ```bash
   git clone https://github.com/double-r-squared/nutshell-server.git
   cd nutshell-server
   npm install
   node bin/cli.js
   ```

   The server's startup banner prints a QR code with the host + API key. Keep
   the terminal open.

2. **Pair your phone.** Open the Nutshell phone app, scan the QR code from
   the server's banner. The phone connects, the glasses light up.

3. **Configure your VS Code workspace.** Open any folder, then:

   `Cmd+Shift+P` → **Nutshell: Configure for Workspace**

   The extension picks up the running server, registers your project, and
   starts heartbeating. The folder shows up as a row on your glasses
   instantly.

4. **Glance at your docs.** Look up at your glasses; scroll through your
   docs with the touchpad on the temples. Both hands stay on the keyboard.

That's it.

## Three modes

When you run **Configure for Workspace**, you pick how docs reach the
glasses:

- **Pass-through** *(default)* — the extension serves your existing
  `docs/` folder verbatim. Best when your docs are already short and
  glasses-friendly.
- **Transform** — the extension reformats your existing docs into a
  gitignored `nutshell-docs/` mirror sized for the 999-byte HUD container.
  Uses the [Claude Code CLI](https://claude.ai/code) for the rewrite step.
- **URL relay only** — no files. Just the channel for the
  [browser extension](https://github.com/double-r-squared/nutshell-browser)
  to ship URLs over to the phone for on-demand reading.

## How it fits together

```text
 VS Code A (project Alpha)  ──┐
 VS Code B (project Beta)   ──┼──► nutshell-server (one process)
 VS Code C (project Gamma)  ──┘             │
                                            ▼
                                       Phone + Glasses
                                    (one row per project)
```

- First VS Code window to activate spawns the server (if none is running).
- Each window registers its own project under a stable UUID stored in
  `.vscode/nutshell-project-id`.
- A 30-second heartbeat re-registers the project — server restarts and
  laptop sleeps recover automatically; no manual re-mapping.
- Server survives VS Code closing; stops when every client unregisters.

## The four pieces of Nutshell

- **Nutshell** — the phone app, available on Even Hub. Pairs with the G2 glasses and renders everything you see.
- **[nutshell-server](https://github.com/double-r-squared/nutshell-server)** — the local server the phone app connects to. Required.
- **nutshell-vscode** *(this one)* — the VS Code extension. Streams your project's docs to the glasses while you code.
- **[nutshell-browser](https://github.com/double-r-squared/nutshell-browser)** — the browser extension. One-click sends the current tab to your glasses for later reading.

## Commands

| Command | What it does |
| --- | --- |
| Nutshell: Configure for Workspace | Interactive mode + project name + paths |
| Nutshell: Start Server | Adopt a running server, or spawn one if none is running |
| Nutshell: Stop Server | Stop **only** the server this extension spawned |
| Nutshell: Restart Server | Stop + start |
| Nutshell: Connect to Remote Server | Point at an externally-managed server (host + port + key) |
| Nutshell: Use Local Server | Switch back to local mode |
| Nutshell: Transform Docs for G2 | Re-run the full Claude Code transform |
| Nutshell: Copy API Key | Copy `.nutshell-api-key` contents to clipboard |
| Nutshell: Enter Server Key | Paste an externally-issued API key |
| Nutshell: Show Address and Key | Notification banner with host + key |
| Nutshell: Unregister This Project | Remove this workspace's project from the server |
| Nutshell: Discover Doc Folders | Scan the workspace for likely docs folders |
| Nutshell: Add Doc Source Folder | Append a folder to `nutshell.docSources` |
| Nutshell: Manage Doc Sources | Edit / remove existing entries |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nutshell.mode` | `passthrough` | `passthrough` / `transform` / `urlOnly` |
| `nutshell.serverMode` | `local` | `local` (extension manages the server) or `remote` (connect only) |
| `nutshell.host` | `localhost` | Server host. Set via **Connect to Remote Server** in remote mode. |
| `nutshell.port` | `4242` | Server port |
| `nutshell.name` | workspace folder name | Display name on the phone |
| `nutshell.sourceDocsPath` | `docs` | Folder to serve (passthrough) or read from (transform) |
| `nutshell.outputDocsPath` | `nutshell-docs` | Transform output folder (auto-gitignored) |
| `nutshell.docSources` | `[]` | List of folders to aggregate under one project. Symlinked into `.nutshell-docs-root/` when set. |
| `nutshell.autoStart` | `true` | Spawn the server when the workspace opens (local mode only) |
| `nutshell.autoTransformOnSave` | `false` | Transform mode: re-transform a source file on save |
| `nutshell.ollama` | `false` | When spawning the server, enable the local LLM proxy |
| `nutshell.ollamaModel` | `llama3.2:3b` | Ollama model |
| `nutshell.ollamaUrl` | `http://localhost:11434` | Ollama daemon address |
| `nutshell.apiKey` | `""` | API key for an externally-started server |

## Requirements

- VS Code ≥ 1.80
- Node 18+ (bundled with VS Code)
- A reachable `nutshell-server` (auto-spawned by default)
- Optional: [Claude Code CLI](https://claude.ai/code) for the **Transform**
  feature

## Transform flow

When you pick **Transform existing docs**:

1. The extension asks for source + output folders (defaults: `docs/` →
   `nutshell-docs/`).
2. Output is created and added to `.gitignore`.
3. A `## Nutshell G2 docs mirror` section is appended to `CLAUDE.md`
   so future LLM-assisted edits keep the mirror in sync.
4. Every `.md` / `.mdx` / `.txt` under the source is piped through
   `claude -p` with the reformat-note spec; the output writes to the matching
   path under the output folder.
5. The server restarts pointing at the output folder.

The reformat spec lives in
[`nutshell-server/prompts/reformat-note.txt`](https://github.com/double-r-squared/nutshell-server/blob/main/prompts/reformat-note.txt) — the same prompt the phone uses when reformatting notes on demand.

## License

MIT — see [LICENSE](LICENSE).
