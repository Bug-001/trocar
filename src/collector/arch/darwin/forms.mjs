// forms.mjs — which macOS form a process is, and whether a group's proxy entry may be written (RFC 4.9 §2.3 · §2.4; the mechanism and its reasons are 4.8 §2.3 · §2.4, acceptance W3, W23).
//
// This is the darwin port of `arch/win32/forms.mjs` — the same exports, the same shape — with only the two deltas 4.9 §1 names for this row. (1) `formPathShape` gets
// the darwin branch: `/` is the only separator (a backslash in a darwin path is a letter of a file name), the profile shape masked without a `home` is `/Users/<name>`,
// and case still does not matter (APFS is case-insensitive by default, the reason 4.9 §1 gives for keeping case-blind norms). (2) There is no `cmdlineState` to wait on:
// `ps` gives the whole command line in the same shot as the image (4.9 §1's procinfo row — one ask, no CIM, no back-off), so the Windows two-step (image first, command
// line later, `pending` in between) collapses to one: a form that needs the command line either has it or there is none, and `matchForm` never answers `pending`.
//
// The per-harness data (src/collector/harness/darwin/<h>.mjs) says what each form looks like: an image name, path patterns, a command-line pattern.
// This file reads that data and knows no harness (arch/ never imports harness/ — the daemon hands the forms in). Pure functions, no OS call.
//
// A pattern is a string in the subset that JavaScript and mihomo's .NET regexp2 read the same way, and it is tested the way mihomo tests a process
// rule: ignoring case, unanchored (4.8 §2.3). A form with `match.path` needs the image path to hit one of them; with `match.cmdline` it needs the
// command line to.

const re = (pattern) => new RegExp(pattern, 'i')
const baseName = (p) => String(p).split('/').pop()
const hits = (patterns, text) => patterns.some((p) => re(p).test(text))
/** The image names a form answers to: one string, or a LIST of them (4.9 §2.3's darwin increment, §6.4: Claude Desktop is one form of a process family — the
 *  main binary `Claude` and the Chromium Helpers `Claude Helper` / `Claude Helper (Renderer)` / `Claude Helper (GPU)` under Frameworks/, the utility one owning
 *  the model sockets). Each name is matched exactly, case-blind like every image; a list introduces no prefix and no fuzz. `image: null` is the PATH-ONLY shape
 *  (4.9 §2.3): a form whose paths are its alone — the native installer's version-named binary (`~/.local/share/claude/versions/2.1.296`, a FILE whose basename is
 *  the version) can never pass an image gate, and the Linux signatures already match it by path regex alone. */
export const imagesOf = (f) => (f.match.image == null ? [] : Array.isArray(f.match.image) ? f.match.image : [f.match.image])

/** The path of a process with the user's directory masked, for `form-path-unknown`: `/Users/<user>/…`; the rest is kept so the shape shows.
 *  `home` is the user's home directory (`$HOME`, the daemon's `ctx.home`): the home's own name is masked wherever the home is (a redirected one outside
 *  `/Users`), in any case. Without it, or for a path under some other home, only the `/Users/<name>` shape is masked. */
export function formPathShape(exe, { home = null } = {}) {
  const p = String(exe)
  const h = home ? String(home).replace(/\/+$/, '') : ''
  const last = h.split('/').pop()
  if (last && h.includes('/')) { // the filesystem root has no user name to mask
    const part = (c) => c.replace(/[.*+?^${}()|[\]]/g, '\\$&') // every character is itself; '/' is no special character to a RegExp
    const at = new RegExp(`^${[...h].map(part).join('')}(?=/|$)`, 'i').exec(p)
    if (at) return p.slice(0, at[0].length - last.length) + '<user>' + p.slice(at[0].length)
  }
  return p.replace(/^(\/Users\/)[^/]+/i, '$1<user>')
}

/** matchForm(forms, { exe, cmdline }) → one of
 *    { kind:'form', id }                     the first form (in the order the data lists them) whose image, path and command line all hold
 *    { kind:'path-unknown', forms:[id], shape }  the image is one only an agent has, but the path is none of the known install shapes (`form-path-unknown`)
 *    { kind:'none' }                         not an agent (a `node` without the dsh command line, any other program)
 *  A form whose image is a shared one (`node`, `python3`, `Code Helper`) never gives `path-unknown`: most processes of that image are not agents. A PATH-ONLY form
 *  (`image: null`) never gives `path-unknown` either — it has no image to be told by, its paths are its alone; the gated forms are tried in the data's order first.
 *  `ps` gives the command line in the same shot as the image, so unlike Windows there is nothing to wait for: a form with `match.cmdline` either has it
 *  or there is none (`matchForm` never answers `pending`; a `cmdlineState` field a caller still passes is not read). `home` (optional): the user's home
 *  directory, so the `shape` of a `path-unknown` has no user name in it wherever the home is (see formPathShape). */
export function matchForm(forms, proc, { home = null } = {}) {
  const exe = proc && typeof proc.exe === 'string' ? proc.exe : ''
  const image = baseName(exe).toLowerCase().replace(/\.exe$/, '') // MA4's first measured fact (on a macOS test machine): npm's claude-code ships `bin/claude.exe` on macOS too — the file name carries a vestigial .exe, the form's image does not; a path pattern that names the binary without the suffix still hits it (the patterns are unanchored)
  const gated = exe === '' ? [] : forms.filter((f) => f.match && f.match.image != null && imagesOf(f).some((n) => n.toLowerCase() === image))
  const open = exe === '' ? [] : forms.filter((f) => f.match && f.match.image == null) // the path-only shapes: no image gate, the paths are theirs alone
  for (const f of [...gated, ...open]) {
    const m = f.match
    if (m.path && !hits(m.path, exe)) continue
    if (m.cmdline) {
      if (proc.cmdline == null) continue // ps has no command line for this process: this form cannot be told
      if (!hits(m.cmdline, proc.cmdline)) continue
    }
    return { kind: 'form', id: f.id }
  }
  const only = gated.filter((f) => f.match.reportUnknownPath)
  if (only.length) return { kind: 'path-unknown', forms: only.map((f) => f.id), shape: formPathShape(exe, { home }) }
  return { kind: 'none' }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const anyOf = (patterns) => patterns.map((p) => `(?:${p})`).join('|')

/** The forms of ONE harness as the process signature `off` judges by (4.6 「判活快照」: `on` writes it into the manifest's `liveness.<harness>.signature`,
 *  src/off/signature.mjs reads it with no collector code): `{ match: [pattern per form] } | null` (no form with a `match`), each pattern over the facts `exe` and
 *  `cmdline` holding exactly when `matchForm` answers that form — the image is the basename after the last `/`, case-blind, a vestigial `.exe` dropped, one of the
 *  names exactly; the path patterns are looked ahead for anywhere in it; a PATH-ONLY form (`image: null`) is its paths alone; `cmdline` hits one of the form's command-line
 *  patterns (no command line: no match). The subset the patterns are written in (no anchors, no lookaround, no back-reference — 4.8 §2.3) is what lets them sit inside one
 *  RegExp unchanged. `matchForm`'s "first form in the data's order" is not needed: no two harnesses' forms claim one process (test/collector/harness/darwin-forms.test.mjs).
 *  A `path-unknown` answer (the image of an agent at an install path no form carries) is no form, so the signature does not claim that process either: `off` judges
 *  what the collector would capture. */
export function formSignature(forms) {
  const match = []
  for (const f of forms) {
    const m = f.match
    if (!m) continue
    const names = imagesOf(f)
    if (!names.length && !(m.path && m.path.length)) throw new Error(`form ${f.id}: a match with neither an image nor a path names every process; it cannot be a liveness signature`)
    const ahead = m.path ? `(?=[\\s\\S]*(?:${anyOf(m.path)}))` : ''
    const exe = names.length ? new RegExp(`^${ahead}(?:[\\s\\S]*/)?(?:${names.map(esc).join('|')})(?:\\.exe)?$`, 'i') : new RegExp(anyOf(m.path), 'i')
    match.push({ exe, ...(m.cmdline ? { cmdline: new RegExp(anyOf(m.cmdline), 'i') } : {}) })
  }
  return match.length ? { match } : null
}

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
