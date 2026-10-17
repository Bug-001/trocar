// entry-forms.mjs — whether a group's proxy entry may be written, and what it holds (RFC 4.8 §2.4 · §3, carried by 4.9 §2.4; acceptance W23). Both proxy-mode
// arches (win32, darwin) answer these the same way, so this is the one copy: `arch/<os>/forms.mjs` re-exports it.
//
// A form is the unit of an entry group, an opt-in item and a matrix row; which harness a process is, is the name list's (D51: the base descriptors'
// `processes`, judged by core/registry.mjs), not a form's. This file knows no harness and no OS (the daemon hands the groups in). Pure functions, no OS call.

/** May this group's proxy entry be written now (4.8 §2.4, §3)? `optedIn`: the user named the group's form (`--opt-in`); `upstreamCredentialed`: the
 *  upstream asight would use needs a user name and password. → { ok:true } | { ok:false, reason:'opt-in-needed' | 'form-unsupported' }.
 *  An entry that takes no credentials (Claude Desktop's policy value is an address only) opens a port any process on the machine can use, so its upstream
 *  must carry none. */
export function entryGate(group, { optedIn = false, upstreamCredentialed = false } = {}) {
  if (group.optIn && group.optIn.length && !optedIn) return { ok: false, reason: 'opt-in-needed' }
  if (group.auth === false && upstreamCredentialed) return { ok: false, reason: 'form-unsupported' }
  return { ok: true }
}

const PORT = (n) => Number.isInteger(n) && n >= 1 && n <= 65535
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

/** The value an automatic proxy entry holds (4.8 §3): the group's id and the listener's password are the Basic credentials of the kernel's loopback port for that group (`port`, and
 *  `listenerToken`, both from ~/.asight/collector/ingress.json, allocated by Task 7). A group whose entry takes no credentials (`auth:false`) holds the address alone. */
export function proxyUrl(group, { port, listenerToken } = {}) {
  if (!PORT(port)) throw new TypeError(`the kernel port of ${group.g} must be a TCP port, got ${typeof port === 'number' ? port : typeof port}`)
  if (!group.auth) return `http://127.0.0.1:${port}`
  if (typeof listenerToken !== 'string' || !TOKEN.test(listenerToken)) throw new TypeError('the listener token is 16..128 characters of letters, digits, - and _')
  return `http://${group.g}:${listenerToken}@127.0.0.1:${port}`
}

/** The entries (core/trust shapes: a `json-key` or a `text` / `dotenv-block`) a group's automatic proxy entry writes, one per file the group's agent reads (`proxyEntry.files(ctx)`, the files its trust block is in).
 *  A proxy entry is the pointing itself: it is written only after the kernel has read back that the group is on (4.8 §2.1, 1.6 R9), so it is never part of the trust plan; this is what that later
 *  step writes. Every other entry kind (a policy value, a shim, a launcher, an app setting) is the user's to name and gives none here. The value an entry replaces is the journal's `prior_value`. */
export function proxyEntries(group, ctx, ingress) {
  const e = group.proxyEntry
  if (e.kind !== 'file') return []
  const url = proxyUrl(group, ingress)
  return e.files(ctx).map((path) => (e.format === 'json-key'
    ? { kind: 'json-key', path, keys: e.key, value: url }
    : { kind: 'text', format: 'dotenv-block', path, vars: { [e.block.urlVar]: url, ...e.block.fixed } }))
}
