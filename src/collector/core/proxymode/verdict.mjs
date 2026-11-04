// verdict.mjs — P11, the proxy-mode decrypt verdict (spec 4.11 P11, ⑧⑨⑩⑫⑲; plan P11): one connection of one process through a form's door is
// decrypted only when every rule below holds; otherwise it is forwarded with a closed code and a reason (D38). Data only from the descriptor; no OS
// literal, no harness id. D51④'s `trust-rejected` (the client refused the leaf) stays the backstop elsewhere.
//   facts  = { name: the harness the D51 lookup named for this process with the host-tree rule applied first (host-agent.mjs whoseWithHosts: an
//            editor carrying the harness's extension is named as that harness; null: none), pid, startedAt (ms or ISO), env (the PROCESS's env; null =
//            unreadable), cwd (the process's; null = unknown) } — never the daemon's own env or cwd.
//   record = { carrierInstalledAt (ms or ISO) of the form's carrier, rootFp256 of the trocar root }
//   hostSet = for a hostTree form, the host set the door built once at on / status (host-agent hostSetOf().hosts: the default hosts, the base-URL
//            hosts in the extension's own settings, the operator's extra_hosts; 4.8 OPEN 22); absent → desc.hosts.
//   issuer = makeIssuer()'s object, or null; ctx = the sources.mjs ctx (os, home, dirs, readFile, readdir, policy, join).
import path from 'node:path'
import { readSrc } from './sources.mjs'
import { certBlocks } from '../../../off/pem.mjs'
import { itemsOfPhase } from '../../../off/manifest.mjs'
import { HOOK_PID_ENV } from './chain.mjs'

const fwd = (code, detail, extra) => ({ decrypt: false, code, detail, ...extra })
// a verdict from evidence that could not be read (the process env or cwd, a file): `unread`, so the door judges again on a later connection (4.11 P11, D38)
const notRead = (r) => fwd(r.code, why(r), { unread: true })
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

/** The trust rule (⑧⑨): null when the process trusts the trocar root through this form's trust, else the forward verdict. `inProcess` (a plugin
 *  carrier puts the root in the process): the sources then feed ⑭ only, so only a source or file that cannot be read forwards (D38). */
function trustVerdict(t, ctx, facts, record, inProcess) {
  if (!t || !t.sources || !t.sources.length) return null
  if (t.when) {
    const r = read(t.when.src, ctx, facts)
    if (r.error) return notRead(r)
    if (!r.set || ('equals' in t.when && r.value !== t.when.equals)) return null // the trust does not apply: the root, installed by `install`
  }
  let hit = null
  for (const s of t.sources) { const r = read(s.from, ctx, facts); if (r.error) return notRead(r); if (r.set) { hit = r; break } }
  if (!hit) {
    if (inProcess) return null
    // Node's own roots never hold trocar's root, nor does a process whose required source is unset
    return t.base === 'node' || t.sources.some((s) => s.required) ? fwd('var-missing', `none of ${t.sources.length} trust source(s) is set for this process`) : null
  }
  const value = String(hit.value)
  if (!isAbs(value) && facts.cwd == null) return fwd('config-unreadable', `${hit.where} names a relative path and the process working directory is not known`, { unread: true })
  const file = isAbs(value) ? value : (ctx.join || path.join)(facts.cwd, value)
  let text
  try { text = ctx.readFile(file) } catch (e) {
    if (absent(e)) return inProcess ? null : fwd('ca-not-in-file', `${hit.where} names ${file}, which does not exist`)
    return fwd('file-unreadable', `${hit.where} names ${file}: ${(e && e.code) || e}`, { unread: true })
  }
  return inProcess || certBlocks(text).some((b) => hex(b.fp) === hex(record.rootFp256)) ? null : fwd('ca-not-in-file', `${hit.where} names ${file}, which does not hold the trocar root`)
}

/** The forms a process of `desc` may be on `os` (on a door of route `routeId`, or any): of its forms here, the verified ones when any is — D51 names
 *  a harness, not a form, so an unmeasured sibling must not veto the verified ones. The door judges every one of them; `status` asks the same. */
export function judgedForms(desc, os, routeId = null) {
  const all = desc.proxyMode.forms.filter((f) => f.os.includes(os) && (routeId == null || f.route === routeId))
  const ok = all.filter((f) => f.verified && f.verified[os] === true)
  return ok.length ? ok : all
}

/** The carrier time of a form (rule 3): the latest install item of its harness, or the root in the user's store for a root-trust form. Unknown → null. */
export function carrierAt(manifest, desc, f) {
  const items = itemsOfPhase(manifest, 'install')
  const own = f.cert !== 'root' && (desc.proxyMode.certs || {})[f.cert] ? items.filter((i) => i.harness === desc.name) : []
  const t = (own.length ? own : items.filter((i) => i.kind === 'system-root')).map((i) => ms(i.installed_at)).filter(Number.isFinite)
  return t.length ? Math.max(...t) : null
}

/** Rule 3 alone: null when a process started at `startedAt` is late enough for a carrier installed at `installedAt`, else the code. The door and
 *  `status` (for a process the door has not judged) both ask this one. */
export function startVerdict(startedAt, installedAt) {
  const started = ms(startedAt), installed = ms(installedAt)
  if (Number.isNaN(installed)) return 'cert-not-installed' // no carrier on record: not a missing route (4.11 P11 rule 3)
  if (Number.isNaN(started)) return 'start-time-unknown'
  return started <= installed ? 'config-after-start' : null
}

/** → { decrypt: true } | { decrypt: false, code, detail, at? }. */
export function verdictOf({ desc, form, facts = {}, record = {}, issuer, host, hostSet, ctx }) {
  const pm = desc.proxyMode
  const h = String(host || '').toLowerCase()
  if (facts.name !== desc.name) return fwd('not-verified', `the agent list does not name this process as ${desc.name}`)
  const v = form.verified && form.verified[ctx.os]
  if (v !== true) return fwd('not-verified', `${form.id} is not verified on ${ctx.os}${v && v.reason ? `: ${v.reason}` : ''}`)
  if ((form.forwardOnlyHosts || []).some((x) => x.toLowerCase() === h)) return fwd('not-verified', `${host} is forward-only for ${form.id} until it is verified there`)
  if (form.hostTree && !(hostSet || desc.hosts || []).some((x) => x.toLowerCase() === h)) return fwd('outside-host-set', `${host} is outside ${form.id}'s host set; the host program's other connections are forwarded`)
  const sv = startVerdict(facts.startedAt, record.carrierInstalledAt)
  if (sv === 'cert-not-installed') return fwd(sv, `${form.id} has no certificate carrier on record`)
  if (sv === 'start-time-unknown') return fwd(sv, `the start time of pid ${facts.pid} could not be read`, { unread: true })
  if (sv) return fwd(sv, `pid ${facts.pid} started before trocar's settings for ${form.id} were in place (its proxy entry and the certificate it needs); restart it once`)
  const pctx = { ...ctx, env: facts.env || {}, cwd: facts.cwd ?? undefined } // the process's env and cwd, never the daemon's
  const inProcess = (pm.certs || {})[form.cert]?.kind === 'plugin' // rule 4: a plugin carrier adds the root in process; its trust sources serve ⑭ only
  if (inProcess && facts.env == null) return fwd('environ-unreadable', 'the process environment could not be read, so whether this process ran the hook itself is not known', { unread: true }) // D38
  const hookPid = inProcess ? String(facts.env[HOOK_PID_ENV] ?? '').trim() : '' // ... unless the hook that wrote the env was a parent's
  if (hookPid !== '' && hookPid !== String(facts.pid)) return fwd('hook-inherited', `pid ${facts.pid} inherited the door from its parent (pid ${hookPid}) and did not run the hook itself, so it holds no trocar root`)
  const t = trustVerdict(form.trust !== 'root' && pm.trusts && pm.trusts[form.trust], pctx, facts, record, inProcess)
  if (t) return t
  if (!issuer || (issuer.state && issuer.state() !== 'ready')) return issuer && issuer.state() === 'key-missing' ? fwd('cert-key-missing', 'the root key is not in its custody: nothing signs leaves') : fwd('cert-intermediate-unavailable', 'no intermediate certificate to sign leaves with')
  for (const b of pm.blockers || []) {
    if (b.forms && !b.forms.includes(form.id)) continue
    if (b.when) { const w = read(b.when.src, pctx, facts); if (w.error) return notRead(w); if (!w.set || ('equals' in b.when && w.value !== b.when.equals)) continue }
    const r = read(b.at, pctx, facts)
    if (r.error) return notRead(r)
    if (r.set) return fwd('not-routed', `a user setting keeps ${form.id} from being routed: ${r.where}`, { at: r.where })
  }
  return { decrypt: true }
}
