'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Project ID is stored in .vscode/nutshell-project-id inside the workspace root.
// It's a UUID v4 that survives folder renames and workspace moves. Never
// hash-derived from the path — users move projects around.

const ID_FILE_REL = path.join('.vscode', 'nutshell-project-id')

function ensureProjectId(workspaceRoot) {
  const idPath = path.join(workspaceRoot, ID_FILE_REL)
  if (fs.existsSync(idPath)) {
    const existing = fs.readFileSync(idPath, 'utf8').trim()
    if (existing) return existing
  }
  const id = crypto.randomUUID()
  fs.mkdirSync(path.dirname(idPath), { recursive: true })
  fs.writeFileSync(idPath, id + '\n', 'utf8')
  return id
}

module.exports = { ensureProjectId }
