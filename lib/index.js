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
// files discovered by directory listing, so the route can never be pointed at
// an arbitrary path. The ID allowlist is identity, not containment: an existing
// symlink on an allowed path could still redirect a read or write outside
// DSH_HOME, so before any list/read/backup/write the target is proven to be a
// regular file contained under the canonicalized home, with no symlink in any
// path component (see containedPath). Saves create a uniquely-named, exclusively
// created .bak.<ms> backup next to the file before writing, so a repeated
// timestamp can never overwrite an earlier recovery point.
//
// Request trust: this route serves the privileged configuration plane, so it
// is pinned to loopback-same-origin (Host / Origin / Fetch-Metadata) before
// any filesystem access, and POST requires a real application/json body —
// see lib/request-trust.js for the fence and its upstream references.

import {
  existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync,
  lstatSync, realpathSync, openSync, closeSync, fstatSync, ftruncateSync,
  constants as fsConstants
} from 'node:fs'
import { homedir } from 'node:os'
import { join, sep, relative, isAbsolute, dirname } from 'node:path'
import { isTrustedRequest } from './request-trust.js'

const inject = ['webServer']

const ROUTE_PATH = '/plugins/config-editor'
const MAX_BODY_BYTES = 5 * 1024 * 1024

// Upper bound on backup-name disambiguation attempts. A save takes the plain
// timestamped name, then .bak.<ms>-1, -2, … until one is created exclusively.
// Bounded so a pathological collision storm fails loudly instead of looping.
const MAX_BACKUP_ATTEMPTS = 1000

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

// The canonical permitted root for every editable document. Resolving the
// configured home lets an operator point DSH_HOME at a symlink intentionally
// without the containment walk below mistaking that root link for an escape.
// Returns null when the home itself cannot be resolved.
function canonicalHome() {
  try {
    return realpathSync(dshHome())
  } catch {
    return null
  }
}

// Split a lexical document path into its in-root components, or null when it
// does not live under the configured home. lexicalPath is always built under
// dshHome() (fixed files and presets), so its subpath maps onto the root;
// anything that would climb out lexically, or that contains a '.'/'..' segment,
// is rejected as defense in depth.
function relParts(lexicalPath) {
  const rel = relative(dshHome(), lexicalPath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  const parts = rel.split(sep).filter(Boolean)
  for (const p of parts) if (p === '.' || p === '..') return null
  return parts
}

// Prove a lexical document path is a regular file contained under the canonical
// home with no symlink escaping the root, and return its resolved in-root
// absolute path (or null when it is missing, escapes, is or traverses a
// symlink, or is not a regular file).
//
// The ID allowlist supplies identity; this supplies containment. Every
// component below the root is lstat-walked, so a *static* intermediate-directory
// symlink is caught, not just the terminal filename — O_NOFOLLOW at open time
// guards only the terminal component. A dangling symlink lstats as a link and
// is refused. This is the fast, string-level gate that precedes every
// list/read/backup/write. It does NOT by itself close the check-then-open race
// on intermediate directories (an attacker swapping a checked directory for a
// symlink after this walk) — pinnedParent() below does, and the read/write path
// resolves the terminal through it, never re-resolving this string afterwards.
function containedPath(lexicalPath) {
  const home = canonicalHome()
  if (home === null) return null
  const parts = relParts(lexicalPath)
  if (parts === null) return null
  let cur = home
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i])
    let st
    try {
      st = lstatSync(cur)
    } catch {
      return null // component absent (also covers a dangling terminal symlink)
    }
    if (st.isSymbolicLink()) return null
    const terminal = i === parts.length - 1
    if (terminal ? !st.isFile() : !st.isDirectory()) return null
  }
  return cur
}

// The Linux /proc/self/fd surface lets us open a child relative to an
// already-opened directory descriptor: opening `/proc/self/fd/<dirfd>/<name>`
// resolves <name> against the *pinned inode* the descriptor holds, not by
// re-walking the string path. That is the portable-Node stand-in for openat(2),
// which fs does not expose ergonomically. pinnedParent() uses it to walk to a
// document's parent directory one descriptor at a time, so a component swapped
// for a symlink after we already hold its parent's descriptor cannot redirect
// the walk — closing the intermediate-directory TOCTOU race (#13).
const PROC_FD = '/proc/self/fd'

// Whether the /proc/self/fd walk is available on this host. Cached after the
// first probe. Where it is absent (non-Linux, or /proc not mounted) we fall
// back to resolving the parent by string: O_NOFOLLOW at open time still refuses
// a symlinked terminal (the #6 static-link threat model), but an *active*
// intermediate-directory swap is not closed (#13). That degraded bound is not
// silent: apply() calls warnIfContainmentDegraded() at plugin startup, which
// emits an unmissable one-line warning naming the weakened guard when this
// probe is false — so the residual is a conscious, logged fact rather than an
// implicit one (#16).
let dirFdWalkSupported = null
function supportsDirFdWalk() {
  // Test-only override (see __testHooks): force the fallback branch so the
  // degraded-path behaviour can be exercised on a host that actually supports
  // the walk. Never set in production.
  if (__testHooks.forceDirFdWalkUnsupported) return false
  if (dirFdWalkSupported !== null) return dirFdWalkSupported
  let fd = -1
  try {
    fd = openSync(homedir(), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    // Reaching the just-opened directory back through /proc confirms support.
    closeSync(openSync(join(PROC_FD, String(fd)), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY))
    dirFdWalkSupported = true
  } catch {
    dirFdWalkSupported = false
  } finally {
    if (fd !== -1) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
  return dirFdWalkSupported
}

// Resolve a lexical document path to its terminal's *parent directory*, pinned
// so the terminal can be opened without re-resolving any ancestor after the
// containment check. Returns { dirFd, dirPath, realDirPath, name } or null,
// where the terminal is addressed as join(dirPath, name):
//   - dirFd:       an open descriptor for the pinned parent (null in fallback);
//                  the caller MUST closeSync it when non-null.
//   - dirPath:     the path to open the terminal through — `/proc/self/fd/<fd>`
//                  in the hardened path (only the terminal is ever re-resolved),
//                  or the canonical parent string in fallback.
//   - realDirPath: the stable on-disk parent, used only to report a real path
//                  (e.g. a backup) back to the caller.
//   - name:        the terminal component.
// Callers still open the terminal with O_NOFOLLOW, so a symlinked terminal is
// refused in either mode; the hardened mode additionally defeats an active
// intermediate-directory swap.
function pinnedParent(lexicalPath) {
  const parts = relParts(lexicalPath)
  if (parts === null) return null
  const home = canonicalHome()
  if (home === null) return null
  const name = parts[parts.length - 1]

  if (!supportsDirFdWalk()) {
    // Fallback: canonicalize the parent by string via the lstat walk. Refuses
    // static symlink components; does not close the intermediate-dir race.
    const safe = containedPath(lexicalPath)
    if (safe === null) return null
    const parent = dirname(safe)
    return { dirFd: null, dirPath: parent, realDirPath: parent, name }
  }

  // Hardened: open the canonical root, then walk to the parent one descriptor at
  // a time, opening each intermediate relative to the descriptor already held.
  // home is realpathSync'd, so its own final component is not a symlink.
  let dirFd
  try {
    dirFd = openSync(home, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    for (let i = 0; i < parts.length - 1; i++) {
      let next
      try {
        next = openSync(
          join(PROC_FD, String(dirFd), parts[i]),
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
        )
      } catch {
        return null // component absent, a symlink (ELOOP), or not a directory
      }
      closeSync(dirFd)
      dirFd = next
    }
    const dirPath = join(PROC_FD, String(dirFd))
    let realDirPath
    try {
      realDirPath = realpathSync(dirPath)
    } catch {
      return null
    }
    const held = dirFd
    dirFd = -1 // ownership handed to the caller
    return { dirFd: held, dirPath, realDirPath, name }
  } finally {
    if (dirFd !== -1) closeSync(dirFd)
  }
}

// Test-only seams (never used in production paths):
//   - beforeTerminalOpen: a hook fired after the containment walk and before
//     the terminal is opened — used by the #13 regression test to swap an
//     intermediate directory for a symlink at exactly that instant and prove
//     the pinned walk refuses the escape a string re-open would follow.
//   - forceDirFdWalkUnsupported: when true, supportsDirFdWalk() returns false
//     regardless of the host — used by the #16 test to exercise the degraded
//     fallback (and its startup warning) on a host that actually supports the
//     dir-fd walk.
const __testHooks = { beforeTerminalOpen: null, forceDirFdWalkUnsupported: false }

// Read a contained document read-only without following a terminal symlink,
// confirming on the open descriptor that it is a regular file before returning
// its content. Opening what we then stat closes the check-then-open window on
// the terminal component.
function readContained(safePath) {
  const fd = openSync(safePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

// Overwrite a contained document in place without following a terminal symlink,
// confirming on the open descriptor that it is a regular file before truncating
// and writing.
function writeContained(safePath, content) {
  const fd = openSync(safePath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
    ftruncateSync(fd, 0)
    writeFileSync(fd, content, 'utf8')
  } finally {
    closeSync(fd)
  }
}

// Copy the terminal document to a fresh, exclusively-created backup beside it
// and return the backup's file NAME (relative to the same pinned parent). Both
// source and destination are opened relative to dirPath with O_NOFOLLOW, so the
// backup step inherits the same containment as the read/write: an intermediate
// directory swapped after the containment check cannot redirect it, and neither
// a symlinked source nor a symlinked destination name is followed.
//
// Exclusive creation (O_CREAT | O_EXCL) guarantees an existing recovery point
// is never clobbered; a repeated timestamp takes a disambiguated .bak.<ms>-<n>
// name instead. A copy that cannot complete (e.g. the source vanished) rolls
// back the empty backup and propagates, so the caller aborts the save with the
// original file unchanged. Throws when no unique name can be created.
function createBackup(dirPath, name) {
  const stamp = name + '.bak.' + Date.now()
  for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? stamp : stamp + '-' + attempt
    let destFd
    try {
      destFd = openSync(
        join(dirPath, candidate),
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600
      )
    } catch (err) {
      if (err && err.code === 'EEXIST') continue // name taken; try the next
      throw err
    }
    try {
      let srcFd
      try {
        srcFd = openSync(join(dirPath, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      } catch (err) {
        // The source is gone or is a symlink — abort and leave no stray backup.
        closeSync(destFd)
        try { unlinkSync(join(dirPath, candidate)) } catch { /* best effort */ }
        throw err
      }
      try {
        if (!fstatSync(srcFd).isFile()) throw new Error('not a regular file')
        writeFileSync(destFd, readFileSync(srcFd))
      } finally {
        closeSync(srcFd)
      }
    } finally {
      try { closeSync(destFd) } catch { /* closed on the source-failure path */ }
    }
    return candidate
  }
  throw new Error('could not create a unique backup after ' + MAX_BACKUP_ATTEMPTS + ' attempts')
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
      // Only list a preset whose composition is a contained regular file: a
      // preset reached through a symlinked directory or file escapes the root
      // and must never be surfaced as editable.
      if (containedPath(cordis) !== null) {
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
    // Request-trust fence, applied to every list/read/write before any
    // filesystem access. DSH's raw web server enforces no global request
    // policy, and this route serves the privileged configuration plane
    // (settings, credentials, reverse-proxy, agent presets), so it is pinned
    // to loopback-same-origin — the boundary upstream applies to that plane.
    // A refusal returns no file contents and creates no backup.
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }

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
      // Static containment gate — a symlink component or an out-of-root target
      // is refused here with a generic 404 that leaks neither the resolved path
      // nor the target's content.
      if (containedPath(path) === null) {
        sendJson(res, 404, { error: 'Unknown document ID or file does not exist', content: '' })
        return
      }
      // Pin the parent directory and read the terminal through it, so an active
      // intermediate-directory swap after the gate above cannot redirect the
      // open outside the root (#13). A null result means the walk refused it.
      const pinned = pinnedParent(path)
      if (pinned === null) {
        sendJson(res, 404, { error: 'Unknown document ID or file does not exist', content: '' })
        return
      }
      try {
        if (__testHooks.beforeTerminalOpen) __testHooks.beforeTerminalOpen(pinned)
        sendJson(res, 200, { content: readContained(join(pinned.dirPath, pinned.name)), error: null })
      } catch (err) {
        sendJson(res, 500, { error: (err && err.message) || 'Read failed', content: '' })
      } finally {
        if (pinned.dirFd !== null) closeSync(pinned.dirFd)
      }
      return
    }

    if (req.method === 'POST') {
      // Require the correct Content-Type instead of parsing JSON regardless of
      // it. Enforced before the body is read, so a rejected write reads no
      // body, creates no backup, and changes no file.
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendJson(res, 415, { error: 'Content-Type must be application/json' })
        return
      }

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
      // Static containment gate — allowed ID, but a symlink component or an
      // out-of-root target is refused before any backup or write: no file is
      // created, changed, or leaked.
      if (containedPath(path) === null) {
        sendJson(res, 404, { error: 'Unknown document ID or file does not exist' })
        return
      }
      // Pin the parent directory; the backup and the write both address the
      // terminal through it, so an active intermediate-directory swap after the
      // gate above cannot redirect either open outside the root (#13).
      const pinned = pinnedParent(path)
      if (pinned === null) {
        sendJson(res, 404, { error: 'Unknown document ID or file does not exist' })
        return
      }
      try {
        if (__testHooks.beforeTerminalOpen) __testHooks.beforeTerminalOpen(pinned)

        let backupName
        try {
          // Back up the current file before overwriting it. Exclusive creation
          // means a repeated timestamp can never clobber an earlier recovery
          // point; a failure here leaves the original file untouched.
          backupName = createBackup(pinned.dirPath, pinned.name)
        } catch (err) {
          sendJson(res, 500, { error: 'Backup failed: ' + ((err && err.message) || 'unknown') })
          return
        }
        const backup = join(pinned.realDirPath, backupName)

        try {
          writeContained(join(pinned.dirPath, pinned.name), content)
          console.log('config-editor: saved', join(pinned.realDirPath, pinned.name), '(backup:', backup + ')')
          sendJson(res, 200, { success: true, backup: backup, error: null })
        } catch (err) {
          sendJson(res, 500, { error: 'Write failed: ' + ((err && err.message) || 'unknown') })
        }
      } finally {
        if (pinned.dirFd !== null) closeSync(pinned.dirFd)
      }
      return
    }

    sendJson(res, 405, { error: 'Method not allowed', allow: 'GET, POST' })
  } catch (err) {
    sendJson(res, 500, { error: (err && err.message) || 'internal error' })
  }
}

// Surface the degraded-containment residual at startup instead of leaving it
// silent (#16). When the /proc/self/fd dir-fd walk is unavailable (non-Linux,
// or /proc not mounted), pinnedParent() falls back to a string re-resolve and
// the intermediate-directory TOCTOU guard (#13) is no longer enforced — only
// the static-symlink O_NOFOLLOW protection remains. A guard that degrades in
// silence is indistinguishable from one that works, so we name the specific
// weakened protection in one unmissable warning and keep serving (option 2 of
// the ticket: preserve portability, make the residual visible). Refuse-closed
// was the alternative; it was rejected because the live deploy target always
// has /proc, so failing closed would only ever break portability without
// hardening the real target.
function warnIfContainmentDegraded() {
  if (supportsDirFdWalk()) return
  console.warn(
    'config-editor: SECURITY WARNING — /proc/self/fd is unavailable on this ' +
    'host, so the intermediate-directory TOCTOU containment guard is DEGRADED. ' +
    'Reads and writes still refuse a symlinked terminal (O_NOFOLLOW), but an ' +
    'active swap of an already-checked intermediate directory for a symlink is ' +
    'NO LONGER prevented (issue #13). Run on a Linux host with /proc mounted to ' +
    'restore the full guard.'
  )
}

function apply(ctx) {
  // Probe containment support and warn once at plugin startup if it is degraded.
  warnIfContainmentDegraded()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: serve
  }))
}

// listDocuments/resolveDocPath and the containment/backup helpers are exported
// for unit tests; the composition loader only uses inject/apply. __testHooks is
// a test-only seam (see its definition) and is never touched in production.
export {
  inject, apply, listDocuments, resolveDocPath,
  containedPath, createBackup, supportsDirFdWalk, MAX_BACKUP_ATTEMPTS, __testHooks
}
