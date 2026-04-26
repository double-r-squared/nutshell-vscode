'use strict'

const path = require('path')
const fs = require('fs')
const vscode = require('vscode')

const { transformDocs } = require('./lib/transform')
const { ensureGitignoreEntry } = require('./lib/gitignore')
const { ensureClaudeMdHarness } = require('./lib/claude-md')
const { ensureProjectId } = require('./lib/project-id')
const {
  VIRTUAL_ROOT,
  rebuildVirtualRoot,
  removeVirtualRoot,
  discoverDocFolders,
  countMdFiles,
} = require('./lib/doc-sources')
const {
  probeHealth,
  readKey,
  readTrackedPid,
  writeTrackedPid,
  clearTrackedPid,
  pidIsAlive,
  spawnServer,
  killTracked,
  waitForHealthy,
  registerProject,
  unregisterProject,
  adminShutdown,
  adminRestart,
} = require('./lib/server-client')

// ── State ─────────────────────────────────────────────────────────────────────

let statusBarItem = null
let outputChannel = null
let saveWatcherDisposable = null
let heartbeatHandle = null
let lastProbedHealth = null
let myProjectId = null
let keyPromptShown = false

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  outputChannel.appendLine(`[${new Date().toISOString()}] ${line}`)
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) return null
  return folders[0].uri.fsPath
}

function settings() {
  const config = vscode.workspace.getConfiguration('nutshell')
  const root = workspaceRoot()
  return {
    mode: config.get('mode', 'passthrough'),
    sourceDocsPath: config.get('sourceDocsPath', 'docs'),
    outputDocsPath: config.get('outputDocsPath', 'nutshell-docs'),
    serverMode: config.get('serverMode', 'local'),
    host: config.get('host', 'localhost') || 'localhost',
    port: config.get('port', 4242),
    name: config.get('name', '') || (root ? path.basename(root) : 'Project'),
    autoStart: config.get('autoStart', true),
    autoTransformOnSave: config.get('autoTransformOnSave', false),
    ollama: config.get('ollama', false),
    ollamaModel: config.get('ollamaModel', 'llama3.2:3b'),
    ollamaUrl: config.get('ollamaUrl', 'http://localhost:11434'),
    docSources: config.get('docSources', []) || [],
    apiKey: config.get('apiKey', '') || '',
    root,
  }
}

function isRemoteMode(s) {
  return s.serverMode === 'remote'
}

function serverAddr(s) {
  return `${s.host}:${s.port}`
}

function resolvedProjectDocsPath(s) {
  if (!s.root) return null
  if (s.mode === 'urlOnly') return null

  // When docSources is populated, use the virtual symlink root.
  if (s.docSources.length > 0) {
    const virtualRoot = rebuildVirtualRoot(s.root, s.docSources)
    if (virtualRoot) {
      if (s.mode === 'transform') return path.resolve(s.root, s.outputDocsPath)
      return virtualRoot
    }
  }

  if (s.mode === 'transform') return path.resolve(s.root, s.outputDocsPath)
  return path.resolve(s.root, s.sourceDocsPath)
}

function updateStatusBar() {
  if (!statusBarItem) return
  const s = settings()
  const remote = isRemoteMode(s)
  const addr = serverAddr(s)
  if (lastProbedHealth?.ok) {
    statusBarItem.text = remote ? `$(radio-tower) Nutshell (remote)` : `$(radio-tower) Nutshell`
    const pCount = lastProbedHealth.projectCount || 0
    statusBarItem.tooltip = `${remote ? 'Remote' : 'Local'} server at ${addr} · ${pCount} project(s). Click for menu.`
    statusBarItem.backgroundColor = undefined
  } else {
    statusBarItem.text = `$(circle-slash) Nutshell`
    statusBarItem.tooltip = remote
      ? `Cannot reach remote server at ${addr}. Click for menu.`
      : `Server not detected at ${addr}. Click to start.`
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  }
  statusBarItem.command = 'nutshell.showMenu'
  statusBarItem.show()
}

// ── Heartbeat: probe health + keep our project registered ────────────────────

async function heartbeat() {
  const s = settings()
  if (!s.root) return

  const health = await probeHealth(s.host, s.port)
  lastProbedHealth = health
  updateStatusBar()

  if (!health || !health.ok) return

  // Server is up; make sure our project is registered with current settings.
  let apiKey = readKey(s.root)

  // Fallback 1: use the key stored in the nutshell.apiKey workspace setting.
  if (!apiKey && s.apiKey) {
    apiKey = s.apiKey
    // Persist it to the key file so future reads work without the setting.
    try {
      fs.writeFileSync(path.join(s.root, '.nutshell-api-key'), apiKey, 'utf8')
      log(`Saved API key from settings → ${s.root}/.nutshell-api-key`)
    } catch {}
  }

  if (!apiKey) {
    log(`Server is up at ${serverAddr(s)} but no API key found in ${s.root}/.nutshell-api-key`)
    log(`Tip: copy the key from the server's terminal output and run "Nutshell: Enter Server Key"`)
    if (!keyPromptShown) {
      keyPromptShown = true
      vscode.window
        .showWarningMessage(
          `Nutshell server found at ${serverAddr(s)} but no API key is saved for this workspace.`,
          'Enter Key',
        )
        .then((choice) => { if (choice === 'Enter Key') void enterServerKey() })
    }
    return
  }
  keyPromptShown = false

  const docsPath = resolvedProjectDocsPath(s)
  if (!docsPath || !fs.existsSync(docsPath)) return
  if (!myProjectId) myProjectId = ensureProjectId(s.root)

  try {
    await registerProject(s.host, s.port, apiKey, {
      id: myProjectId,
      name: s.name,
      docsPath,
    })
  } catch (err) {
    log(`heartbeat register failed: ${err.message}`)
  }
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatHandle = setInterval(() => { void heartbeat() }, 30_000)
  void heartbeat()
}

function stopHeartbeat() {
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle)
    heartbeatHandle = null
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function startServer() {
  const s = settings()
  if (!s.root) {
    vscode.window.showWarningMessage('Open a workspace folder to start the Nutshell server.')
    return
  }
  if (isRemoteMode(s)) {
    vscode.window
      .showWarningMessage(
        `Nutshell is in remote mode (host = ${s.host}). Start/Stop only manage a local server. Switch to local mode first?`,
        'Switch to local',
        'Cancel',
      )
      .then(async (choice) => {
        if (choice === 'Switch to local') await useLocalServer()
      })
    return
  }

  const existing = await probeHealth(s.host, s.port)
  if (existing?.ok) {
    vscode.window.showInformationMessage(
      `Nutshell server already running on port ${s.port}. Adopting it.`,
    )
    await heartbeat()
    return
  }

  // Clean up a stale PID file from a crashed-but-not-restarted scenario.
  const staleP = readTrackedPid(s.root)
  if (staleP && !pidIsAlive(staleP)) clearTrackedPid(s.root)

  log(`spawning nutshell-server on port ${s.port}`)
  const pid = spawnServer({
    workspaceRoot: s.root,
    port: s.port,
    ollama: s.ollama,
    ollamaModel: s.ollamaModel,
    ollamaUrl: s.ollamaUrl,
  })
  if (pid) writeTrackedPid(s.root, pid)

  const up = await waitForHealthy(s.host, s.port, 10_000)
  if (!up) {
    vscode.window.showErrorMessage(
      `Nutshell server failed to start within 10 s. Check .nutshell-server.log for details.`,
    )
    return
  }
  log(`server up (pid ${pid})`)
  await heartbeat()
  if (up && lastProbedHealth) {
    vscode.window
      .showInformationMessage(
        `Nutshell running on localhost:${s.port}. Copy the key to use it on the phone.`,
        'Copy key',
      )
      .then((choice) => { if (choice === 'Copy key') void copyApiKey() })
  }
}

async function stopServer() {
  const s = settings()
  if (!s.root) return

  if (isRemoteMode(s)) {
    // Remote mode: ask the server to shut down via the admin endpoint.
    const apiKey = readKey(s.root)
    if (!apiKey) {
      vscode.window.showWarningMessage('No API key saved — cannot send shutdown to remote server.')
      return
    }
    const confirm = await vscode.window.showWarningMessage(
      `This will shut down the remote Nutshell server at ${serverAddr(s)}. Continue?`,
      { modal: true },
      'Shut down',
    )
    if (confirm !== 'Shut down') return
    try {
      await adminShutdown(s.host, s.port, apiKey)
      log(`remote shutdown sent to ${serverAddr(s)}`)
      vscode.window.showInformationMessage(`Shutdown signal sent to ${serverAddr(s)}.`)
    } catch (err) {
      log(`remote shutdown failed: ${err.message}`)
      vscode.window.showErrorMessage(`Could not shut down remote server: ${err.message}`)
    }
    lastProbedHealth = null
    updateStatusBar()
    return
  }

  // Local mode: only kill what we spawned — don't touch a server started manually.
  const wasOurs = killTracked(s.root)
  if (wasOurs) {
    log('stopped tracked server')
  } else {
    vscode.window.showInformationMessage(
      'No Nutshell server was started by this extension. Stop the external process manually if needed.',
    )
  }
  lastProbedHealth = null
  updateStatusBar()
}

async function restartServer() {
  const s = settings()

  if (isRemoteMode(s)) {
    // Remote mode: ask the server to hot-restart via the admin endpoint.
    const apiKey = readKey(s.root)
    if (!apiKey) {
      vscode.window.showWarningMessage('No API key saved — cannot send restart to remote server.')
      return
    }
    try {
      await adminRestart(s.host, s.port, apiKey)
      log(`remote restart sent to ${serverAddr(s)}`)
      vscode.window.showInformationMessage(`Restart signal sent to ${serverAddr(s)}. Waiting for server…`)
      // Give it a moment, then re-probe.
      await new Promise((r) => setTimeout(r, 1500))
      await heartbeat()
      if (lastProbedHealth?.ok) {
        vscode.window.showInformationMessage(`Remote server at ${serverAddr(s)} is back up.`)
      } else {
        vscode.window.showWarningMessage(`Remote server at ${serverAddr(s)} has not responded yet. It may still be restarting.`)
      }
    } catch (err) {
      log(`remote restart failed: ${err.message}`)
      vscode.window.showErrorMessage(`Could not restart remote server: ${err.message}`)
    }
    return
  }

  // Local mode: stop + start.
  await stopServer()
  // Give the port a moment to release.
  await new Promise((r) => setTimeout(r, 500))
  await startServer()
}

// Switch to remote mode and capture host/port/key — does NOT spawn anything.
async function connectRemote() {
  const s = settings()
  if (!s.root) {
    vscode.window.showWarningMessage('Open a workspace folder first.')
    return
  }

  const hostInput = await vscode.window.showInputBox({
    prompt: 'Remote Nutshell server host (or host:port)',
    value: s.host && s.host !== 'localhost' ? s.host : '',
    placeHolder: '192.168.1.42  or  nutshell.example.com:4242',
    ignoreFocusOut: true,
  })
  if (hostInput === undefined) return
  const trimmed = hostInput.trim()
  if (!trimmed) return

  let host = trimmed
  let port = s.port
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0 && colon < trimmed.length - 1) {
    const tail = trimmed.slice(colon + 1)
    const parsedPort = parseInt(tail, 10)
    if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
      host = trimmed.slice(0, colon)
      port = parsedPort
    }
  }

  if (port === s.port) {
    const portInput = await vscode.window.showInputBox({
      prompt: `Remote port (default ${s.port})`,
      value: String(s.port),
      ignoreFocusOut: true,
    })
    if (portInput === undefined) return
    const parsed = parseInt(portInput.trim(), 10)
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) port = parsed
  }

  const config = vscode.workspace.getConfiguration('nutshell')
  await config.update('serverMode', 'remote', vscode.ConfigurationTarget.Workspace)
  await config.update('host', host, vscode.ConfigurationTarget.Workspace)
  await config.update('port', port, vscode.ConfigurationTarget.Workspace)
  await config.update('autoStart', false, vscode.ConfigurationTarget.Workspace)
  log(`switched to remote mode → ${host}:${port}`)

  // Probe before prompting for a key — gives the user immediate feedback.
  const reachable = await probeHealth(host, port)
  if (!reachable?.ok) {
    vscode.window.showWarningMessage(
      `Saved remote settings, but ${host}:${port} did not respond to /health. Confirm the server is reachable.`,
    )
  }

  // Offer to capture/replace the API key right away.
  const existingKey = readKey(s.root)
  const choice = await vscode.window.showInformationMessage(
    existingKey
      ? `Connected to ${host}:${port}. Replace the saved API key?`
      : `Connected to ${host}:${port}. Enter the remote server's API key now?`,
    existingKey ? 'Replace key' : 'Enter key',
    'Later',
  )
  if (choice === 'Replace key' || choice === 'Enter key') {
    await enterServerKey()
  } else {
    await heartbeat()
  }
}

async function useLocalServer() {
  const config = vscode.workspace.getConfiguration('nutshell')
  await config.update('serverMode', 'local', vscode.ConfigurationTarget.Workspace)
  await config.update('host', 'localhost', vscode.ConfigurationTarget.Workspace)
  log('switched to local mode')
  lastProbedHealth = null
  updateStatusBar()
  await heartbeat()
}

async function enterServerKey() {
  const s = settings()
  if (!s.root) {
    vscode.window.showWarningMessage('Open a workspace folder first.')
    return
  }
  const key = await vscode.window.showInputBox({
    prompt: 'Paste the Nutshell API key shown in the server terminal output',
    password: true,
    placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  if (!key?.trim()) return
  try {
    fs.writeFileSync(path.join(s.root, '.nutshell-api-key'), key.trim(), 'utf8')
    log(`API key saved to ${s.root}/.nutshell-api-key`)
    keyPromptShown = false
    await heartbeat()
    vscode.window.showInformationMessage('Nutshell API key saved. Registering project…')
  } catch (err) {
    vscode.window.showErrorMessage(`Could not save key: ${err.message}`)
  }
}

async function copyApiKey() {
  const s = settings()
  if (!s.root) return
  const key = readKey(s.root)
  if (!key) {
    const choice = await vscode.window.showWarningMessage(
      'No .nutshell-api-key found in this workspace.',
      'Enter Key',
    )
    if (choice === 'Enter Key') void enterServerKey()
    return
  }
  await vscode.env.clipboard.writeText(key)
  vscode.window.showInformationMessage('Nutshell API key copied to clipboard.')
}

function showBanner() {
  const s = settings()
  const key = s.root ? readKey(s.root) : null
  const addr = serverAddr(s)
  const status = lastProbedHealth?.ok ? 'running' : 'unreachable'
  const tag = isRemoteMode(s) ? 'remote' : 'local'
  const msg = `Nutshell ${tag} ${status}: ${addr}${key ? ' · key saved' : ' · no key yet'}`
  vscode.window
    .showInformationMessage(msg, 'Copy address', 'Copy key')
    .then((choice) => {
      if (choice === 'Copy address') {
        void vscode.env.clipboard.writeText(addr)
      } else if (choice === 'Copy key') {
        void copyApiKey()
      }
    })
}

async function unregisterThisProject() {
  const s = settings()
  if (!s.root) return
  const apiKey = readKey(s.root)
  if (!apiKey) return
  if (!myProjectId) myProjectId = ensureProjectId(s.root)
  try {
    await unregisterProject(s.host, s.port, apiKey, myProjectId)
    log(`unregistered project ${myProjectId}`)
    vscode.window.showInformationMessage('Project unregistered from Nutshell server.')
  } catch (err) {
    vscode.window.showErrorMessage(`Unregister failed: ${err.message}`)
  }
}

// ── Doc sources (symlink aggregation) ────────────────────────────────────────

async function discoverDocFoldersCommand() {
  const root = workspaceRoot()
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder first.')
    return
  }

  const found = discoverDocFolders(root)
  if (found.length === 0) {
    vscode.window.showInformationMessage(
      'No doc folders found. Use "Nutshell: Add Doc Source Folder" to add one manually.',
    )
    return
  }

  const config = vscode.workspace.getConfiguration('nutshell')
  const existing = new Set(config.get('docSources', []))

  const items = found.map((rel) => {
    const abs = path.resolve(root, rel)
    const count = countMdFiles(abs)
    return {
      label: rel,
      description: `${count} .md file${count !== 1 ? 's' : ''}`,
      picked: existing.has(rel),
      alreadyAdded: existing.has(rel),
    }
  })

  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select doc folders to include (symlinked under one project)',
  })
  if (!picks) return

  const selected = picks.map((p) => p.label)
  await config.update('docSources', selected, vscode.ConfigurationTarget.Workspace)
  log(`docSources updated: ${selected.join(', ')}`)

  // Rebuild symlinks immediately.
  rebuildVirtualRoot(root, selected)
  ensureGitignoreEntry(root, VIRTUAL_ROOT)

  const count = selected.length
  vscode.window.showInformationMessage(
    `${count} doc source${count !== 1 ? 's' : ''} configured. Server will serve them as nested folders.`,
  )
  await heartbeat()
}

async function addDocSourceCommand() {
  const root = workspaceRoot()
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder first.')
    return
  }

  const input = await vscode.window.showInputBox({
    prompt: 'Folder path relative to workspace root',
    placeHolder: 'docs/api  or  notes  or  packages/auth/docs',
    validateInput: (value) => {
      if (!value?.trim()) return 'Path cannot be empty'
      const abs = path.resolve(root, value.trim())
      if (!fs.existsSync(abs)) return `Folder does not exist: ${value.trim()}`
      if (!fs.statSync(abs).isDirectory()) return `Not a directory: ${value.trim()}`
      return null
    },
  })
  if (!input) return

  const relPath = input.trim()
  const config = vscode.workspace.getConfiguration('nutshell')
  const current = config.get('docSources', []) || []

  if (current.includes(relPath)) {
    vscode.window.showInformationMessage(`${relPath} is already in docSources.`)
    return
  }

  const updated = [...current, relPath]
  await config.update('docSources', updated, vscode.ConfigurationTarget.Workspace)
  log(`added doc source: ${relPath}`)

  rebuildVirtualRoot(root, updated)
  ensureGitignoreEntry(root, VIRTUAL_ROOT)

  vscode.window.showInformationMessage(`Added ${relPath} to doc sources.`)
  await heartbeat()
}

async function manageDocSourcesCommand() {
  const root = workspaceRoot()
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder first.')
    return
  }

  const config = vscode.workspace.getConfiguration('nutshell')
  const current = config.get('docSources', []) || []

  if (current.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No doc sources configured.',
      'Discover',
      'Add manually',
    )
    if (choice === 'Discover') await discoverDocFoldersCommand()
    else if (choice === 'Add manually') await addDocSourceCommand()
    return
  }

  const items = current.map((rel) => {
    const abs = path.resolve(root, rel)
    const exists = fs.existsSync(abs)
    const count = exists ? countMdFiles(abs) : 0
    return {
      label: rel,
      description: exists ? `${count} .md files` : '(folder missing)',
      value: rel,
    }
  })

  items.push(
    { label: '$(add) Add a folder…', description: '', value: '__add__' },
    { label: '$(search) Discover folders…', description: '', value: '__discover__' },
  )

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Doc sources — select to remove, or add new ones',
  })
  if (!pick) return

  if (pick.value === '__add__') {
    await addDocSourceCommand()
    return
  }
  if (pick.value === '__discover__') {
    await discoverDocFoldersCommand()
    return
  }

  // Selected an existing source — offer to remove it.
  const remove = await vscode.window.showWarningMessage(
    `Remove ${pick.value} from doc sources?`,
    'Remove',
    'Cancel',
  )
  if (remove !== 'Remove') return

  const updated = current.filter((p) => p !== pick.value)
  await config.update('docSources', updated, vscode.ConfigurationTarget.Workspace)
  log(`removed doc source: ${pick.value}`)

  if (updated.length > 0) {
    rebuildVirtualRoot(root, updated)
  } else {
    removeVirtualRoot(root)
  }

  vscode.window.showInformationMessage(`Removed ${pick.value}.`)
  await heartbeat()
}

// ── Configuration flow ────────────────────────────────────────────────────────

async function configureWorkspace() {
  const root = workspaceRoot()
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder first.')
    return
  }

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(folder) Point at an existing folder',
        description: 'passthrough — serve a folder of markdown files as-is',
        value: 'passthrough',
      },
      {
        label: '$(sparkle) Transform existing docs into G2 format',
        description: 'transform — generate a gitignored mirror formatted for the glasses',
        value: 'transform',
      },
      {
        label: '$(link) URL relay only',
        description: 'urlOnly — no project registered; browser extension only',
        value: 'urlOnly',
      },
    ],
    { placeHolder: 'How should this workspace register with Nutshell?' },
  )
  if (!choice) return

  const config = vscode.workspace.getConfiguration('nutshell')

  // Project display name
  const defaultName = settings().name
  const pname = await vscode.window.showInputBox({
    prompt: 'Display name (shown on the glasses home screen)',
    value: defaultName,
    placeHolder: path.basename(root),
  })
  if (pname !== undefined) {
    await config.update('name', pname || '', vscode.ConfigurationTarget.Workspace)
  }

  if (choice.value === 'passthrough') {
    const folder = await vscode.window.showInputBox({
      prompt: 'Folder to serve (relative to workspace root)',
      value: config.get('sourceDocsPath', 'docs'),
    })
    if (!folder) return
    await config.update('mode', 'passthrough', vscode.ConfigurationTarget.Workspace)
    await config.update('sourceDocsPath', folder, vscode.ConfigurationTarget.Workspace)
  } else if (choice.value === 'transform') {
    const src = await vscode.window.showInputBox({
      prompt: 'Source folder containing your existing docs (relative to workspace root)',
      value: config.get('sourceDocsPath', 'docs'),
    })
    if (!src) return
    const out = await vscode.window.showInputBox({
      prompt: 'Output folder for G2-formatted mirror (will be created and gitignored)',
      value: config.get('outputDocsPath', 'nutshell-docs'),
    })
    if (!out) return
    await config.update('mode', 'transform', vscode.ConfigurationTarget.Workspace)
    await config.update('sourceDocsPath', src, vscode.ConfigurationTarget.Workspace)
    await config.update('outputDocsPath', out, vscode.ConfigurationTarget.Workspace)
    ensureGitignoreEntry(root, out)
    ensureClaudeMdHarness(root, { sourceDir: src, outputDir: out })

    const shouldTransform = await vscode.window.showInformationMessage(
      'Configured. Transform now?',
      'Transform',
      'Later',
    )
    if (shouldTransform === 'Transform') {
      await runTransform()
    }
  } else {
    await config.update('mode', 'urlOnly', vscode.ConfigurationTarget.Workspace)
  }

  // Immediate re-register with fresh config
  await heartbeat()
}

async function runTransform() {
  const s = settings()
  if (!s.root) return
  if (s.mode !== 'transform') {
    vscode.window.showWarningMessage(
      'Transform is only available in transform mode. Run "Nutshell: Configure for Workspace".',
    )
    return
  }

  // Determine which source folders to transform.
  let sourceDirs = []
  if (s.docSources.length > 0) {
    // Multi-source: offer picker (all or one specific folder).
    const items = [
      { label: 'All sources', description: `${s.docSources.length} folders`, value: '__all__' },
      ...s.docSources.map((rel) => ({ label: rel, value: rel })),
    ]
    if (s.docSources.length > 1) {
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Transform which doc source?',
      })
      if (!pick) return
      if (pick.value === '__all__') {
        sourceDirs = s.docSources.map((rel) => path.resolve(s.root, rel))
      } else {
        sourceDirs = [path.resolve(s.root, pick.value)]
      }
    } else {
      sourceDirs = [path.resolve(s.root, s.docSources[0])]
    }
  } else {
    sourceDirs = [path.resolve(s.root, s.sourceDocsPath)]
  }

  const outAbs = path.resolve(s.root, s.outputDocsPath)

  for (const srcAbs of sourceDirs) {
    if (!fs.existsSync(srcAbs)) {
      vscode.window.showErrorMessage(`Source folder does not exist: ${path.relative(s.root, srcAbs)}`)
      continue
    }
    // Scope the output to a subfolder matching the source name so
    // multiple sources don't collide in the output.
    const scopedOut = sourceDirs.length > 1
      ? path.join(outAbs, path.basename(srcAbs))
      : outAbs
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Nutshell: transforming ${path.relative(s.root, srcAbs)}`, cancellable: false },
      async (progress) => {
        await transformDocs({
          sourceDir: srcAbs,
          outputDir: scopedOut,
          onFile: (file, i, total) => {
            progress.report({
              message: `${i}/${total}: ${file}`,
              increment: total > 0 ? 100 / total : undefined,
            })
            log(`transform: ${file} (${i}/${total})`)
          },
          onLog: (line) => log(`[transform] ${line}`),
        })
      },
    )
  }
  vscode.window.showInformationMessage('Nutshell: transform complete.')
}

function setupAutoTransform(context) {
  if (saveWatcherDisposable) {
    saveWatcherDisposable.dispose()
    saveWatcherDisposable = null
  }
  const s = settings()
  if (s.mode !== 'transform' || !s.autoTransformOnSave) return

  saveWatcherDisposable = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const s = settings()
    if (!s.root) return
    const filePath = doc.uri.fsPath
    if (!/\.(md|mdx|txt)$/i.test(filePath)) return
    const outAbs = path.resolve(s.root, s.outputDocsPath)

    // Build the list of source directories to check against.
    const sourceDirs = s.docSources.length > 0
      ? s.docSources.map((rel) => path.resolve(s.root, rel))
      : [path.resolve(s.root, s.sourceDocsPath)]

    // Find which source directory contains the saved file.
    const matchedSrc = sourceDirs.find((srcAbs) =>
      filePath.startsWith(srcAbs + path.sep),
    )
    if (!matchedSrc) return

    // When multiple sources exist, scope the output to a subfolder so
    // transforms from different sources don't overwrite each other.
    const scopedOut = sourceDirs.length > 1
      ? path.join(outAbs, path.basename(matchedSrc))
      : outAbs

    await transformDocs({
      sourceDir: matchedSrc,
      outputDir: scopedOut,
      singleFile: filePath,
      onFile: (f) => log(`auto-transform: ${f}`),
      onLog: (line) => log(`[transform] ${line}`),
    })
  })
  context.subscriptions.push(saveWatcherDisposable)
}

// ── Activation ────────────────────────────────────────────────────────────────

async function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Nutshell')
  context.subscriptions.push(outputChannel)

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  context.subscriptions.push(statusBarItem)

  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  register('nutshell.start', startServer)
  register('nutshell.stop', stopServer)
  register('nutshell.restart', restartServer)
  register('nutshell.connectRemote', connectRemote)
  register('nutshell.useLocal', useLocalServer)
  register('nutshell.configure', configureWorkspace)
  register('nutshell.transform', runTransform)
  register('nutshell.copyKey', copyApiKey)
  register('nutshell.enterKey', enterServerKey)
  register('nutshell.showBanner', showBanner)
  register('nutshell.unregister', unregisterThisProject)
  register('nutshell.discover', discoverDocFoldersCommand)
  register('nutshell.addDocSource', addDocSourceCommand)
  register('nutshell.manageSources', manageDocSourcesCommand)
  register('nutshell.showMenu', async () => {
    const s = settings()
    const remote = isRemoteMode(s)
    const docSourceLabel = s.docSources.length > 0
      ? `$(folder-library) Manage doc sources (${s.docSources.length})`
      : '$(folder-library) Manage doc sources'
    const items = remote
      ? [
          { label: '$(plug) Connect to remote server…', description: serverAddr(s), value: 'connectRemote' },
          lastProbedHealth?.ok
            ? { label: '$(debug-stop) Shut down remote server', value: 'stop' }
            : null,
          lastProbedHealth?.ok
            ? { label: '$(refresh) Restart remote server', value: 'restart' }
            : null,
          { label: '$(home) Switch to local server', value: 'useLocal' },
          { label: '$(gear) Configure for workspace', value: 'configure' },
          { label: docSourceLabel, value: 'manageSources' },
          { label: '$(sparkle) Transform docs for G2', value: 'transform' },
          { label: '$(clippy) Copy API key', value: 'copyKey' },
          { label: '$(key) Enter server key', value: 'enterKey' },
          { label: '$(info) Show address and key', value: 'showBanner' },
          { label: '$(trash) Unregister this project', value: 'unregister' },
        ].filter(Boolean)
      : [
          lastProbedHealth?.ok
            ? { label: '$(debug-stop) Stop local server (tracked)', value: 'stop' }
            : { label: '$(play) Start local server', value: 'start' },
          { label: '$(refresh) Restart local server', value: 'restart' },
          { label: '$(plug) Connect to remote server…', value: 'connectRemote' },
          { label: '$(gear) Configure for workspace', value: 'configure' },
          { label: docSourceLabel, value: 'manageSources' },
          { label: '$(sparkle) Transform docs for G2', value: 'transform' },
          { label: '$(clippy) Copy API key', value: 'copyKey' },
          { label: '$(key) Enter server key', value: 'enterKey' },
          { label: '$(info) Show address and key', value: 'showBanner' },
          { label: '$(trash) Unregister this project', value: 'unregister' },
        ]
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Nutshell' })
    if (!pick) return
    await vscode.commands.executeCommand(`nutshell.${pick.value}`)
  })

  updateStatusBar()

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('nutshell')) return
      // Rebuild symlinks when docSources changes.
      const s = settings()
      if (s.root && s.docSources.length > 0) {
        rebuildVirtualRoot(s.root, s.docSources)
        ensureGitignoreEntry(s.root, VIRTUAL_ROOT)
      } else if (s.root) {
        removeVirtualRoot(s.root)
      }
      setupAutoTransform(context)
      await heartbeat()
    }),
  )

  setupAutoTransform(context)

  // If docSources is configured, ensure the virtual root and gitignore are
  // set up on activation (handles workspace reopen, new clone, etc.).
  const s = settings()
  if (s.root && s.docSources.length > 0) {
    rebuildVirtualRoot(s.root, s.docSources)
    ensureGitignoreEntry(s.root, VIRTUAL_ROOT)
  }

  if (s.autoStart && s.root && !isRemoteMode(s)) {
    await startServer()
  }
  startHeartbeat()
}

async function deactivate() {
  stopHeartbeat()
  // Best-effort unregister. Don't kill the server — it survives VS Code close
  // on purpose, so the phone stays connected.
  const s = settings()
  if (s.root && myProjectId) {
    const apiKey = readKey(s.root)
    if (apiKey) {
      try { await unregisterProject(s.host, s.port, apiKey, myProjectId) } catch {}
    }
  }
  // Clean up virtual symlink root so it doesn't linger when the extension
  // is disabled or the workspace closes.
  if (s.root) removeVirtualRoot(s.root)
}

module.exports = { activate, deactivate }
