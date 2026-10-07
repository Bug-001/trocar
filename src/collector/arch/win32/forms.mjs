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
