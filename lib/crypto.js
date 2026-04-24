'use strict'

// Node-side PSK encryption matching nutshell-server/lib/crypto.js exactly.
// Used by the VS Code extension to talk to the server as an encrypted client.

const crypto = require('crypto')

function deriveKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest()
}

function encrypt(plaintext, apiKey) {
  const key = deriveKey(apiKey)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('base64'),
    data: Buffer.concat([ct, tag]).toString('base64'),
  }
}

function decrypt(envelope, apiKey) {
  if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') {
    throw new Error('Malformed envelope')
  }
  const key = deriveKey(apiKey)
  const iv = Buffer.from(envelope.iv, 'base64')
  const combined = Buffer.from(envelope.data, 'base64')
  if (iv.length !== 12 || combined.length < 16) throw new Error('Malformed envelope')
  const ct = combined.slice(0, combined.length - 16)
  const tag = combined.slice(combined.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// Convenience wrapper for encrypted POST requests.
async function encryptedPost(url, apiKey, payload) {
  const envelope = encrypt(JSON.stringify(payload || {}), apiKey)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  if (!res.ok && res.status !== 200) {
    let body = null
    try { body = await res.json() } catch {}
    return { status: res.status, error: body }
  }
  const respEnvelope = await res.json()
  const plaintext = decrypt(respEnvelope, apiKey)
  return { status: res.status, plaintext }
}

module.exports = { encrypt, decrypt, encryptedPost }
