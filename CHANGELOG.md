# Changelog

All notable changes to the Nutshell VS Code extension are documented here.

## 1.4.4 — Stable release

First release as 1.x. The codebase has been driving real glasses-on-the-face
usage long enough that pre-1.0 versioning no longer reflects reality.

### Fixed

- **Marketplace publish was failing with "Value cannot be null. Parameter
  name: v1"** because `package.json` declared `publisher: "nutshell"` while
  the registered Marketplace publisher ID is `nutshell-app`. Switched the
  field; uploads now go through.

### Changed

- New icon — 128 × 128 black-on-white pixel-art mark replacing the previous
  placeholder.
- README rewritten with a centered header (icon + name + tagline +
  marketplace links), a paragraph-length description of what each mode does,
  and the Claude-Code transform footnote folded into a dedicated section.
- Server install instructions switched from the misleading
  `npm install -g nutshell-server` (the server isn't on the npm registry)
  to a `git clone` + `npm install` + `node bin/cli.js` flow.

## 0.4.3 — Initial public release

First release on the VS Code Marketplace.

### What it does

- Auto-spawns a `nutshell-server` instance in your workspace and registers your
  docs folder so it shows up as a row on your Even Realities G2 glasses.
- Heartbeats every 30 seconds — server restarts and laptop sleeps recover
  automatically.
- One-command transform of existing docs into G2-friendly format via the
  Claude Code CLI.
- Multi-window: every VS Code window registers its own project under one
  shared server.

### Highlights from internal iteration leading to this release

- Push-mode projects so the extension can ship file content directly to a
  remote-hosted server (no shared filesystem required).
- Doc-source aggregation — list multiple folders in `nutshell.docSources`
  and they're symlinked into a single virtual project root.
- Connect-to-remote command for pointing at someone else's running server.
- Stable per-workspace project IDs persisted in `.vscode/nutshell-project-id`
  so re-opens don't churn project rows on the glasses.

See <https://github.com/double-r-squared/nutshell-vscode> for the source.
