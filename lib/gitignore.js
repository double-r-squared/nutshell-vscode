'use strict'

const fs = require('fs')
const path = require('path')

// Ensure each `entry` appears in the workspace's `.gitignore`.
//
// `entries` is one of:
//   - a string (single entry)                 — kept for backward compat
//   - { dir: 'foo' } | { file: '.bar' }       — single entry with explicit kind
//   - an array of any of the above            — batch mode (one comment header)
//
// `dir` entries are normalized to `<name>/` (folder pattern). `file` entries
// are written verbatim.
//
// `comment` is the section header line written above any newly-added
// entries. Defaults to a generic Nutshell tag. Idempotent: existing
// entries are detected and skipped (matching with or without trailing
// slash, and stripping leading `./`).
function ensureGitignoreEntry(workspaceRoot, entries, comment) {
  const list = normalizeEntries(entries)
  if (list.length === 0) return false

  const gitignorePath = path.join(workspaceRoot, '.gitignore')
  let content = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : ''

  const toAdd = []
  for (const line of list) {
    if (!hasEntry(content, line)) toAdd.push(line)
  }
  if (toAdd.length === 0) return false

  if (content.length > 0 && !content.endsWith('\n')) content += '\n'
  const header = comment || '# Nutshell'
  content += `${header}\n${toAdd.join('\n')}\n`
  fs.writeFileSync(gitignorePath, content, 'utf8')
  return true
}

function normalizeEntries(input) {
  if (input == null) return []
  if (typeof input === 'string') return [normalizeOne({ dir: input })]
  if (Array.isArray(input)) {
    return input
      .map((item) => (typeof item === 'string' ? normalizeOne({ dir: item }) : normalizeOne(item)))
      .filter(Boolean)
  }
  return [normalizeOne(input)].filter(Boolean)
}

function normalizeOne(item) {
  if (item.dir) return item.dir.replace(/\/$/, '') + '/'
  if (item.file) return item.file
  return null
}

function hasEntry(content, line) {
  const stripped = line.replace(/\/$/, '')
  const variants = new Set([line, stripped, stripped + '/', `./${stripped}`, `./${stripped}/`])
  for (const v of variants) {
    const re = new RegExp(`^${escapeRe(v)}\\s*$`, 'm')
    if (re.test(content)) return true
  }
  return false
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = { ensureGitignoreEntry }
