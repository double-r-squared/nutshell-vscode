'use strict'

const fs = require('fs')
const path = require('path')

// Push-mode driver. Used in remote-server mode where the server cannot
// see the user's local filesystem. The extension is the source of truth:
// it scans local files, sends them to the server in one register call,
// then keeps the server in sync via per-event upsert/delete pushes.
//
// File IDs match the layout the server already serves in fs mode:
//
//   docSources non-empty (multi-source):
//     <linkName>/<rel-from-source>     e.g. "even-docs/api.md"
//
//   docSources empty (single source):
//     <rel-from-source>                e.g. "api.md"
//
// This way the phone sees identical file IDs across modes and the
// per-mode logic stays server-side only.

const FILE_RE = /\.md$/i

function listFiles(absRoot) {
  // Plain recursive walk; the extension does this on first scan and on
  // every snapshot. node_modules / dotfile filtering matches scanFiles
  // server-side.
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && FILE_RE.test(entry.name)) {
        out.push(full)
      }
    }
  }
  walk(absRoot)
  return out
}

function buildFileEntry(absPath, sourceRoot, prefix) {
  const stat = fs.statSync(absPath)
  const content = fs.readFileSync(absPath, 'utf8')
  const relFromSource = path.relative(sourceRoot, absPath).split(path.sep).join('/')
  const id = prefix ? `${prefix}/${relFromSource}` : relFromSource
  const lastSlash = id.lastIndexOf('/')
  const folder = lastSlash >= 0 ? id.slice(0, lastSlash) : ''
  const baseName = path.basename(id, '.md')
  return {
    id,
    name: baseName,
    folder,
    modifiedAt: Math.round(stat.mtimeMs),
    size: stat.size,
    content,
  }
}

// Determine the set of (sourceRoot, prefix) pairs the driver will scan
// and watch. Mirrors the layout that fs-mode would produce by walking
// the symlinked virtual root.
//
//   docSources non-empty -> one root per docSource entry, prefixed by linkName
//   docSources empty + transform mode -> outputDocsPath as the only root, no prefix
//   docSources empty + passthrough     -> sourceDocsPath as the only root, no prefix
function resolveSourceRoots({
  workspaceRoot,
  docSources,
  sourceDocsPath,
  outputDocsPath,
  mode,
  resolveDocSources,
}) {
  if (Array.isArray(docSources) && docSources.length > 0) {
    return resolveDocSources(workspaceRoot, docSources).map((entry) => ({
      sourceRoot: entry.absPath,
      prefix: entry.linkName,
    }))
  }
  const single = mode === 'transform'
    ? path.resolve(workspaceRoot, outputDocsPath)
    : path.resolve(workspaceRoot, sourceDocsPath)
  if (!fs.existsSync(single)) return []
  return [{ sourceRoot: single, prefix: '' }]
}

// Scan every source root and return the full file entry array, ready to
// hand to POST /projects/register or POST /projects/files/snapshot.
function scanAll(roots) {
  const files = []
  for (const { sourceRoot, prefix } of roots) {
    for (const abs of listFiles(sourceRoot)) {
      try {
        files.push(buildFileEntry(abs, sourceRoot, prefix))
      } catch (err) {
        // Skip files that vanished between listing and reading; the
        // chokidar unlink event will catch up.
        if (err.code !== 'ENOENT') throw err
      }
    }
  }
  return files
}

// Map an absolute file path back to its (sourceRoot, prefix). Used by the
// chokidar event handlers to compute the same id buildFileEntry produces.
function findRoot(roots, absPath) {
  for (const r of roots) {
    const rel = path.relative(r.sourceRoot, absPath)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return r
  }
  return null
}

function fileIdFromPath(roots, absPath) {
  const r = findRoot(roots, absPath)
  if (!r) return null
  const rel = path.relative(r.sourceRoot, absPath).split(path.sep).join('/')
  return r.prefix ? `${r.prefix}/${rel}` : rel
}

// Create the live driver. Synchronous — chokidar startup itself is
// deferred until the first snapshot() so a heartbeat "still-registered,
// no-op" path doesn't pay any setup cost.
function createPushDriver(opts) {
  const {
    workspaceRoot,
    settings,           // { docSources, sourceDocsPath, outputDocsPath, mode }
    resolveDocSources,
    log,
    onSnapshotPush,     // async (files[]) => void  -- POST /projects/register
    onFileUpsert,       // async (file)   => void  -- POST /projects/files/upsert
    onFileDelete,       // async (fileId) => void  -- POST /projects/files/delete
  } = opts

  const roots = resolveSourceRoots({
    workspaceRoot,
    docSources: settings.docSources,
    sourceDocsPath: settings.sourceDocsPath,
    outputDocsPath: settings.outputDocsPath,
    mode: settings.mode,
    resolveDocSources,
  })

  if (roots.length === 0) {
    log(`[push] no source roots resolved; nothing to watch`)
  }

  let watcher = null
  let disposed = false

  // chokidar is required lazily so the extension still loads if the dep
  // is somehow missing (degrades gracefully to "no live updates", just
  // periodic snapshots from heartbeat re-registers).
  function startWatcher() {
    if (watcher || disposed || roots.length === 0) return
    let chokidar
    try {
      chokidar = require('chokidar')
    } catch (err) {
      log(`[push] chokidar not available: ${err.message}; live updates disabled`)
      return
    }
    const watchPaths = roots.map((r) => r.sourceRoot)
    watcher = chokidar.watch(watchPaths, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,            // initial scan is handled by snapshot()
      followSymlinks: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    })
    watcher.on('add', (abs) => void handleUpsert(abs))
    watcher.on('change', (abs) => void handleUpsert(abs))
    watcher.on('unlink', (abs) => void handleDelete(abs))
    watcher.on('error', (err) => log(`[push] watcher error: ${err.message}`))
    log(`[push] watcher started (${watchPaths.length} root${watchPaths.length !== 1 ? 's' : ''})`)
  }

  async function handleUpsert(absPath) {
    if (!FILE_RE.test(absPath)) return
    const r = findRoot(roots, absPath)
    if (!r) return
    let entry
    try {
      entry = buildFileEntry(absPath, r.sourceRoot, r.prefix)
    } catch (err) {
      if (err.code === 'ENOENT') return
      log(`[push] skip ${absPath}: ${err.message}`)
      return
    }
    try {
      await onFileUpsert(entry)
      log(`[push] upsert ${entry.id} (${entry.size} B)`)
    } catch (err) {
      log(`[push] upsert ${entry.id} failed: ${err.message}`)
    }
  }

  async function handleDelete(absPath) {
    const id = fileIdFromPath(roots, absPath)
    if (!id) return
    try {
      await onFileDelete(id)
      log(`[push] delete ${id}`)
    } catch (err) {
      log(`[push] delete ${id} failed: ${err.message}`)
    }
  }

  return {
    // Snapshot scans every source root, sends the full file set to the
    // server, then ensures the live watcher is running. Called on first
    // remote-mode register and again from the heartbeat when the server
    // has lost the project.
    async snapshot() {
      if (disposed) return { fileCount: 0 }
      const files = scanAll(roots)
      log(`[push] snapshot ${files.length} file${files.length !== 1 ? 's' : ''}`)
      await onSnapshotPush(files)
      startWatcher()
      return { fileCount: files.length }
    },

    dispose() {
      disposed = true
      if (watcher) {
        try { watcher.close() } catch {}
        watcher = null
      }
    },

    get rootCount() { return roots.length },
  }
}

module.exports = { createPushDriver }
