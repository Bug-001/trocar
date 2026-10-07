// forms.mjs — which Windows form a process is, and whether a group's proxy entry may be written (RFC 4.8 §2.3, §2.4; acceptance W3, W23).
//
// The per-harness data (src/collector/harness/win32/<h>.mjs) says what each form looks like: an image name, path patterns, a command-line pattern.
// This file reads that data and knows no harness (arch/ never imports harness/ — the daemon hands the forms in). Pure functions, no OS call.
//
// A pattern is a string in the subset that JavaScript and mihomo's .NET regexp2 read the same way, and it is tested the way mihomo tests a process
// rule: ignoring case, unanchored (4.8 §2.3). A form with `match.path` needs the image path to hit one of them; with `match.cmdline` it needs the
// command line to, which Windows only gives some time after the process starts (`cmdlineState`, 4.8 §1): until then the answer is `pending`, never `none`.

const re = (pattern) => new RegExp(pattern, 'i')
const baseName = (p) => String(p).split(/[\\/]/).pop()
const hits = (patterns, text) => patterns.some((p) => re(p).test(text))

/** The path of a process with the user's directory masked, for `form-path-unknown`: `C:\Users\<user>\AppData\…`; the rest is kept so the shape shows. */
export function formPathShape(exe) {
  return String(exe).replace(/^([A-Za-z]:[\\/]Users[\\/])[^\\/]+/i, '$1<user>')
}

/** matchForm(forms, { exe, cmdline, cmdlineState }) → one of
 *    { kind:'form', id }                     the first form (in the order the data lists them) whose image, path and command line all hold
 *    { kind:'pending', forms:[id] }          a form needs the command line, and it is not known yet (`pending`, `cim-backoff`): ask again when it is
 *    { kind:'path-unknown', forms:[id], shape }  the image is one only an agent has, but the path is none of the known install shapes (`form-path-unknown`)
 *    { kind:'none' }                         not an agent (a `node.exe` without the dsh command line, any other program)
 *  A form whose image is a shared one (`python.exe`, `node.exe`, `Code.exe`) never gives `path-unknown`: most processes of that image are not agents. */
export function matchForm(forms, proc) {
  const exe = proc && typeof proc.exe === 'string' ? proc.exe : ''
  const image = baseName(exe).toLowerCase()
  const same = exe === '' ? [] : forms.filter((f) => f.match && f.match.image.toLowerCase() === image)
  for (const f of same) {
    const m = f.match
    if (m.path && !hits(m.path, exe)) continue
    if (m.cmdline) {
      if (proc.cmdline == null) {
        if (proc.cmdlineState === 'pending' || proc.cmdlineState === 'cim-backoff') return { kind: 'pending', forms: [f.id] }
        continue // the command line is not there (`empty`, `not-asked`): this form cannot be told
      }
      if (!hits(m.cmdline, proc.cmdline)) continue
    }
    return { kind: 'form', id: f.id }
  }
  const only = same.filter((f) => f.match.reportUnknownPath)
  if (only.length) return { kind: 'path-unknown', forms: only.map((f) => f.id), shape: formPathShape(exe) }
  return { kind: 'none' }
}

/** May this group's proxy entry be written now (4.8 §2.4, §3.2)? `optedIn`: the user named the group's form (`--opt-in`); `upstreamCredentialed`: the
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

/** The value an automatic proxy entry holds (4.8 §3.2): the group's id and the listener's password are the Basic credentials of the kernel's loopback port for that group (`port`, and
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
