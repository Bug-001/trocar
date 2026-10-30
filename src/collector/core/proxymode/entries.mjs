// entries.mjs — the P5 route writers and the P6 NO_PROXY merge (spec 4.11 §4 P5 · P6, plan :110-133). Class 1 writes into the agent's own config
// (`json-key`, `dotenv-block`, `plugin-file`), class 2 is trocar's switch file (`switch-file`). A descriptor's route holds data only; this module
// knows no harness and no OS: paths come from sources.mjs's ctx (ctx.dirs), the OS's persistent env from ctx.persistentEnv.
//
// Writer ctx = sources.mjs's ctx + { dir (the collector dir: manifest, switch/), home (backups), manifest, fs, now, harness, route, routeId,
//   persistentEnv(names) → { name: value }, systemProxy (chain.mjs's input: null | {url, bypass} | {pac:true} | {ok:false}), render(templateId, values) → text,
//   newId() → a config-library entry id }.
// Every write goes through the install journal (core/trust/journal.mjs, phase 'on'): backup first, prior_value recorded, byte-faithful edits. Every undo
// goes through src/off/journal.mjs: key by key, block by block; a key the user changed during on stays (D48②), bytes are compared whole only when
// nothing changed. Records carry `route` (the route id: one entry group) and `door` (the URL written), so a moved door rewrites that route only.
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyJsonKey, applyJsonArrayItem, applyTextEntry, writeOwnedFile, judgeOwned, saveManifest, undoEntry, removeOwnedFile, sha256 } from '../trust/journal.mjs'
import { parseJsonText, getPath } from '../../../off/json-text.mjs'
import { decodeText } from '../../../off/text-codec.mjs'
import { parseDotenv } from '../config-read.mjs'
import { resolveLoc, readSrc, holds, isPresent } from './sources.mjs'
import { entryGate } from '../entry-forms.mjs'
import { CODE } from '../codes.mjs'

export const LOOPBACK = Object.freeze(['localhost', '127.0.0.1', '::1'])
export const PAC_PATH = '/trocar.pac' // P10: the daemon serves the PAC here on the PAC group's door
const HOST_TREE_NOTE = 'every extension in this host goes through the door, forward only'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/ // an entry id that names a file in the library and nothing outside it

/** P6: loopback ∪ the user's values at the entry place (both spellings) ∪ the persistent env's NO_PROXY; case-insensitive dedupe, first spelling kept, order kept. */
export function mergeNoProxy({ userValues = [], persistent = {} } = {}) {
  const seen = new Set(), out = []
  const more = Array.isArray(persistent) ? persistent : Object.values(persistent || {})
  for (const v of [LOOPBACK.join(','), ...userValues, ...more]) {
    for (const h of String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean)) if (!seen.has(h.toLowerCase())) { seen.add(h.toLowerCase()); out.push(h) }
  }
  return out.join(',')
}

/** P6 for a hook (P8 wrapper, P9 plugin): the bypass-list names it writes — NO_PROXY / no_proxy, in the spellings of the agent's own proxy names. */
export const noProxyNames = (desc) => [...new Set(((desc.proxy && desc.proxy.env) || []).map((n) => (n === n.toUpperCase() ? 'NO_PROXY' : 'no_proxy')))]

const notRouted = (reason, at) => ({ code: 'not-routed', reason, ...(at ? { at } : {}) })
const readText = (ctx, f) => { try { const d = decodeText(ctx.fs.readFileSync(f)); return d.ok ? d.text : undefined } catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e } }
const parse = (t) => { if (t === undefined) return undefined; try { return t === null ? {} : parseJsonText(t) ?? {} } catch { return undefined } } // undefined: undecodable or unparsable
const isSet = (v) => v !== undefined && v !== null && v !== ''
const where = (file, keys) => `${file}#${keys.join('.')}`
const base = (ctx) => ({ dir: ctx.dir, manifest: ctx.manifest, harness: ctx.harness, phase: 'on', home: ctx.home, now: ctx.now ? ctx.now() : new Date(), fs: ctx.fs })
const noProxy = (ctx, values) => mergeNoProxy({ userValues: values, persistent: ctx.persistentEnv ? ctx.persistentEnv(['NO_PROXY']) : {} })

// ruling ③: a PAC route is not written over a system PAC, an applied entry with its own egress, or an own leg that needs credentials (the PAC door takes none)
function pacGate(ctx, doc, file, value) {
  const r = ctx.route
  if (ctx.systemProxy && ctx.systemProxy.pac) return notRouted('system-pac')
  for (const k of r.ownKeys || r.proxyKeys || []) { const v = getPath(doc, k); if (isSet(v) && v !== value) return notRouted('own-egress', where(file, k)) }
  let cred = false
  try { const u = ctx.systemProxy && ctx.systemProxy.url ? new URL(ctx.systemProxy.url) : null; cred = !!(u && (u.username || u.password)) } catch { /* not a URL: no credentials in it */ }
  return entryGate({ auth: r.auth }, { upstreamCredentialed: cred }).ok ? null : notRouted('credentialed-own-leg')
}

// `select`: the entry the meta file names; none → a created entry (only when createIfNone), set applied
function selectTarget(ctx) {
  const s = ctx.route.select, join = ctx.join || path.join
  const dir = resolveLoc(s.dir, ctx)[0]
  if (!dir) return notRouted('no-path')
  const meta = join(dir, s.meta)
  const m = parse(readText(ctx, meta))
  if (m === undefined || typeof m !== 'object' || Array.isArray(m)) return notRouted('unreadable', meta)
  const id = m[s.idKey]
  if (isSet(id) && typeof id === 'string' && ID.test(id) && ctx.fs.existsSync(join(dir, `${id}.json`))) return { file: join(dir, `${id}.json`) }
  if (!s.createIfNone) return notRouted('no-applied-entry', meta)
  const nid = ctx.newId ? ctx.newId() : randomUUID()
  return { file: join(dir, `${nid}.json`), create: { meta, id: nid } }
}

function writeJson(ctx, door) {
  const r = ctx.route, b = base(ctx), out = []
  const value = r.value === 'pac-url' ? new URL(PAC_PATH, door).href : door
  let file, create = null
  if (r.select) { const t = selectTarget(ctx); if (t.code) return t; file = t.file; create = t.create || null } else file = resolveLoc(r.file, ctx)[0]
  if (!file) return notRouted('no-path')
  // One file, one record (4.11 §4): an entry file trocar creates is carried by its own json-key record — `existed_before: false` and `created_dirs` say the
  // file and its directories are trocar's, and `off` deletes both once the keys are out. A second record of the same file (an owned-file holding the hash of
  // the empty object) disagreed with it the moment the keys went in, and status read a byte-intact entry as changed (mac 2026-10-19).
  const text = readText(ctx, file)
  if (!create && text === null && r.absent === 'not-routed') return notRouted('absent', file)
  const doc = parse(text)
  if (r.value === 'pac-url' && doc) { const g = pacGate(ctx, doc, file, value); if (g) return g }
  for (const keys of r.proxyKeys || []) out.push(applyJsonKey({ ...b, file, keys, value }))
  if (r.noProxyKeys) { const v = noProxy(ctx, r.noProxyKeys.map((k) => (doc ? getPath(doc, k) : undefined))); for (const keys of r.noProxyKeys) out.push(applyJsonKey({ ...b, file, keys, value: v })) }
  for (const a of r.arrayItems || []) out.push(applyJsonArrayItem({ ...b, file, keys: a.keys, item: a.value }))
  if (create) out.push(applyJsonKey({ ...b, file: create.meta, keys: [ctx.route.select.idKey], value: create.id }))
  return { ok: true, records: out }
}

function writeDotenv(ctx, door) {
  const r = ctx.route
  const file = resolveLoc(r.file, ctx)[0]
  if (!file) return notRouted('no-path')
  const text = readText(ctx, file)
  if (text === null && r.absent === 'not-routed') return notRouted('absent', file)
  const env = parseDotenv(text || '')
  const vars = Object.fromEntries((r.proxyKeys || []).map((k) => [k, door]))
  if (r.noProxyKeys) { const v = noProxy(ctx, r.noProxyKeys.map((k) => env.get(k))); for (const k of r.noProxyKeys) vars[k] = v }
  return { ok: true, records: [applyTextEntry({ ...base(ctx), file, edit: { format: 'dotenv-block', vars, at: 'end' } })] }
}

function writeOwned(ctx, file, role, data) {
  const j = judgeOwned({ manifest: ctx.manifest, file, planned: sha256(Buffer.from(data)), fs: ctx.fs })
  if (j.action !== 'skip-intact') writeOwnedFile({ ...base(ctx), role, file, data, exclusive: j.action === 'write' })
  return { ok: true, records: [ctx.manifest.files.find((f) => f.path === file)] }
}

const KINDS = {
  'json-key': writeJson,
  'dotenv-block': writeDotenv,
  'plugin-file': (ctx, door) => {
    const dir = resolveLoc(ctx.route.dir, ctx)[0]
    if (!dir) return notRouted('no-path')
    return writeOwned(ctx, (ctx.join || path.join)(dir, ctx.route.name || 'trocar.js'), 'plugin', ctx.render(ctx.route.template, { door, harness: ctx.harness }))
  },
  'switch-file': (ctx, door) => writeOwned(ctx, (ctx.join || path.join)(ctx.dir, 'switch', ctx.harness), 'switch', door),
}

/** The records of one route this harness's `on` wrote (phase 'on'), entries then owned files, in the order they were written. */
export function recordsOf(manifest, harness, routeId) {
  const mine = (x) => x && x.harness === harness && x.phase === 'on' && x.route === routeId
  return [...((manifest && manifest.entries) || []).filter(mine), ...((manifest && manifest.files) || []).filter(mine)]
}

const KEEP = (res) => typeof res === 'string' && res.startsWith('left-') && res !== 'left-user-value' // the user's value now: nothing of trocar's left to undo

/** undo(ctx, records): entries last-first (each back to its prior only while it still holds trocar's value), then owned files (a config-library entry only
 *  while unchanged). Done records leave the manifest; one that could not be undone stays, with its reason. → { ok, results } */
function undo(ctx, records) {
  const fs = ctx.fs, m = ctx.manifest, results = []
  const ents = records.filter((x) => x.kind !== 'owned-file').reverse(), files = records.filter((x) => x.kind === 'owned-file').reverse()
  const drop = (list, x) => { const i = list.indexOf(x); if (i >= 0) list.splice(i, 1) }
  for (const e of ents) { const r = undoEntry(e, { fs }); results.push(r); if (!KEEP(r.result)) drop(m.entries, e) }
  for (const f of files) { results.push(removeOwnedFile(f, fs, { unlessChanged: f.role === 'config-entry' })); drop(m.files, f) }
  saveManifest(ctx.dir, m, fs)
  return { ok: !results.some((r) => KEEP(r.result)), results }
}

/** check(ctx, records): does every record still hold trocar's value? → { ok, failing: [path] } */
function check(ctx, records) {
  const failing = []
  for (const x of records) {
    const t = readText(ctx, x.real_path || x.path)
    let ok = false
    if (x.kind === 'owned-file') { try { ok = sha256(ctx.fs.readFileSync(x.path)) === x.sha256 } catch { ok = false } }
    else if (x.kind === 'text') { const env = parseDotenv(t || ''); ok = t != null && Object.entries(x.vars).every(([k, v]) => env.get(k) === v) }
    else { const v = getPath(parse(t), x.keys); ok = x.kind === 'json-array-item' ? Array.isArray(v) && v.some((e) => JSON.stringify(e) === JSON.stringify(x.item)) : v === x.value }
    if (!ok) failing.push(x.path)
  }
  return { ok: failing.length === 0, failing }
}

/** routeEntry(kind) → { write(ctx, doorUrl), undo(ctx, records), check(ctx, records) }. write → { ok, records } | { code: 'not-routed', reason, at? };
 *  a record of this route that holds another door is undone first (a rebound port), then the route is written again. */
export function routeEntry(kind) {
  const w = KINDS[kind]
  if (!w) throw new TypeError(`no route writer for kind ${JSON.stringify(kind)}`)
  return {
    write(ctx, door) {
      const old = recordsOf(ctx.manifest, ctx.harness, ctx.routeId)
      if (old.some((x) => x.door !== door)) undo(ctx, old)
      // all or nothing: a route refused partway (its last key or item, the select meta) takes back what this call already wrote, so no record without
      // a route tag is left for off to miss (invariant 5)
      const m = ctx.manifest, had = new Set([...m.entries, ...m.files])
      const takeBack = () => { const added = [...m.entries, ...m.files].filter((x) => !had.has(x)); if (added.length) undo(ctx, added) }
      let res
      try { res = w(ctx, door) } catch (e) { takeBack(); throw e }
      if (!res.ok) { takeBack(); return res }
      for (const x of res.records) if (x) Object.assign(x, { route: ctx.routeId, door })
      saveManifest(ctx.dir, ctx.manifest, ctx.fs)
      return { ok: true, records: recordsOf(ctx.manifest, ctx.harness, ctx.routeId) }
    },
    undo,
    check,
  }
}

/** Which routes `on` writes for a harness (spec 4.11 §3, CM31): only routes a present form uses; a form a blocker matches gets none. With a route
 *  to write, the descriptor's `effects` (CM32) and `notes` (CM38) come back as harness-notes.
 *  → { routes: [{ id, route, forms }], notRouted: [{ form, code, reason, at }], notes: [harness-note] } */
export function planRoutes(desc, ctx) {
  const pm = desc.proxyMode, routes = new Map(), blocked = [], notes = []
  for (const f of pm.forms.filter((x) => x.os.includes(ctx.os) && isPresent(x, ctx))) {
    const hit = (pm.blockers || []).filter((b) => !b.forms || b.forms.includes(f.id)).map((b) => {
      const r = readSrc(b.at, ctx)
      if (r.error) return { reason: 'blocker-unreadable', at: r.where }
      return r.set && (!b.when || holds(b.when, ctx) === true) ? { reason: 'blocker', at: r.where } : null
    }).find(Boolean)
    if (hit) { blocked.push({ form: f.id, code: 'not-routed', ...hit }); continue }
    if (!routes.has(f.route)) routes.set(f.route, { id: f.route, route: pm.routes[f.route], forms: [] })
    routes.get(f.route).forms.push(f.id)
    if (f.hostTree) notes.push({ code: CODE.harnessNote, form: f.id, text: HOST_TREE_NOTE })
  }
  if (routes.size) for (const e of pm.effects || []) notes.push({ code: CODE.harnessNote, id: e.id, paths: e.paths.flatMap((p) => resolveLoc(p, ctx)), text: e.when })
  if (routes.size) for (const n of pm.notes || []) notes.push({ code: CODE.harnessNote, id: n.id, text: n.text }) // CM38: a launch that skips the hook
  return { routes: [...routes.values()], notRouted: blocked, notes }
}

/** `on` for one harness: plan, then write each planned route with its door (doorOf(routeId)). A write the journal refuses is that route's result, never a throw.
 *  → { results: [{ route, ok, code?, reason?, at? }], notRouted, notes } */
export function writeRoutes(desc, ctx, doorOf) {
  const plan = planRoutes(desc, ctx)
  const results = plan.routes.map(({ id, route }) => {
    try { const r = routeEntry(route.kind).write({ ...ctx, harness: desc.name, route, routeId: id }, doorOf(id)); return { route: id, ...(r.ok ? { ok: true } : { ok: false, ...r }) } } catch (e) {
      return { route: id, ok: false, code: (e && e.code) || 'entry-refused', reason: String((e && e.message) || e), ...(e && e.path ? { at: e.path } : {}) }
    }
  })
  return { results, notRouted: plan.notRouted, notes: plan.notes }
}
