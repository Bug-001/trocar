// status-facts.mjs (core/proxymode) — the one OS-neutral reader of what `status` and `doctor` say per form in the collector model (RFC 1.6 §9.4
// `certificate` / `proxy`, 4.11 §1 「status 按 harness 显示这条链」, CM21, CM31, CM32; plan §E.7 rulings 2 and 6). Per installed harness × present form
// (descriptor proxyMode.forms, `present`): the certificate from the install-phase manifest items, the proxy from the phase:on items (the value
// written, `prior_value`) and the daemon's doors. The upstream is the door's own rule (chain.mjs upstreamFor) with no process (steps 2, 4, 5), unless
// the daemon answered for a process of that door (its `upstreams`). Names no OS and no harness; every reader is injected (ctx, fs, drift).
import nodeFs from 'node:fs'
import { itemsOfPhase } from '../../../off/manifest.mjs'
import { judgeEntry, judgeOwned } from '../trust/journal.mjs'
import { isPresent, readSrc, holds } from './sources.mjs'
import { planRoutes } from './entries.mjs'
import { upstreamFor, isAsightDoorUrl } from './chain.mjs'
import { redactProxyUrl, parseProxyUrl } from '../../../netenv/redact.mjs'
import { CODE } from '../codes.mjs'

const CARRIER = { 'config-key': 'config-key', wrapper: 'wrapper', plugin: 'plugin', 'plugin-file': 'plugin' } // 1.6 §9.4 `carrier` from the descriptor's cert kind
const HOOKS = new Set(['wrapper', 'plugin']) // a carrier that also applies the route (the switch file is read through it): its drift takes the form off the path (1.6 §9.3 row 31)
const INSTALL = 'asight install'
const red = (v) => (typeof v === 'string' && v.trim() ? redactProxyUrl(v) : null)
const latest = (items) => { const t = items.map((i) => Date.parse(i.installed_at)).filter(Number.isFinite); return t.length ? new Date(Math.max(...t)).toISOString() : null }
const intactOf = (m, e, fs) => { try { return (e.kind === 'owned-file' ? judgeOwned({ manifest: m, file: e.path, fs }) : judgeEntry({ manifest: m, planned: e, fs })).action === 'skip-intact' } catch { return false } }

/** The files a harness's `userCertFiles` keys name now, in the descriptor's order. */
const userFilesOf = (desc, ctx) => (desc.proxyMode.userCertFiles || []).map((src) => readSrc(src, ctx)).filter((r) => r.set && typeof r.value === 'string').map((r) => r.value)
/** The install items that carry a harness's certificate: its own, and the pem-block in a user file its settings name that another harness's entry holds —
 *  one block per file, recorded once (4.11 P4 rule U, shared_with), yet it serves both. */
const itemsFor = (desc, inst, ctx) => { const files = userFilesOf(desc, ctx); return inst.filter((i) => i.harness === desc.name || (i.kind === 'text' && i.format === 'pem-block' && files.includes(i.path))) }

/** The user's own certificate file a `userCertFiles` key names (1.6 §9.4 `user_file`): asight appended to it (intact / changed), or it is not one asight could append to. */
function userFileOf(desc, { m, ctx, fs, own }) {
  for (const file of userFilesOf(desc, ctx)) {
    if (own.some((i) => i.path === file && i.kind === 'owned-file')) continue // asight's own bundle: not the user's file
    const e = own.find((i) => i.path === file && i.kind !== 'owned-file')
    return { path: file, state: !e ? CODE.notUsersFile : intactOf(m, e, fs) ? 'intact' : 'changed' }
  }
  return null
}

/** The setting the agent has without asight, from the prior asight recorded (null when the user had none): the topology's off path. */
const settingOf = (prior, e) => {
  const u = prior ? parseProxyUrl(prior) : null
  return u ? { value: red(prior), ...u, source: [{ kind: 'file', where: e.path, ...(e.keys ? { key: e.keys.join('.') } : {}) }], sha256: null } : { value: null, scheme: null, host: null, port: null, source: [], sha256: null }
}

/**
 * modelFormFacts({ harnesses, os, manifest, reply, root, systemProxy, ctx, fs, drift }) → { <h>: [FormFacts] }
 *   reply        the daemon's GET /status ({ doors: { '<h>:<route>': port }, upstreams?: { '<h>:<route>': [{ pid, source, url_redacted }] } }), or null
 *   root         status's `cert.root` ({ state, code, command }): the carrier of a root-trust form
 *   systemProxy  chain.mjs's shape (null · { url, bypass } · { pac } · { ok: false })
 *   drift(h)     precondition ⑪ for h: null, or { reason: 'entry-missing' | 'entry-changed', path, command }
 * FormFacts = { id, route, certificate, proxy, entry: { where, kind, asight, intact } | null, plan: { reason, at, code } | null, setting, notes: [harness-note] }
 */
export async function modelFormFacts({ harnesses, os, manifest: m, reply = null, root = null, systemProxy = null, ctx, fs = nodeFs, drift = () => null }) {
  const out = {}
  const installed = (m && m.install && m.install.harnesses) || []
  const inst = itemsOfPhase(m, 'install'), on = itemsOfPhase(m, 'on')
  const doors = (reply && reply.doors) || {}, answers = (reply && reply.upstreams) || {}
  const ports = Object.values(doors)
  for (const desc of harnesses.filter((d) => d.proxyMode && installed.includes(d.name))) {
    const pm = desc.proxyMode, h = desc.name
    const plan = planRoutes(desc, ctx), d = drift(h), own = itemsFor(desc, inst, ctx)
    const uf = userFileOf(desc, { m, ctx, fs, own })
    const forms = []
    for (const f of pm.forms.filter((x) => x.os.includes(os) && isPresent(x, ctx))) {
      const c = f.cert === 'root' ? null : (pm.certs || {})[f.cert]
      const carrier = !c || (c.when && holds(c.when, ctx) === false) ? 'root' : CARRIER[c.kind] ?? null
      const r = root || {}
      const bad = carrier === 'root' ? (r.state === 'in-place' ? null : { reason: root ? r.code ?? null : CODE.certNotInstalled, command: r.command || INSTALL }) // a root status could not read (no code): not known, never a made-up code
        : d || (own.length ? null : { reason: 'entry-missing', command: INSTALL })
      const certificate = { in_effect: !bad, carrier, user_file: carrier === 'root' ? null : uf, since: latest(carrier === 'root' ? inst.filter((i) => i.kind === 'system-root') : own), code: bad ? bad.reason : null, command: bad ? bad.command || INSTALL : null }
      if (certificate.in_effect && uf && uf.state !== 'intact' && carrier !== 'root') Object.assign(certificate, { in_effect: false, code: uf.state === 'changed' ? 'entry-changed' : CODE.notUsersFile, command: INSTALL })
      const g = `${h}:${f.route}`, route = pm.routes[f.route] || {}
      const es = on.filter((i) => i.harness === h && i.route === f.route)
      const main = es.find((i) => i.door) || es[0] || null
      const priorRaw = es.map((i) => i.prior_value).find((v) => typeof v === 'string') ?? null
      const intact = es.length > 0 && es.every((i) => intactOf(m, i, fs))
      const door_up = doors[g] != null
      const ans = (answers[g] || []).at(-1)
      let upstream
      if (ans && ans.source) upstream = { url_redacted: ans.url_redacted ?? null, source: ans.source }
      else {
        const u = await upstreamFor({ desc, facts: null, recordedPrior: priorRaw, systemProxy, isAsightDoor: (v) => isAsightDoorUrl(v, { ports }) })
        upstream = { url_redacted: red(u.url), source: u.source, ...(u.pac ? { pac: true } : {}) }
      }
      if (upstream.source === 'unknown') upstream.code = CODE.priorProxyUnknown
      const blocked = plan.notRouted.find((n) => n.form === f.id) || null
      forms.push({
        id: f.id, route: f.route, certificate,
        proxy: { connected: intact && door_up, entry_intact: intact, door_up, upstream, written: main ? red(main.door ?? (typeof main.value === 'string' ? main.value : null)) : null, prior: red(priorRaw) },
        entry: main ? { where: main.keys ? `${main.path}#${main.keys.join('.')}` : main.path, kind: route.kind || main.kind, asight: true, intact } : null,
        plan: blocked ? { reason: blocked.reason, at: blocked.at ?? null, code: blocked.code } : null,
        hook: HOOKS.has(carrier) && !certificate.in_effect && ['entry-changed', 'entry-missing'].includes(certificate.code) ? certificate.code : null,
        setting: main ? settingOf(priorRaw, main) : null,
        notes: plan.notes.filter((n) => !n.form || n.form === f.id).map((n) => ({ code: n.code, text: n.text, ...(n.paths ? { paths: n.paths } : {}) })),
      })
    }
    out[h] = forms
  }
  return out
}

/** The proxy-mode half of NetFacts (1.6 §9.7) from modelFormFacts: each harness's `forms` and the doors as `forwarder.forms` (a door is the engine's: D47).
 *  The port is the daemon's, else the one the entry holds (a door that is down is still drawn where the agent points). `status` = gatherStatus's facts
 *  (desired, holders, the daemon's reply); `procs` = the platform's processes per harness; `systemProxy` = NetFacts' OS proxy; `settings` = what a new
 *  process reads now (the off path of a form asight wrote nothing for, e.g. after `off`). */
export function netFormsOf({ model, status, procs = {}, systemProxy = null, settings = {} }) {
  const reply = status.daemon && status.daemon.reply, doors = (reply && reply.doors) || {}
  const forms = {}, fw = {}
  for (const [h, list] of Object.entries(model)) {
    const row = (status.harnesses || []).find((x) => x.id === h) || {}
    const clients = (status.holders || []).filter((x) => x.harness === h).map((x) => x.pid)
    forms[h] = list.map((x) => ({ id: x.id, setting: x.setting || settings[h] || { value: null, scheme: null, host: null, port: null, source: [], sha256: null }, systemProxy, procs: procs[h] || [],
      entry: x.entry, route: x.plan, hook: x.hook, certificate: x.certificate, proxy: x.proxy, notes: x.notes }))
    for (const x of list) {
      const written = x.proxy.written ? parseProxyUrl(x.proxy.written) : null
      const port = doors[`${h}:${x.route}`] ?? (written ? written.port : null)
      if (port != null) fw[x.id] = { h, port, state: row.desired === 'on' ? 'on' : 'forward-only', upstream: x.proxy.upstream.url_redacted ?? 'DIRECT', source: x.proxy.upstream.source, clients, ...(reply && !x.proxy.door_up ? { down: true } : {}) } // the daemon answered without this door: nobody listens where the entry points (row 12)
    }
  }
  return { forms, forwarder: { pid: reply ? reply.pid ?? null : null, up: !!reply, forms: fw } }
}
