// Config & Agent Preset Editor — host half (real composition plugin).
//
// Runs in the DSH host process as a profile plugin row (see cordis.patch.yml).
// Serves one route, /plugins/config-editor, for the browser editor in
// lib/client.js:
//   GET  /plugins/config-editor            → { docs } — the editable files
//   GET  /plugins/config-editor?id=<id>     → { content } — read one file
//   POST /plugins/config-editor {id,content} → { success, backup } — save
//
// The dynamic-plugin predecessor routed file access through the shell service
// with base64-encoded writes; a real composition plugin runs in the host
// process, so this half reads and writes files directly through node:fs.
//
// Path safety: the client addresses documents by ID, never by path. IDs map
// only to fixed well-known config files and to agent-preset agent.cordis.yml
// files discovered by directory listing, so the route can never be pointed
// at an arbitrary path. Saves create a timestamped .bak.<ms> backup next to
// the file before writing.

import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const inject = ['webServer']

const ROUTE_PATH = '/plugins/config-editor'
const MAX_BODY_BYTES = 5 * 1024 * 1024

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

// The editable document set: fixed well-known files plus every agent preset's
// agent.cordis.yml (the composition filename inside a preset directory).
// Keyed by the stable ID the client uses.
function listDocuments() {
  const home = dshHome()
  const docs = [
    { id: 'settings', label: 'Settings (settings.yaml)', path: join(home, 'settings.yaml'), type: 'yaml' },
    { id: 'reverse-proxy', label: 'Remote Access / Proxy (reverse-proxy.json)', path: join(home, 'reverse-proxy.json'), type: 'json' },
    { id: 'credentials', label: 'Credentials Metadata (.credentials.yaml)', path: join(home, '.credentials.yaml'), type: 'yaml' }
  ]

  try {
    const presetsDir = join(home, '.agent-presets')
    for (const name of readdirSync(presetsDir)) {
      const cordis = join(presetsDir, name, 'agent.cordis.yml')
      if (existsSync(cordis)) {
        docs.push({
          id: 'preset:' + name,
          label: 'Agent Preset: ' + name + ' (agent.cordis.yml)',
          path: cordis,
          type: 'yaml'
        })
      }
    }
  } catch (err) {
    console.log('config-editor: preset listing failed:', err && err.message)
  }

  return docs
}

// Resolve an ID to an existing file path, or null when the ID is unknown or
// the file does not exist. Preset IDs accept only sane directory names, and
// the resolved path must live under the presets directory.
function resolveDocPath(id) {
  if (typeof id !== 'string' || id.length === 0) return null
  const docs = listDocuments()
  const doc = docs.find((d) => d.id === id)
  if (!doc) return null
  if (!existsSync(doc.path)) return null
  return doc.path
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function serve(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost')

    if (req.method === 'GET') {
      const id = url.searchParams.get('id')

      // List documents.
      if (id === null) {
        sendJson(res, 200, { docs: listDocuments() })
        return
      }

      // Read one document.
      const path = resolveDocPath(id)
      if (path === null) {
        sendJson(res, 404, { error: 'Unknown document ID or file does not exist', content: '' })
        return
      }
      try {
        sendJson(res, 200, { content: readFileSync(path, 'utf8'), error: null })
      } catch (err) {
        sendJson(res, 500, { error: (err && err.message) || 'Read failed', content: '' })
      }
      return
    }

    if (req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (err) {
        sendJson(res, 400, { error: 'Invalid JSON body: ' + ((err && err.message) || 'parse failed') })
        return
      }

      const id = body && body.id
      const content = body && body.content
      if (typeof id !== 'string' || typeof content !== 'string') {
        sendJson(res, 400, { error: 'Body needs string fields "id" and "content"' })
        return
      }

      const path = resolveDocPath(id)
      if (path === null) {
        sendJson(res, 404, { error: 'Unknown document ID or file does not exist' })
        return
      }

      const timestamp = Date.now()
      let backup = null
      try {
        // Back up the current file before overwriting it.
        const backupPath = path + '.bak.' + timestamp
        copyFileSync(path, backupPath)
        backup = backupPath
      } catch (err) {
        sendJson(res, 500, { error: 'Backup failed: ' + ((err && err.message) || 'unknown') })
        return
      }

      try {
        writeFileSync(path, content, 'utf8')
        console.log('config-editor: saved', path, '(backup:', backup + ')')
        sendJson(res, 200, { success: true, backup: backup, error: null })
      } catch (err) {
        sendJson(res, 500, { error: 'Write failed: ' + ((err && err.message) || 'unknown') })
      }
      return
    }

    sendJson(res, 405, { error: 'Method not allowed', allow: 'GET, POST' })
  } catch (err) {
    sendJson(res, 500, { error: (err && err.message) || 'internal error' })
  }
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: serve
  }))
}

// listDocuments/resolveDocPath are exported for unit tests; the composition
// loader only uses inject/apply.
export { inject, apply, listDocuments, resolveDocPath }
