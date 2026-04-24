'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { encryptedPost } = require('./crypto')

// Thin HTTP client for nutshell-server. Responsible for:
//   - Detecting whether a server is already running on a port
//   - Spawning a detached child if none is running
//   - Tracking our spawned PID so we can stop/restart cleanly
//   - Reading the API key from the workspace's .nutshell-api-key file
//
// Does NOT contain the project registration logic — that lives in extension.js
// because it wants access to VS Code settings and workspace events.

const PID_FILE = '.nutshell-server.pid'
const KEY_FILE = '.nutshell-api-key'
const LOG_FILE = '.nutshell-server.log'

async function probeHealth(port) {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function readKey(workspaceRoot) {
  const file = path.join(workspaceRoot, KEY_FILE)
  if (!fs.existsSync(file)) return null
  const k = fs.readFileSync(file, 'utf8').trim()
  return k || null
}

function readTrackedPid(workspaceRoot) {
  const file = path.join(workspaceRoot, PID_FILE)
  if (!fs.existsSync(file)) return null
  const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
  return Number.isFinite(n) ? n : null
}

function writeTrackedPid(workspaceRoot, pid) {
  fs.writeFileSync(path.join(workspaceRoot, PID_FILE), String(pid), 'utf8')
}

function clearTrackedPid(workspaceRoot) {
  const file = path.join(workspaceRoot, PID_FILE)
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file) } catch {}
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Spawn nutshell-server as a detached child. Logs go to .nutshell-server.log.
// We don't wait for it here — caller should poll /health.
function spawnServer({ workspaceRoot, port, ollama, ollamaModel, ollamaUrl }) {
  const logPath = path.join(workspaceRoot, LOG_FILE)
  const out = fs.openSync(logPath, 'a')

  // Prefer the sibling package's bin for dev; fall back to a global
  // `nutshell-server` on PATH for published installs.
  const localCli = path.join(__dirname, '..', 'node_modules', 'nutshell-server', 'bin', 'cli.js')
  const useLocal = fs.existsSync(localCli)

  const args = ['--port', String(port), '--no-docs']
  if (ollama) {
    args.push('--ollama')
    if (ollamaModel) args.push('--ollama-model', ollamaModel)
    if (ollamaUrl) args.push('--ollama-url', ollamaUrl)
  }

  let child
  if (useLocal) {
    child = spawn(process.execPath, [localCli, ...args], {
      cwd: workspaceRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    })
  } else {
    child = spawn('nutshell-server', args, {
      cwd: workspaceRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    })
  }

  child.unref()
  return child.pid || null
}

function killTracked(workspaceRoot) {
  const pid = readTrackedPid(workspaceRoot)
  if (!pid) return false
  if (pidIsAlive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  clearTrackedPid(workspaceRoot)
  return true
}

// Wait up to timeoutMs for the server to respond on /health.
async function waitForHealthy(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const h = await probeHealth(port)
    if (h && h.ok) return h
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

// Register (or re-register) a project with the server. Idempotent.
async function registerProject(port, apiKey, { id, name, docsPath }) {
  return encryptedPost(`http://localhost:${port}/projects/register`, apiKey, {
    id,
    name,
    docsPath,
  })
}

async function unregisterProject(port, apiKey, id) {
  return encryptedPost(`http://localhost:${port}/projects/unregister`, apiKey, { id })
}

module.exports = {
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
  KEY_FILE,
  PID_FILE,
  LOG_FILE,
}
