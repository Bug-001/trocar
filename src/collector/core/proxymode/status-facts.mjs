// status-facts.mjs (core/proxymode) — the one OS-neutral reader of what `status` and `doctor` say per form in the collector model (RFC 1.6 §9.4
// `certificate` / `proxy`, 4.11 §1 「status 按 harness 显示这条链」, CM21, CM31, CM32). Per installed harness × present form
// (descriptor proxyMode.forms, `present`): the certificate from the install-phase manifest items, the proxy from the phase:on items (the value
// written, `prior_value`) and the daemon's doors. The upstream is the door's own rule (chain.mjs upstreamFor) with no process (steps 2, 4, 5), unless
// the daemon answered for a process of that door (its `upstreams`). Names no OS and no harness; every reader is injected (ctx, fs, drift).
import nodeFs from 'node:fs'
import path from 'node:path'
import { itemsOfPhase } from '../../../off/manifest.mjs'
import { judgeEntry, judgeOwned, markedWithoutRecord, samePath } from '../trust/journal.mjs'
import { isPresent, holds, presentPaths, userCertFilesOf, rootHeldIn, inTrocar } from './sources.mjs'
import { planRoutes, priorRecordOf, loopbackDirect, loopbackNote, blockerOf } from './entries.mjs'
import { judgedWith } from './verdict.mjs'
import { upstreamFor, isTrocarDoorUrl } from './chain.mjs'
import { pacLeg } from './pac.mjs'
import { redactProxyUrl, parseProxyUrl } from '../../../netenv/redact.mjs'
import { CODE } from '../codes.mjs'
import { FINDINGS, findingFor } from '../../../netenv/findings.mjs'
import { checkWrapper } from './hooks/wrapper.mjs'
import { sha256, readOrNull } from '../../../off/fsutil.mjs'
import { certBlocks } from '../../../off/pem.mjs'

// status has no process: a relative path a setting names reads as install reads it, under the home (4.11 P4 rule U)
const userFilesOf = (desc, ctx) => userCertFilesOf(desc, { ...ctx, cwd: ctx.home })
const CARRIER = { 'config-key': 'config-key', wrapper: 'wrapper', plugin: 'plugin', 'plugin-file': 'plugin' } // 1.6 §9.4 `carrier` from the descriptor's cert kind
const HOOKS = new Set(['wrapper', 'plugin']) // a carrier that also applies the route (the switch file is read through it): its drift takes the form off the path (1.6 §9.3 row 31)
const INSTALL = 'trocar install'
const red = (v) => (typeof v === 'string' && v.trim() ? redactProxyUrl(v) : null)
const latest = (items) => { const t = items.map((i) => Date.parse(i.installed_at)).filter(Number.isFinite); return t.length ? new Date(Math.max(...t)).toISOString() : null }
/** Is one install item still on disk as trocar recorded it (a file trocar owns, or a key / block it placed in a file of yours)? Unreadable → false. */
/** The door a record wrote, to be shown redacted: `door` while the record is clear; once sealed (only `door_sha256` kept), the first URL in a field trocar wrote
 *  (`value`, `vars.<k>`, `line`), whose `***` in the password still redacts to `***@`. */
export const writtenOf = (x) => x.door ?? ([x.value, ...Object.values(x.vars || {}), x.line].map((v) => typeof v === 'string' && /[a-z][a-z0-9+.-]*:\/\/[^\s"']+/i.exec(v)).find(Boolean) || [null])[0]
export const intactOf = (m, e, fs) => { try { return (e.kind === 'owned-file' ? judgeOwned({ manifest: m, file: e.path, fs }) : judgeEntry({ manifest: m, planned: e, fs })).action === 'skip-intact' } catch { return false } }

/** The install items that carry a harness's certificate: its own, and the pem-block in a user file its settings name that another harness's entry holds —
 *  one block per file, recorded once (4.11 P4 rule U, shared_with), yet it serves both. */
const itemsFor = (desc, inst, ctx) => { const { files } = userFilesOf(desc, ctx); return inst.filter((i) => i.harness === desc.name || (i.kind === 'text' && i.format === 'pem-block' && files.includes(i.path))) }

/** Whether the install items that carry a harness's certificate are all there and unchanged → null | 'carrier-absent' | 'carrier-overwritten'. What install
 *  placed (m.install.items) must still be on record: an item whose record is gone is as absent as its file. Throws when a file cannot be read. */
function carrierLoss(m, desc, own, fs) {
  const h = desc.name
  if (!own.length) return 'carrier-absent'
  if (((m.install.items && m.install.items[h]) || []).some((p) => !own.some((x) => x.kind === p.kind && x.path === p.path))) return 'carrier-absent'
  for (const x of own) {
    if (x.kind === 'owned-file') {
      const d = x.role === 'wrapper' ? checkWrapper({ fs }, x) : (() => { const b = readOrNull(fs, x.path); return b == null ? { reason: 'entry-missing' } : sha256(b) !== x.sha256 ? { reason: 'entry-changed' } : null })()
      if (d) return d.reason === 'entry-missing' ? 'carrier-absent' : 'carrier-overwritten'
    } else {
      const j = judgeEntry({ manifest: m, planned: x, fs })
      if (j.unreadable) throw new Error(j.why) // not read is not changed: setupOf says unknown (D38), never needed or ready
      if (j.action !== 'skip-intact') return fs.existsSync(x.path) ? 'carrier-overwritten' : 'carrier-absent'
    }
  }
  return null
}

/** The ids of this OS's present forms whose certificate needs a carrier of their own (not the root, its `when` holding): proxy mode's forms. */
const carriedForms = (pm, os, ctx) => pm.forms.filter((f) => f.os.includes(os) && isPresent(f, ctx)).filter((f) => {
  const c = f.cert === 'root' ? null : (pm.certs || {})[f.cert]
  return c && !(c.when && holds(c.when, ctx) === false) // the root carries it: nothing per form, whether install saw the harness or not
}).map((f) => f.id)

/** Whether the merged bundle install placed for a replace key with `merges` lacks a CA the files those settings name now hold → null | 'bundle-lacks-ca'
 *  (4.11 P4b). The sources are read as install reads them (readSrc over the caller's sources ctx); a source that cannot be read, a relative path, and a
 *  record with no `user_fps` are not judged. Fingerprints, never paths: a CA not among `user_fps` is looked for in the bundle itself (trocar's root, a
 *  CA that is also a Node root), read only then. Never throws. */
function bundleGap(desc, c, inst, ctx, fs) {
  const b = inst.find((i) => i.harness === desc.name && i.role === 'bundle')
  if (!b || !Array.isArray(b.user_fps)) return null
  const had = new Set(b.user_fps)
  let inBundle
  for (const src of c.merges) {
    let r
    try { r = readSrc(src, ctx) } catch { continue }
    for (const { value } of r.set && !r.error ? r.all : []) {
      const file = typeof value === 'string' ? value.trim() : ''
      if (!path.isAbsolute(file) || inTrocar(file, ctx.home, ctx.os)) continue // install merges no file of trocar's own (model-install.mjs userCertsOf)
      let text
      try { text = fs.readFileSync(file, 'latin1') } catch { continue } // unreadable now: not known, never a false alarm
      for (const { fp } of certBlocks(text)) {
        if (had.has(fp)) continue
        if (inBundle === undefined) { try { inBundle = new Set(certBlocks(fs.readFileSync(b.path, 'latin1')).map((x) => x.fp)) } catch { inBundle = null } }
        if (inBundle && !inBundle.has(fp)) return 'bundle-lacks-ca'
      }
    }
  }
  return null
}

/** The commands that fix a `setup.missing[].what`, in order (4.11 P4b): its finding's steps when the catalogue has one (1.6 附录 B), else install writes what is missing. */
export const setupSteps = (what) => (Object.hasOwn(FINDINGS, what) ? findingFor(what).commands.map((c) => c.run) : [INSTALL])

/**
 * setupOf(desc, { os, manifest, ctx, root, fs, forms }) → { state: 'ready' | 'needed' | 'unknown', missing: [{ form, what }], reason? } — 4.11 P4b, the ONE judgement
 * behind `status`'s `harnesses[h].setup` and `on`'s precondition ⑪ (D65④). Per present form of this OS whose carrier is not the root: its install items
 * (its own, and rule U's shared pem-block) absent → `carrier-absent`, changed → `carrier-overwritten`, a merged bundle that lacks a CA its sources hold now → `bundle-lacks-ca`, skipped by install (`install.skipped`, its file still holding the marked text) → that skip's
 * code (`marked-without-record`, fixed by setupSteps' commands); the root gone from the user's store (`root.state`
 * 'missing'; pending / declined are install's own to-do, not setup) → one `{ form: null, what: 'root-missing' }`. `manifest` null = nothing installed;
 * `{ error }` = it could not be read → `unknown`, and so is a file that cannot be read (D38), with its errno as `code` and the file as `path`: never `ready`.
 * Reads only; no OS question of its own.
 * `forms`: those form ids handed in by driver mode (4.6: one per harness); null → read from the descriptor's proxyMode.
 */
export function setupOf(desc, { os, manifest: m, ctx, root = null, fs = nodeFs, forms = null }) {
  const unknown = (reason) => ({ state: 'unknown', missing: [], reason })
  if (m && (m.error || m.unsupported)) return unknown(`the install record could not be read${m.error ? ` (${m.error})` : ''}`)
  if (forms == null && (!desc || !desc.proxyMode)) return unknown(`${desc ? desc.name : 'this harness'} has no proxy-mode description in this build`)
  const missing = []
  try {
    const ids = forms == null ? carriedForms(desc.proxyMode, os, ctx) : forms
    // a carrier of its own: install's items for it (none when install never saw the harness, unless rule U's shared block carries it)
    const unread = ids.length > 0 && userFilesOf(desc, ctx).unread // a setting that may name rule U's file, not read: whose block carries it is not known
    if (unread) throw new Error(`${unread.where}: ${unread.error}`)
    // a skip counts while its file still holds the marked text no record lists (install's own judgement); gone, the carrier is judged as below
    const skips = [((m && m.install && m.install.skipped) || {})[desc.name]].flat().filter((x) => x && typeof x.code === 'string' && typeof x.path === 'string'
      && !((m && m.entries) || []).some((e) => samePath(e.path, x.path, fs)) && markedWithoutRecord({ file: x.path, fs }))
    // install's own skip of this harness's carrier (`install.skipped`, marked text no record lists) is the cause, not an absent carrier: install repeats it
    const lost = !ids.length ? null : skips.length ? skips[0].code : carrierLoss(m || {}, desc, itemsFor(desc, itemsOfPhase(m, 'install'), ctx), fs)
    // a merged bundle (a replace key with `merges`) that lacks a CA its sources hold now (P4b), when nothing of the carrier is lost
    const pm = desc && desc.proxyMode, gap = {}
    for (const id of ids) {
      const f = pm ? pm.forms.find((x) => x.id === id) : null, c = f && f.cert !== 'root' ? (pm.certs || {})[f.cert] : null
      const what = lost || (c && c.semantics === 'replace' && Array.isArray(c.merges) ? (gap[f.cert] ??= bundleGap(desc, c, itemsOfPhase(m, 'install'), ctx, fs)) : null)
      if (what) missing.push({ form: id, what })
    }
  } catch (e) { return { ...unknown(String((e && e.message) || e)), ...(e && e.code ? { code: e.code } : {}), ...(e && e.path ? { path: e.path } : {}) } } // the errno and the file, for words of the caller's
  if (root && root.state === 'missing') missing.push({ form: null, what: 'root-missing' })
  return missing.length ? { state: 'needed', missing } : { state: 'ready', missing: [] }
}

/** The user's own certificate file a `userCertFiles` key names (1.6 §9.4 `user_file`; of several, the worst): trocar appended to it (intact / changed), or it is not one trocar could
 *  append to; `unknown` with the read code when the file, or a setting that may name it, cannot be read (D38: never `changed`, never none). A file a
 *  replacing setting names with no block on record reads as the door reads it (P11 rule 4): the root in it → no row, none → `without-root`. */
function userFileOf(desc, { m, ctx, fs, own, rootFp256 }) {
  const { files, replacing, unread } = userFilesOf(desc, ctx)
  if (unread) return { path: null, state: 'unknown', reason: `${unread.where}: ${unread.error}`, code: CODE.configUnreadable }
  const rows = files.filter((file) => !own.some((i) => i.path === file && i.kind === 'owned-file')).map((file) => { // trocar's own bundle: not the user's file
    const e = own.find((i) => i.path === file && i.kind !== 'owned-file')
    if (!e && !replacing.has(file)) return { path: file, state: CODE.notUsersFile }
    try { if (!e) return rootHeldIn(file, ctx.readFile, rootFp256) ? null : { path: file, state: 'without-root' }; readOrNull(fs, file) } catch (err) { return { path: file, state: 'unknown', reason: `${file}: ${(err && err.code) || err}`, code: 'file-unreadable' } }
    return { path: file, state: intactOf(m, e, fs) ? 'intact' : 'changed' }
  })
  const rank = (x) => ['intact', 'unknown'].indexOf(x.state) // the worst file is the one reported: not in effect (-1), then not known, then intact
  return rows.filter(Boolean).sort((x, y) => rank(x) - rank(y))[0] || null
}

/** The setting the agent has without trocar, from the prior trocar recorded (null when the user had none): the topology's off path. `e` is the item the
 *  prior was READ from — its file and key — never another key of the same route: a command that names a place must name the true one (1.6 附录 B). */
const settingOf = (prior, e) => {
  const u = prior ? parseProxyUrl(prior) : null
  return u ? { value: red(prior), ...u, source: [{ kind: 'file', where: e.path, ...(e.keys ? { key: e.keys.join('.') } : {}) }], sha256: null } : { value: null, scheme: null, host: null, port: null, source: [], sha256: null }
}

/**
 * modelFormFacts({ harnesses, os, manifest, reply, root, systemProxy, ctx, fs, drift }) → { <h>: [FormFacts] }
 *   reply        the daemon's GET /status ({ doors: { '<h>:<route>': port }, upstreams?: { '<h>:<route>': [{ pid, source, url_redacted }] } }), or null
 *   root         status's `cert.root` ({ state, code, command }): the carrier of a root-trust form
 *   rootFp256    status's `cert.fp256`: the trocar root a file a replacing setting names must hold (P11 rule 4)
 *   systemProxy  chain.mjs's shape (null · { url, bypass } · { pac } · { ok: false })
 *   drift(h)     precondition ⑪ for h: null, or { reason: 'entry-missing' | 'entry-changed', path, command }
 * FormFacts = { id, route, certificate, proxy, entry: { where, kind, trocar, intact } | null, plan: { reason, at, code } | null, setting, notes: [harness-note] }
 */
export async function modelFormFacts({ harnesses, os, manifest: m, reply = null, root = null, rootFp256 = null, systemProxy = null, ctx, fs = nodeFs, drift = () => null }) {
  const out = {}
  const installed = (m && m.install && m.install.harnesses) || []
  const inst = itemsOfPhase(m, 'install'), on = itemsOfPhase(m, 'on')
  const doors = (reply && reply.doors) || {}, answers = (reply && reply.upstreams) || {}
  const ports = Object.values(doors)
  for (const desc of harnesses.filter((d) => d.proxyMode && (installed.includes(d.name) || (m && m.install && on.some((i) => i.harness === d.name))))) { // one install never saw: drawn once on wrote for it (its forms ride the root)
    const pm = desc.proxyMode, h = desc.name
    const plan = planRoutes(desc, ctx), d = drift(h), own = itemsFor(desc, inst, ctx)
    const { code: ufCode, ...uf } = userFileOf(desc, { m, ctx, fs, own, rootFp256 }) || {}
    const forms = []
    // a form the user put out of scope (D56⑥) is not drawn as live; setupOf still reads it
    for (const f of pm.forms.filter((x) => x.os.includes(os) && !(x.verified && x.verified[os] && x.verified[os].reason === 'out-of-scope') && isPresent(x, ctx))) {
      const c = f.cert === 'root' ? null : (pm.certs || {})[f.cert]
      const carrier = !c || (c.when && holds(c.when, ctx) === false) ? 'root' : CARRIER[c.kind] ?? null
      const r = root || {}
      const bad = carrier === 'root' ? (r.state === 'in-place' ? null : { reason: root ? r.code ?? null : CODE.certNotInstalled, command: r.command || INSTALL })
        : d || (own.length ? null : { reason: 'entry-missing', command: INSTALL })
      const certificate = { in_effect: !bad, carrier, user_file: uf.state ? uf : null, since: latest(carrier === 'root' ? inst.filter((i) => i.kind === 'system-root') : own), code: bad ? bad.reason : null, command: bad ? bad.command || INSTALL : null }
      // the user file a setting names carries the form whatever its carrier: a root form's file replaces the system roots (rule U, SSL_CERT_FILE)
      if (bad && bad.reason === null) Object.assign(certificate, { in_effect: null, command: null }) // the user's root store could not be read: not known (D38), never a made-up code
      else if (certificate.in_effect && uf.state === 'unknown') Object.assign(certificate, { in_effect: null, code: ufCode, command: null }) // not known (D38)
      else if (certificate.in_effect && uf.state && uf.state !== 'intact') Object.assign(certificate, { in_effect: false, code: { changed: 'entry-changed', 'without-root': 'replace-without-ca' }[uf.state] || CODE.notUsersFile, command: INSTALL })
      const g = `${h}:${f.route}`, route = pm.routes[f.route] || {}
      const es = on.filter((i) => i.harness === h && i.route === f.route)
      const main = es.find((i) => i.door_sha256 || i.door) || es[0] || null
      const priorItem = priorRecordOf(route, es)
      const priorRaw = priorItem ? priorItem.prior_value : null
      const intact = es.length > 0 && es.every((i) => intactOf(m, i, fs))
      const door_up = doors[g] != null
      const ans = (answers[g] || []).at(-1)
      let upstream
      if (ans && ans.source) upstream = { url_redacted: ans.url_redacted ?? null, source: ans.source }
      else {
        const isTrocarDoor = (v) => isTrocarDoorUrl(v, { ports })
        const u = route.auth === false ? await pacLeg({ systemProxy, isTrocarDoor }) // a PAC's door dials the own leg its PAC names (P10), whatever the group's CLI form follows
          : await upstreamFor({ desc, facts: null, recordedPrior: priorRaw, systemProxy, isTrocarDoor })
        upstream = { url_redacted: red(u.url), source: u.source, ...(u.pac ? { pac: true } : {}) }
      }
      if (upstream.source === 'unknown') upstream.code = CODE.priorProxyUnknown
      // the door judges a process on a route against the verified forms of that route its program file may be (judgedWith), present or not, so a blocker
      // on any of them splices them all: each form reads the first one, naming the form whose blocker it is when that is another (4.11 ⑩)
      const mine = plan.notRouted.find((n) => n.form === f.id)
      const blocked = mine || judgedWith(desc, os, f).filter((g) => g.id !== f.id).map((g) => { const b = blockerOf(desc, g, ctx); return b && { ...b, code: 'not-routed', via: g.id } }).find(Boolean) || null
      forms.push({
        id: f.id, route: f.route, certificate,
        proxy: { connected: intact && door_up, entry_intact: intact, door_up, upstream, written: main ? red(writtenOf(main)) : null, prior: red(priorRaw) },
        entry: main ? { where: main.keys ? `${main.path}#${main.keys.join('.')}` : main.path, kind: route.kind || main.kind, trocar: true, intact } : null,
        plan: blocked ? { reason: blocked.reason, at: blocked.at ?? null, code: blocked.code, ...(blocked.via ? { via: blocked.via } : {}) } : null,
        // the form's own way of being made to read its settings again, and the places it runs from: the doctor's restart steps come from the form the
        // process belongs to, never one fixed sentence (1.6 附录 B). No `restart` of its own: the harness's (`proxy.restart`), through the facts' behaviour.
        restart: f.restart || null, paths: presentPaths(f, ctx), follows: f.systemProxy || null, // the form's own OS-proxy behaviour (4.11 form `systemProxy`), else the harness's
        hook: HOOKS.has(carrier) && !certificate.in_effect && ['entry-changed', 'entry-missing'].includes(certificate.code) ? certificate.code : null,
        setting: main ? settingOf(priorRaw, priorItem || main) : null,
        notes: [...plan.notes.filter((n) => !n.form || n.form === f.id), ...(intact && plan.routes.some((p) => p.id === f.route && loopbackDirect(desc, p)) ? [loopbackNote()] : [])] // 1.6 §3.3: its route in place
          .map((n) => ({ code: n.code, text: n.text, ...(n.paths ? { paths: n.paths } : {}) })),
      })
    }
    out[h] = forms
  }
  return out
}

/** The proxy-mode half of NetFacts (1.6 §9.7) from modelFormFacts: each harness's `forms` and the doors as `forwarder.forms` (a door is the engine's: D47).
 *  The port is the daemon's, else the one the entry holds (a door that is down is still drawn where the agent points). `status` = gatherStatus's facts
 *  (desired, holders, the daemon's reply); `procs` = the platform's processes per harness; `systemProxy` = NetFacts' OS proxy; `settings` = what a new
 *  process reads now (the off path of a form trocar wrote nothing for, e.g. after `off`). */
export function netFormsOf({ model, status, procs = {}, systemProxy = null, settings = {} }) {
  const reply = status.daemon && status.daemon.reply, doors = (reply && reply.doors) || {}
  const forms = {}, fw = {}
  for (const [h, list] of Object.entries(model)) {
    const row = (status.harnesses || []).find((x) => x.id === h) || {}
    const clients = (status.holders || []).filter((x) => x.harness === h).map((x) => x.pid)
    // a form's processes: the forms status found each can be on (`p.forms`, its one predicate over the form's programs and host processes; absent = not told, every form), and
    // where that leaves more than one, the ones whose door group saw it (`upstreams['<h>:<route>']`) — the door's memory only breaks a tie: a process it never answered
    // (started before `on`, not connected yet, after a daemon restart) is still on its form
    const seen = (x) => new Set((((reply && reply.upstreams) || {})[`${h}:${x.route}`] || []).map((a) => a.pid))
    const can = (p) => list.filter((x) => !Array.isArray(p.forms) || p.forms.includes(x.id))
    const on = (p) => { const c = can(p), saw = c.filter((x) => seen(x).has(p.pid)); return saw.length ? saw : c }
    forms[h] = list.map((x) => ({ id: x.id, setting: x.setting || settings[h] || { value: null, scheme: null, host: null, port: null, source: [], sha256: null }, systemProxy, procs: (procs[h] || []).filter((p) => on(p).includes(x)),
      entry: x.entry, route: x.plan, routeId: x.route, hook: x.hook, certificate: x.certificate, proxy: x.proxy, notes: x.notes, restart: x.restart, paths: x.paths, follows: x.follows }))
    for (const x of list) {
      const written = x.proxy.written ? parseProxyUrl(x.proxy.written) : null
      const port = doors[`${h}:${x.route}`] ?? (written ? written.port : null)
      if (port != null) fw[x.id] = { h, port, state: row.desired === 'on' ? 'on' : 'forward-only', upstream: x.proxy.upstream.url_redacted ?? 'DIRECT', source: x.proxy.upstream.source, clients, ...(reply && !x.proxy.door_up ? { down: true } : {}) } // the daemon answered without this door: nobody listens where the entry points (row 12)
    }
  }
  return { forms, forwarder: { pid: reply ? reply.pid ?? null : null, up: !!reply, forms: fw } }
}
