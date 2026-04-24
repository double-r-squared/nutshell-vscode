'use strict'

const path = require('path')
const fs = require('fs')
const vscode = require('vscode')

const { transformDocs } = require('./lib/transform')
const { ensureGitignoreEntry } = require('./lib/gitignore')
const { ensureClaudeMdHarness } = require('./lib/claude-md')
const { ensureProjectId } = require('./lib/project-id')
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
    port: config.get('port', 4242),
    name: config.get('name', '') || (root ? path.basename(root) : 'Project'),
    autoStart: config.get('autoStart', true),
    autoTransformOnSave: config.get('autoTransformOnSave', false),
    ollama: config.get('ollama', false),
    ollamaModel: config.get('ollamaModel', 'llama3.2:3b'),
    ollamaUrl: config.get('ollamaUrl', 'http://localhost:11434'),
    apiKey: config.get('apiKey', '') || '',
    root,
  }
}

function resolvedProjectDocsPath(s) {
  if (!s.root) return null
  if (s.mode === 'urlOnly') return null
  if (s.mode === 'transform') return path.resolve(s.root, s.outputDocsPath)
  return path.resolve(s.root, s.sourceDocsPath)
}

function updateStatusBar() {
  if (!statusBarItem) return
  const s = settings()
  if (lastProbedHealth?.ok) {
    statusBarItem.text = `$(radio-tower) Nutshell`
    const pCount = lastProbedHealth.projectCount || 0
    statusBarItem.tooltip = `Server on :${s.port} · ${pCount} project(s). Click for menu.`
    statusBarItem.backgroundColor = undefined
  } else {
    statusBarItem.text = `$(circle-slash) Nutshell`
    statusBarItem.tooltip = `Server not detected on :${s.port}. Click to start.`
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  }
  statusBarItem.command = 'nutshell.showMenu'
  statusBarItem.show()
}

// ── Heartbeat: probe health + keep our project registered ────────────────────

async function heartbeat() {
  const s = settings()
  if (!s.root) return

  const health = await probeHealth(s.port)
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
    log(`Server is up on :${s.port} but no API key found in ${s.root}/.nutshell-api-key`)
    log(`Tip: copy the key from the server's terminal output and run "Nutshell: Enter Server Key"`)
    if (!keyPromptShown) {
      keyPromptShown = true
      vscode.window
        .showWarningMessage(
          `Nutshell server found on port ${s.port} but no API key is saved for this workspace.`,
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
    await registerProject(s.port, apiKey, {
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

  const existing = await probeHealth(s.port)
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

  const up = await waitForHealthy(s.port, 10_000)
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

  // Only kill what we spawned — don't touch a server started manually.
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
  await stopServer()
  // Give the port a moment to release.
  await new Promise((r) => setTimeout(r, 500))
  await startServer()
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
  const addr = `localhost:${s.port}`
  const status = lastProbedHealth?.ok ? 'running' : 'stopped'
  const msg = `Nutshell ${status}: ${addr}${key ? ' · key saved' : ' · no key yet'}`
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
    await unregisterProject(s.port, apiKey, myProjectId)
    log(`unregistered project ${myProjectId}`)
    vscode.window.showInformationMessage('Project unregistered from Nutshell server.')
  } catch (err) {
    vscode.window.showErrorMessage(`Unregister failed: ${err.message}`)
  }
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
  const srcAbs = path.resolve(s.root, s.sourceDocsPath)
  const outAbs = path.resolve(s.root, s.outputDocsPath)
  if (!fs.existsSync(srcAbs)) {
    vscode.window.showErrorMessage(`Source folder does not exist: ${s.sourceDocsPath}`)
    return
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Nutshell: transforming docs', cancellable: false },
    async (progress) => {
      await transformDocs({
        sourceDir: srcAbs,
        outputDir: outAbs,
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
    const srcAbs = path.resolve(s.root, s.sourceDocsPath)
    const filePath = doc.uri.fsPath
    if (!filePath.startsWith(srcAbs + path.sep)) return
    if (!/\.(md|mdx|txt)$/i.test(filePath)) return
    const outAbs = path.resolve(s.root, s.outputDocsPath)
    await transformDocs({
      sourceDir: srcAbs,
      outputDir: outAbs,
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
  register('nutshell.configure', configureWorkspace)
  register('nutshell.transform', runTransform)
  register('nutshell.copyKey', copyApiKey)
  register('nutshell.enterKey', enterServerKey)
  register('nutshell.showBanner', showBanner)
  register('nutshell.unregister', unregisterThisProject)
  register('nutshell.showMenu', async () => {
    const items = [
      lastProbedHealth?.ok
        ? { label: '$(debug-stop) Stop server (tracked)', value: 'stop' }
        : { label: '$(play) Start server', value: 'start' },
      { label: '$(refresh) Restart server', value: 'restart' },
      { label: '$(gear) Configure for workspace', value: 'configure' },
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
      setupAutoTransform(context)
      await heartbeat()
    }),
  )

  setupAutoTransform(context)

  const s = settings()
  if (s.autoStart && s.root) {
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
      try { await unregisterProject(s.port, apiKey, myProjectId) } catch {}
    }
  }
}

module.exports = { activate, deactivate }
