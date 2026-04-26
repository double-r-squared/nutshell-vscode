'use strict'

const fs = require('fs')
const path = require('path')

// Symlink-based doc source aggregator.
//
// When nutshell.docSources lists multiple folders (e.g. ["docs", "notes",
// "specs"]), this module creates a gitignored virtual root at
// .nutshell-docs-root/ with symlinks to each source:
//
//   .nutshell-docs-root/
//     docs -> ../docs
//     notes -> ../notes
//     specs -> ../specs
//
// The server registers this virtual root as its docsPath. chokidar follows
// symlinks by default, so file watching works transparently.

const VIRTUAL_ROOT = '.nutshell-docs-root'

// Build (or rebuild) the virtual root with symlinks to each source folder.
// Idempotent -- removes stale symlinks, adds missing ones, leaves valid
// ones alone.
//
// Returns the absolute path of the virtual root, or null if docSources is
// empty.
function rebuildVirtualRoot(workspaceRoot, docSources) {
  if (!docSources || docSources.length === 0) return null

  const virtualRoot = path.join(workspaceRoot, VIRTUAL_ROOT)
  fs.mkdirSync(virtualRoot, { recursive: true })

  // Desired symlinks: map from link name -> absolute target.
  const desired = new Map()
  for (const relPath of docSources) {
    const absTarget = path.resolve(workspaceRoot, relPath)
    if (!fs.existsSync(absTarget)) continue
    // Use the last path segment as the link name. Handle collisions by
    // appending the parent folder name.
    let linkName = path.basename(relPath)
    if (desired.has(linkName)) {
      const parent = path.basename(path.dirname(relPath))
      linkName = parent ? `${parent}-${linkName}` : `${linkName}-2`
    }
    desired.set(linkName, absTarget)
  }

  // Remove stale symlinks (entries in the virtual root that aren't in
  // the desired set or point to the wrong target).
  if (fs.existsSync(virtualRoot)) {
    for (const entry of fs.readdirSync(virtualRoot)) {
      const linkPath = path.join(virtualRoot, entry)
      let shouldRemove = false
      try {
        const stat = fs.lstatSync(linkPath)
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(linkPath)
          const absTarget = path.resolve(virtualRoot, target)
          if (!desired.has(entry) || desired.get(entry) !== absTarget) {
            shouldRemove = true
          }
        } else {
          // Not a symlink -- don't touch it (could be user's file).
          continue
        }
      } catch {
        shouldRemove = true
      }
      if (shouldRemove) {
        try { fs.unlinkSync(linkPath) } catch {}
      }
    }
  }

  // Create missing symlinks.
  for (const [linkName, absTarget] of desired) {
    const linkPath = path.join(virtualRoot, linkName)
    if (fs.existsSync(linkPath)) {
      // Already exists and is correct (we removed stale ones above).
      try {
        const stat = fs.lstatSync(linkPath)
        if (stat.isSymbolicLink()) continue
      } catch {}
    }
    // Use relative target so the symlink survives directory moves.
    const relTarget = path.relative(virtualRoot, absTarget)
    try {
      fs.symlinkSync(relTarget, linkPath)
    } catch (err) {
      // Log but don't throw -- partial success is better than total failure.
      console.error(`[doc-sources] symlink failed: ${linkPath} -> ${relTarget}: ${err.message}`)
    }
  }

  return virtualRoot
}

// Remove the virtual root entirely. Called on cleanup.
function removeVirtualRoot(workspaceRoot) {
  const virtualRoot = path.join(workspaceRoot, VIRTUAL_ROOT)
  if (!fs.existsSync(virtualRoot)) return
  // Remove symlinks inside, then the directory itself.
  for (const entry of fs.readdirSync(virtualRoot)) {
    const linkPath = path.join(virtualRoot, entry)
    try {
      const stat = fs.lstatSync(linkPath)
      if (stat.isSymbolicLink()) fs.unlinkSync(linkPath)
    } catch {}
  }
  try { fs.rmdirSync(virtualRoot) } catch {}
}

// Scan the workspace for folders likely to contain docs. Returns an array
// of relative paths. Looks for:
//   - Root-level folders named docs, doc, documentation, notes, specs
//   - Subfolders of docs/ (e.g. docs/api, docs/frontend)
//   - */docs/ patterns one level deep (monorepo packages)
// Filters: folder must contain at least one .md file.
function discoverDocFolders(workspaceRoot) {
  const candidates = []

  // Known doc folder names at root level.
  const DOC_NAMES = ['docs', 'doc', 'documentation', 'notes', 'specs']

  for (const name of DOC_NAMES) {
    const abs = path.join(workspaceRoot, name)
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      if (hasMdFiles(abs)) candidates.push(name)
      // Also check subfolders (docs/api, docs/frontend, etc.)
      for (const sub of safeReaddir(abs)) {
        const subAbs = path.join(abs, sub)
        if (fs.statSync(subAbs).isDirectory() && hasMdFiles(subAbs)) {
          candidates.push(`${name}/${sub}`)
        }
      }
    }
  }

  // One level deep: packages/*/docs, lib/*/docs, etc.
  const TOP_DIRS = safeReaddir(workspaceRoot).filter((d) => {
    const abs = path.join(workspaceRoot, d)
    return !d.startsWith('.') && !d.startsWith('node_modules') && fs.statSync(abs).isDirectory()
  })
  for (const top of TOP_DIRS) {
    if (DOC_NAMES.includes(top)) continue // already handled
    for (const sub of safeReaddir(path.join(workspaceRoot, top))) {
      if (DOC_NAMES.includes(sub)) {
        const rel = `${top}/${sub}`
        const abs = path.join(workspaceRoot, rel)
        if (fs.statSync(abs).isDirectory() && hasMdFiles(abs)) {
          candidates.push(rel)
        }
      }
    }
  }

  return candidates
}

function hasMdFiles(dir) {
  for (const entry of safeReaddir(dir)) {
    if (/\.(md|mdx|txt)$/i.test(entry)) return true
    const abs = path.join(dir, entry)
    try {
      if (fs.statSync(abs).isDirectory() && hasMdFiles(abs)) return true
    } catch {}
  }
  return false
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).filter((d) => !d.startsWith('.'))
  } catch {
    return []
  }
}

// Count .md files in a directory (non-recursive, for display).
function countMdFiles(dir) {
  let count = 0
  const walk = (d) => {
    for (const entry of safeReaddir(d)) {
      const abs = path.join(d, entry)
      try {
        const stat = fs.statSync(abs)
        if (stat.isFile() && /\.(md|mdx|txt)$/i.test(entry)) count++
        else if (stat.isDirectory()) walk(abs)
      } catch {}
    }
  }
  walk(dir)
  return count
}

module.exports = {
  VIRTUAL_ROOT,
  rebuildVirtualRoot,
  removeVirtualRoot,
  discoverDocFolders,
  countMdFiles,
}
