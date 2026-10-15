// verdict.mjs — P11, the proxy-mode decrypt verdict (spec 4.11 P11, ⑧⑨⑩⑫⑲; plan P11): one connection of one process through a form's door is
// decrypted only when every rule below holds; otherwise it is forwarded with a closed code and a reason (D38). Data only from the descriptor; no OS
// literal, no harness id. D51④'s `trust-rejected` (the client refused the leaf) stays the backstop elsewhere.
//   facts  = { name: the harness the D51 lookup named for this process (null: none), pid, startedAt (ms or ISO), env (the PROCESS's env; null =
//            unreadable), cwd (the process's; null = unknown) } — never the daemon's own env or cwd.
//   record = { carrierInstalledAt (ms or ISO) of the form's carrier, rootFp256 of the asight root }
//   issuer = makeIssuer()'s object, or null; ctx = the sources.mjs ctx (os, home, dirs, readFile, readdir, policy, join).
import path from 'node:path'
import { readSrc } from './sources.mjs'
import { certBlocks } from '../../../off/pem.mjs'

const fwd = (code, detail, extra) => ({ decrypt: false, code, detail, ...extra })
const hex = (fp) => String(fp || '').replace(/:/g, '').toLowerCase()
const ms = (t) => (t == null ? NaN : typeof t === 'number' ? t : new Date(t).getTime())
const absent = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')
const isAbs = (p) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p)

/** A <src> read against the process: the first set leaf in precedence, or { error, code } when a leaf it reaches cannot be read (the process env
 *  or cwd unknown, a file unreadable or unparsable) — never "unset" (D38). */
function read(src, ctx, facts) {
  if (Array.isArray(src)) { for (const s of src) { const r = read(s, ctx, facts); if (r.error || r.set) return r } return { set: false } }
  const loc = src.file && (src.file.perOs ? src.file.perOs[ctx.os] : src.file)
  if (('env' in src || (loc && loc.env)) && facts.env == null) return { error: 'the process environment could not be read', code: 'environ-unreadable', where: src.env || loc.env }
  if (loc && loc.base === 'cwd' && facts.cwd == null) return { error: 'the process working directory is not known', code: 'config-unreadable', where: loc.path }
  const r = readSrc(src, ctx)
  return r.error ? { ...r, code: 'config-unreadable' } : r
}
const why = (r) => `${r.where}: ${r.error}`

/** The trust rule (⑧⑨): null when the process trusts the asight root through this form's trust, else the forward verdict. */
function trustVerdict(t, ctx, facts, record) {
  if (!t || !t.sources || !t.sources.length) return null
  if (t.when) {
    const r = read(t.when.src, ctx, facts)
    if (r.error) return fwd(r.code, why(r))
    if (!r.set || ('equals' in t.when && r.value !== t.when.equals)) return null // the trust does not apply: the root, installed by `install`
  }
  let hit = null
  for (const s of t.sources) { const r = read(s.from, ctx, facts); if (r.error) return fwd(r.code, why(r)); if (r.set) { hit = r; break } }
  if (!hit) {
    // Node's own roots never hold asight's root, nor does a process whose required source is unset
    return t.base === 'node' || t.sources.some((s) => s.required) ? fwd('var-missing', `none of ${t.sources.length} trust source(s) is set for this process`) : null
  }
  const value = String(hit.value)
  if (!isAbs(value) && facts.cwd == null) return fwd('config-unreadable', `${hit.where} names a relative path and the process working directory is not known`)
  const file = isAbs(value) ? value : (ctx.join || path.join)(facts.cwd, value)
  let text
  try { text = ctx.readFile(file) } catch (e) {
    if (absent(e)) return fwd('ca-not-in-file', `${hit.where} names ${file}, which does not exist`)
    return fwd('file-unreadable', `${hit.where} names ${file}: ${(e && e.code) || e}`)
  }
  return certBlocks(text).some((b) => hex(b.fp) === hex(record.rootFp256)) ? null : fwd('ca-not-in-file', `${hit.where} names ${file}, which does not hold the asight root`)
}

/** → { decrypt: true } | { decrypt: false, code, detail, at? }. */
export function verdictOf({ desc, form, facts = {}, record = {}, issuer, host, ctx }) {
  const pm = desc.proxyMode
  const h = String(host || '').toLowerCase()
  if (facts.name !== desc.name) return fwd('not-verified', `the agent list does not name this process as ${desc.name}`)
  const v = form.verified && form.verified[ctx.os]
  if (v !== true) return fwd('not-verified', `${form.id} is not verified on ${ctx.os}${v && v.reason ? `: ${v.reason}` : ''}`)
  if ((form.forwardOnlyHosts || []).some((x) => x.toLowerCase() === h)) return fwd('not-verified', `${host} is forward-only for ${form.id} until it is verified there`)
  if (form.hostTree && !(desc.hosts || []).some((x) => x.toLowerCase() === h)) return fwd('not-agent-host', `${host} is not a ${desc.name} host; ${form.id} carries the whole host program, the rest is forwarded`)
  const started = ms(facts.startedAt), installed = ms(record.carrierInstalledAt)
  if (Number.isNaN(installed)) return fwd('not-routed', `${form.id} has no carrier installed`)
  if (Number.isNaN(started)) return fwd('start-time-unknown', `the start time of pid ${facts.pid} could not be read`)
  if (started <= installed) return fwd('config-after-start', `pid ${facts.pid} started before ${form.id}'s carrier was installed; restart it once`)
  const pctx = { ...ctx, env: facts.env || {}, cwd: facts.cwd ?? undefined } // the process's env and cwd, never the daemon's
  const t = trustVerdict(form.trust !== 'root' && pm.trusts && pm.trusts[form.trust], pctx, facts, record)
  if (t) return t
  if (!issuer || (issuer.state && issuer.state() !== 'ready')) return fwd('cert-intermediate-unavailable', 'no intermediate certificate to sign leaves with')
  for (const b of pm.blockers || []) {
    if (b.forms && !b.forms.includes(form.id)) continue
    if (b.when) { const w = read(b.when.src, pctx, facts); if (w.error) return fwd(w.code, why(w)); if (!w.set || ('equals' in b.when && w.value !== b.when.equals)) continue }
    const r = read(b.at, pctx, facts)
    if (r.error) return fwd(r.code, why(r))
    if (r.set) return fwd('not-routed', `a user setting keeps ${form.id} from being routed: ${r.where}`, { at: r.where })
  }
  return { decrypt: true }
}
