# G2 doc transform

A key feature of the VS Code extension: one button that takes a folder of
regular project docs and produces a parallel folder formatted for the Even
Realities G2 display.

## The problem

Regular project docs are written for readers with a full screen:

- Long paragraphs
- Markdown formatting (bold, italic, inline code, tables, footnotes)
- Deep heading hierarchies
- Links, blockquotes, HTML tags

The G2 display is 640×200px monochrome. It can't render inline formatting,
tables don't fit, long paragraphs stretch off the side. The phone has a
reformat-on-demand feature (`reformat-note`) but running it on every file
every time you open the glasses is wasteful.

Solution: **pre-transform the docs once**, serve the clean version to the
glasses, rebuild the mirror when source files change.

## Pipeline

```text
user clicks "Nutshell: Transform Docs for G2"
         │
         ▼
 walk sourceDir, collect .md / .mdx / .txt files
         │
         ▼
 load G2 reformat spec from
   nutshell-server/prompts/reformat-note.txt
         │
         ▼
 for each source file, in sequence:
   │
   ├─ read file content
   │
   ├─ build harness prompt:
   │     <spec>
   │     ---
   │     Reformat the following note ...
   │     <content>
   │
   ├─ spawn `claude -p "<harness>"`  (one-shot Claude Code CLI)
   │
   ├─ capture stdout
   │
   ├─ compute output path:
   │     <outputDir>/<relPath with .mdx/.txt replaced by .md>
   │
   ├─ mkdir -p outputDir
   │
   └─ write stdout to output path
```

Full impl: [`../lib/transform.js`](../lib/transform.js).

## Why `claude` CLI and not OpenRouter

The user has asked for Claude Code specifically — it uses the user's
existing Claude auth (subscription or API key) without adding an OpenRouter
key to the extension. No key management, no rate limits surfacing through
us, no billing ambiguity.

A future phase could allow the user to configure an OpenRouter alternative,
but Phase 1 assumes `claude` on PATH.

## Harness choice

Two specs ship with `nutshell-server`:

- `prompts/reformat-note.txt` — full (~50 lines, strict rules)
- `prompts/reformat-note-compact.txt` — trimmed (~15 lines)

The VS Code transform currently uses the full spec via
`nutshell-server/package.json`'s resolved path. This lets Claude Code apply
the rules thoroughly since it's running the cloud model (Claude 3.5+),
which handles long instructions well.

If a future version routes the transform through the local Ollama proxy,
it should switch to the compact spec for 3B models.

## Side effects when you first configure transform mode

### `.gitignore`

Added idempotently:

```text
# Nutshell — auto-generated G2-formatted docs
nutshell-docs/
```

Creates `.gitignore` if absent. The output folder name is whatever
`nutshell.outputDocsPath` says, trailing slash appended.

Impl: [`../lib/gitignore.js`](../lib/gitignore.js).

### `CLAUDE.md`

Appends (or updates) a block wrapped in marker comments:

```text
<!-- nutshell-harness:start -->
## Nutshell G2 docs mirror

`nutshell-docs/` is an auto-generated mirror of `docs/`, reformatted for
Even Realities G2 glasses. It is gitignored. The user can change this path
in VS Code settings under `nutshell.outputDocsPath` (common alternatives
include `.nutshell-docs` for a hidden folder).

**Do not edit files in `nutshell-docs/` directly** — they are regenerated
by the Nutshell VS Code extension via Claude Code using the format rules
in `nutshell-server`'s `prompts/reformat-note.txt`.

When you edit a file in `docs/`, either:

1. Run **Nutshell: Transform Docs for G2** from the command palette to
   rebuild the mirror, or
2. Enable `nutshell.autoTransformOnSave` in VS Code settings so the mirror
   stays current automatically.
<!-- nutshell-harness:end -->
```

Rerunning Configure updates the block in place (start/end markers make this
safe). If the user deletes the markers and rewrites the section by hand,
the next configure run will re-append a fresh one — so keep the markers
if you edit the text.

Impl: [`../lib/claude-md.js`](../lib/claude-md.js).

## Auto-transform on save

Opt-in via `nutshell.autoTransformOnSave: true`. Hooks
`vscode.workspace.onDidSaveTextDocument`:

1. Filter to files inside `<workspace>/<sourceDocsPath>`
2. Filter to `.md` / `.mdx` / `.txt` extensions
3. Transform that single file
4. Write the output to the mirror path

This burns Claude Code credit on every save, so it's off by default.

For larger docs folders, the manual command is usually more practical —
saves don't trigger Claude API calls, and you can batch-transform when
the source is in a good state.

## Error handling

If `claude` isn't on PATH: error includes an install link and the command
aborts.

If a single file fails to transform: logged with the relative path + error
message. The loop continues to the next file — partial mirrors are
acceptable. Rerun the command after fixing the cause.

If the source folder doesn't exist: command errors out immediately.

## Output path rewriting

Source extension → output extension:

| Source | Output |
| --- | --- |
| `foo.md` | `foo.md` |
| `foo.mdx` | `foo.md` |
| `foo.txt` | `foo.md` |

The mirror folder ends up as all-`.md`. This lets the nutshell-server
serve it without any special-case parsing for other extensions, and the
glasses only care about the content, not the extension.

## What's NOT handled

- **Images, PDFs, binary assets.** The transform only touches text files.
  Images referenced in markdown get skipped; the mirror won't contain them,
  and links pointing at them from the transformed output may dangle.
  Future work: copy images through as-is
- **Frontmatter.** YAML frontmatter in the source ends up in the transform
  input. The spec tells Claude Code to strip it, but small deviations
  slip through. Acceptable for now
- **Cross-file links.** If `docs/a.md` links to `docs/b.md`, the link will
  likely be stripped during reformat (links are in the "disallowed" list
  of the spec). This is intentional — G2 doesn't render clickable links

## See also

- [`architecture.md`](architecture.md) — VS Code extension internals
- [`commands.md`](commands.md) — command reference
- `../../nutshell-server/prompts/reformat-note.txt` — the transform spec
