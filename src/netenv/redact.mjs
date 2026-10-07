// redact.mjs (src/netenv) — what may be shown of a proxy setting (RFC 1.6 §9.2「永远不印」, §9.5, V46, V52). A proxy URL can carry `user:password@`; it is shown with `***@` in its place, and only a
// hash of the original value is ever kept (`adopted.<harness>.sha256`, so a changed setting is noticed without the setting being stored). Pure, imports only node:crypto.
import crypto from 'node:crypto'

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const DEFAULT_PORT = { http: 80, https: 443, socks4: 1080, socks5: 1080, socks5h: 1080 }

/**
 * `http://alice:pw@proxy.corp:8080/x?token=t` → `http://***@proxy.corp:8080/x`: the credentials and anything after `?` / `#` are left out; a value without credentials is shown as it is. The credentials end at the
 * LAST `@` of the authority (what is before the first `/`, `?` or `#`), as a URL parser reads them: a password may hold an `@` it did not escape (`p@ssw0rd`), and cutting at the first would print the rest of it.
 */
export function redactProxyUrl(url) {
  const text = String(url ?? '').trim()
  const scheme = (SCHEME.exec(text) || [''])[0]
  const rest = text.slice(scheme.length)
  const end = rest.search(/[/?#]/), authority = end < 0 ? rest : rest.slice(0, end), after = end < 0 ? '' : rest.slice(end)
  const at = authority.lastIndexOf('@')
  const q = after.search(/[?#]/)
  return `${scheme}${at >= 0 ? '***@' : ''}${authority.slice(at + 1)}${q < 0 ? after : after.slice(0, q)}${q < 0 ? '' : '…'}`
}

/** sha256 (hex) of the setting as written: what `adopted.<harness>.sha256` holds, in place of the value. */
export const settingSha = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex')

/** `http://127.0.0.1:7890`, `socks5h://h:1080`, `host:3128` (no scheme: HTTP) → `{ scheme, host, port }`, or null when it is not a URL. Credentials are not returned. */
export function parseProxyUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  let u
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`) } catch { return null }
  const scheme = u.protocol.slice(0, -1).toLowerCase()
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) return null
  return { scheme, host, port: u.port ? Number(u.port) : DEFAULT_PORT[scheme] ?? null }
}
