// Request-trust fence for the config-editor host route.
//
// The route reads and writes the DSH configuration plane — settings.yaml,
// reverse-proxy.json, .credentials.yaml, and agent-preset compositions. In
// upstream DSH that whole plane is the privileged method set, pinned to
// loopback-same-origin by the /api browser-trust fence until a real
// authentication layer exists (see @deepseek-ai/dsh-client-connection@0.1.1-rc.2,
// package/lib/index.js:184-198 `isTrustedApiRequest`, and :504-538 the
// `PRIVILEGED_METHODS` set gated with an empty trust list). DSH's raw web
// server applies no global request policy — the route owner is responsible for
// it (@deepseek-ai/dsh-host-webserver@0.1.1-rc.2, package/lib/index.js:183-193).
//
// This module ports that fence and pins the route to loopback with an empty
// trust list, matching the privileged-plane boundary: over plain HTTP the Web
// carrier provides no authentication layer, so a credentials-and-settings
// editor stays loopback-same-origin. rc.2 defines no browser-authentication
// credential (cookie/token) for a client to attach, so there is nothing to
// verify beyond the Host / Origin / Fetch-Metadata fence below; the same-origin
// browser editor and non-browser loopback clients both pass it.

/** Read a single header value from a node:http headers bag or a Fetch Headers. */
function header(headers, name) {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a normalized URL hostname names the local loopback authority:
 * localhost, IPv6 loopback, or any IPv4 address in 127/8. Ported verbatim from
 * the reference `isLoopbackHostname`.
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * Decide whether one request may reach the config-editor route. The route is
 * pinned to loopback (equivalent to the reference fence run with an empty
 * `trustedHosts` list): the Host must be a loopback authority, an explicit
 * `sec-fetch-site: cross-site` marker is refused, and an attached Origin must
 * match the Host authority.
 *
 * The Host fence binds every request, browser-marked or not: over plain HTTP a
 * browser attaches neither Origin nor Fetch-Metadata to image and navigation
 * reads (those headers go only to trustworthy destinations), so an unmarked
 * request may still be a rebound browser read — Host is the one header
 * DNS rebinding cannot forge. A missing or unparsable Host is refused.
 */
function isTrustedRequest(req) {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

export { isTrustedRequest, isLoopbackHostname, parseAuthority, header }
