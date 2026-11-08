// entries.mjs — the P5 route writers and the P6 NO_PROXY merge (spec 4.11 §4 P5 · P6, plan :110-133). Class 1 writes into the agent's own config
// (`json-key`, `dotenv-block`, `plugin-file`), class 2 is trocar's switch file (`switch-file`). A descriptor's route holds data only; this module
// knows no harness and no OS: paths come from sources.mjs's ctx (ctx.dirs), the OS's persistent env from ctx.persistentEnv.
//
// Writer ctx = sources.mjs's ctx + { dir (the collector dir: manifest, switch/), home (backups), manifest, fs, now, harness, route, routeId,
//   persistentEnv(names) → { name: value }, systemProxy (chain.mjs's input: null | {url, bypass} | {pac:true} | {ok:false}), render(templateId, values) → text,
//   newId() → a config-library entry id }.
// Every write goes through the install journal (core/trust/journal.mjs, phase 'on'): backup first, prior_value recorded, byte-faithful edits. Every undo
// goes through src/off/journal.mjs: key by key, block by block; a key the user changed during on stays (D48②), bytes are compared whole only when
// nothing changed. Records carry `route` (the route id: one entry group) and the door written (sealed at save: `door_sha256`, src/off/seal.mjs), so a moved door rewrites that route only.
import path from 'node:path'
import { randomUUID, createHmac } from 'node:crypto'
import { applyJsonKey, applyJsonKeys, applyTextEntry, writeOwnedFile, judgeOwned, saveManifest, undoEntry, removeOwnedFile, sha256 } from '../trust/journal.mjs'
import { parseJsonText, getPath, removeKey } from '../../../off/json-text.mjs'
import { decodeText } from '../../../off/text-codec.mjs'
import { doorPorts, isDoorValue, LOOPBACK_HOSTS } from '../../../off/door-value.mjs'
import { editTarget } from '../../../off/fsutil.mjs'
import { BLOCK_OPEN } from '../../../off/text-edit.mjs'
import { switchFileIn } from '../../../off/paths.mjs'
import { parseDotenv } from '../config-read.mjs'
import { resolveLoc, readSrc, holds, routedForms } from './sources.mjs'
import { entryGate } from '../entry-forms.mjs'
import { CODE } from '../codes.mjs'
import { loopbackWords, errnoWords } from '../../../cli/words.mjs'
import { unseal, doorFp } from '../../../off/seal.mjs'

const LOOPBACK = LOOPBACK_HOSTS
/** P10: where the daemon serves the PAC on the PAC group's door — a path carrying the install's key, derived from the doors' token (ingress.json
 *  `listenerToken`): the PAC is a capability that only this user, who can read the entry holding it, has. */
export const pacPath = (token) => `/${createHmac('sha256', String(token)).update('trocar.pac').digest('hex').slice(0, 32)}/trocar.pac`
/** The PAC address `on` writes for a door: the door's origin, the install's key in its path (P10). Also what its records are tagged with. */
export const pacAddress = (token, door) => new URL(pacPath(token), door).href
// a hostTree form's note (CM31): it names the form, since status prints it under the harness, beside forms that run on their own
const hostTreeNote = (form) => `${form} runs inside another program: every other extension there connects through trocar too, and trocar passes those connections on without capturing them`
// P6 · P9 · P10: a route that sends loopback direct — a class 1 entry with its NO_PROXY, a plugin hook rendered with the agent's NO_PROXY
// names (the route's own plugin file, or the switch file of forms whose carrier is a plugin), a PAC. The P8 wrapper sends loopback to the door.
const plugin = (desc, f) => ((desc.proxyMode.certs || {})[f.cert] || {}).kind === 'plugin'
// `p` is a planned route ({ route, forms: [form id] })
export const loopbackDirect = (desc, { route: r, forms }) => (r.noProxyKeys || []).length > 0 || r.value === 'pac-url'
  || (noProxyNames(desc).length > 0 && (r.kind === 'plugin-file' || (r.kind === 'switch-file' && desc.proxyMode.forms.filter((f) => forms.includes(f.id)).every((f) => plugin(desc, f)))))
// 1.6 §3.3: no harness of its own — the receipt says it once for the whole run
export const loopbackNote = () => ({ code: CODE.loopbackDirect, harness: null, hosts: [...LOOPBACK], text: loopbackWords(LOOPBACK) })
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
const base = (ctx) => ({ dir: ctx.dir, manifest: ctx.manifest, harness: ctx.harness, phase: 'on', home: ctx.home, door: ctx.door ?? null, route: ctx.routeId ?? null, defer: ctx.deferResult === true, now: ctx.now ? ctx.now() : new Date(), fs: ctx.fs }) // the door and the route ride in the record from its intent on: saveManifest seals the door, and a crashed intent names its route for the next on (recordsOf: a moved door rewrites that route only)
const noProxy = (ctx, values) => mergeNoProxy({ userValues: values, persistent: ctx.persistentEnv ? ctx.persistentEnv(['NO_PROXY']) : {} })

// P5: a value in the file that is one of trocar's doors (src/off/door-value.mjs, the judge off uses: loopback on a port ingress.json records) is no prior
// of the user's — a manifest lost left it there. The journal starts from the text without it (`base`), so the command's one write, one backup and
// pre_sha256 are of the file with the door out (4.6「日志」, V106: no door password in a backup): the key has no prior and off takes it out. A value a
// record of this manifest holds is trocar's own (on again, R9) and stays.
const doorJudge = (ctx) => { const p = doorPorts(ctx.dir, ctx.fs); return (v) => !!p.ports && typeof v === 'string' && isDoorValue(v, p.ports) }
const sameKeys = (a, b) => Array.isArray(a) && Array.isArray(b) && a.join('\0') === b.join('\0')
// text → the json text without the door values of `keys` that no record of this manifest holds
function jsonWithoutDoors(ctx, file, keys) {
  const isDoor = doorJudge(ctx), m = ctx.manifest.entries || []
  const real = editTarget(file, ctx.fs)
  const recorded = (k) => m.some((e) => (e.path === file || e.real_path === real || e.path === real) && sameKeys(e.keys, k))
  return (text) => {
    const doc = parse(text)
    if (!doc) return text
    return keys.filter((k, i) => keys.findIndex((x) => sameKeys(x, k)) === i && isDoor(getPath(doc, k)) && !recorded(k)).reduce((t, k) => (removeKey(t, k) || { text: t }).text, text)
  }
}
// text → the dotenv text without the user's lines of `names` whose value is a door; a file holding trocar's block is left to the journal (which refuses it or joins it)
function dotenvWithoutDoors(ctx, names) {
  const isDoor = doorJudge(ctx)
  return (text) => (text == null || text.includes(BLOCK_OPEN) ? text : text.split(/(?<=\n)/).filter((l) => !names.some((n) => isDoor(parseDotenv(l).get(n)))).join(''))
}

// ruling ③: a PAC route is not written over a system PAC, an applied entry with its own egress, or an own leg that needs credentials (the PAC door takes none)
// a key trocar still holds a record of (its stale value undone above left one only when the value is no longer what it wrote): the journal judges it, a
// user's change kept and refused with that reason — never taken for the user's own egress
const recordedKey = (ctx, file, k) => recordsOf(ctx.manifest, ctx.harness, ctx.routeId).some((e) => e.path === file && Array.isArray(e.keys) && e.keys.join('\0') === k.join('\0'))
function pacGate(ctx, doc, file, value) {
  const r = ctx.route
  if (ctx.systemProxy && ctx.systemProxy.pac) return notRouted('system-pac')
  for (const k of r.ownKeys || r.proxyKeys || []) { const v = getPath(doc, k); if (isSet(v) && v !== value && !recordedKey(ctx, file, k)) return notRouted('own-egress', where(file, k)) }
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
  if (r.value === 'pac-url' && !ctx.pacToken) throw Object.assign(new Error('the PAC address needs the install\'s key, and trocar on was given none'), { code: 'entry-refused' })
  const value = r.value === 'pac-url' ? pacAddress(ctx.pacToken, door) : door
  let file, create = null
  if (r.select) { const t = selectTarget(ctx); if (t.code) return t; file = t.file; create = t.create || null } else file = resolveLoc(r.file, ctx)[0]
  if (!file) return notRouted('no-path')
  // One file, one record (4.11 §4): an entry file trocar creates is carried by its own json-key record — `existed_before: false` and `created_dirs` say the
  // file and its directories are trocar's, and `off` deletes both once the keys are out. A second record of the same file (an owned-file holding the hash of
  // the empty object) disagreed with it the moment the keys went in, and status read a byte-intact entry as changed (mac 2026-10-19).
  const text = readText(ctx, file)
  if (!create && text === null && r.absent === 'not-routed') return notRouted('absent', file)
  const noDoors = jsonWithoutDoors(ctx, file, [...(r.proxyKeys || []), ...(r.ownKeys || [])])
  const doc = parse(text == null ? text : noDoors(text))
  if (r.value === 'pac-url' && doc) { const g = pacGate(ctx, doc, file, value); if (g) return g }
  const sets = (r.proxyKeys || []).map((keys) => ({ keys, value }))
  if (r.noProxyKeys) { const v = noProxy(ctx, r.noProxyKeys.map((k) => (doc ? getPath(doc, k) : undefined))); for (const keys of r.noProxyKeys) sets.push({ keys, value: v }) }
  out.push(...applyJsonKeys({ ...b, file, sets, base: noDoors, items: (r.arrayItems || []).map((a) => ({ keys: a.keys, item: a.value })) })) // one write, one backup (4.6「日志」)
  if (create) out.push(applyJsonKey({ ...b, file: create.meta, keys: [ctx.route.select.idKey], value: create.id }))
  return { ok: true, records: out }
}

function writeDotenv(ctx, door) {
  const r = ctx.route
  const file = resolveLoc(r.file, ctx)[0]
  if (!file) return notRouted('no-path')
  const text = readText(ctx, file)
  if (text === null && r.absent === 'not-routed') return notRouted('absent', file)
  const noDoors = dotenvWithoutDoors(ctx, r.proxyKeys || [])
  const env = parseDotenv((text && noDoors(text)) || '')
  const vars = Object.fromEntries((r.proxyKeys || []).map((k) => [k, door]))
  if (r.noProxyKeys) { const v = noProxy(ctx, r.noProxyKeys.map((k) => env.get(k))); for (const k of r.noProxyKeys) vars[k] = v }
  return { ok: true, records: [applyTextEntry({ ...base(ctx), file, base: noDoors, edit: { format: 'dotenv-block', vars, at: 'end' } })] }
}

function writeOwned(ctx, file, role, data) {
  const j = judgeOwned({ manifest: ctx.manifest, file, planned: sha256(Buffer.from(data)), fs: ctx.fs })
  if (j.action !== 'skip-intact') writeOwnedFile({ ...base(ctx), role, file, data, extra: { ...(ctx.door ? { door: ctx.door } : {}), ...(ctx.routeId ? { route: ctx.routeId } : {}) } })
  return { ok: true, records: [ctx.manifest.files.find((f) => f.path === file)] }
}

const KINDS = {
  'json-key': writeJson,
  'dotenv-block': writeDotenv,
  'plugin-file': (ctx, door) => {
    const dir = resolveLoc(ctx.route.dir, ctx)[0]
    if (!dir) return notRouted('no-path')
    return writeOwned(ctx, (ctx.join || path.join)(dir, ctx.route.name), 'plugin', ctx.render(ctx.route.template, { door, harness: ctx.harness }))
  },
  'switch-file': (ctx, door) => writeOwned(ctx, switchFileIn(ctx.dir, ctx.harness, ctx.join || path.join), 'switch', door),
}

/** The records of one route this harness's `on` wrote (phase 'on'), entries then owned files, in the order they were written. */
export function recordsOf(manifest, harness, routeId) {
  const mine = (x) => x && x.harness === harness && x.phase === 'on' && x.route === routeId
  return [...((manifest && manifest.entries) || []).filter(mine), ...((manifest && manifest.files) || []).filter(mine)]
}

/** The record of one route's `on` records whose prior is the user's own proxy (4.11 P7 step 2): the first string prior that is not of a NO_PROXY key (a
 *  bypass list, never an upstream), or null. */
export function priorRecordOf(route, records) {
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.join('\0') === b.join('\0')
  return records.find((i) => typeof i.prior_value === 'string' && !((route && route.noProxyKeys) || []).some((k) => same(k, i.keys))) ?? null
}

const KEEP = (res) => typeof res === 'string' && res.startsWith('left-') && res !== 'left-user-value' // the user's value now: nothing of trocar's left to undo

/** undo(ctx, records): entries last-first (each back to its prior only while it still holds trocar's value), then owned files (a config-library entry only
 *  while unchanged). Done records leave the manifest; one that could not be undone stays, with its reason. → { ok, results } */
function undo(ctx, records) {
  const fs = ctx.fs, m = ctx.manifest, results = []
  const ents = records.filter((x) => x.kind !== 'owned-file').reverse(), files = records.filter((x) => x.kind === 'owned-file').reverse()
  const drop = (list, x) => { const i = list.indexOf(x); if (i >= 0) list.splice(i, 1) }
  for (const e of ents) { const r = undoEntry(e, { fs }); results.push(r); if (!KEEP(r.result)) drop(m.entries, e) }
  for (const f of files) { // only while it is what trocar wrote (4.11 §4); a changed config-library entry is the user's, any other changed file stays listed
    const r = removeOwnedFile(f, fs, { unlessChanged: true })
    if (r.result === 'kept-changed' && f.role !== 'config-entry') results.push({ ...r, result: 'left-changed' })
    else { results.push(r); drop(m.files, f) }
  }
  saveManifest(ctx.dir, m, fs)
  return { ok: !results.some((r) => KEEP(r.result)), results }
}

/** check(ctx, records): does every record still hold trocar's value? → { ok, failing: [path] } */
function check(ctx, records) {
  const failing = []
  for (const r of records) {
    const t = readText(ctx, r.real_path || r.path)
    const x = unseal(r, t)
    let ok = false
    if (x.kind === 'owned-file') { try { ok = sha256(ctx.fs.readFileSync(x.path)) === x.sha256 } catch { ok = false } }
    else if (x.kind === 'text') { const env = parseDotenv(t || ''); ok = t != null && Object.entries(x.vars).every(([k, v]) => env.get(k) === v) }
    else { const v = getPath(parse(t), x.keys); ok = x.kind === 'json-array-item' ? Array.isArray(v) && v.some((e) => JSON.stringify(e) === JSON.stringify(x.item)) : v === x.value }
    if (!ok) failing.push(x.path)
  }
  return { ok: failing.length === 0, failing }
}

/** P5: a route not written this time (not-routed, any reason) keeps nothing an earlier `on` wrote there: its records are undone the way off does.
 *  Never throws: a record left in place (the file a link, unreadable, unwritable) is said → [{ code: 'entry-not-undone', reason, at }] (empty = all undone);
 *  the record stays in the manifest, so off tries again (invariant 4, D38). */
const dropRoute = (ctx, harness, routeId) => {
  const left = recordsOf(ctx.manifest, harness, routeId)
  if (!left.length) return []
  const notUndone = (why, at) => ({ code: CODE.entryNotUndone, reason: `the setting an earlier on wrote is still there (${why}); off tries again`, ...(at ? { at } : {}) })
  try {
    return undo(ctx, left).results.filter((r) => KEEP(r.result)).map((r) => notUndone(r.reason || r.result, r.real_path || r.path))
  } catch (e) { return [notUndone(String((e && e.message) || e), (e && e.path) || left[0].real_path || left[0].path)] }
}

/** routeEntry(kind) → { write(ctx, doorUrl), undo(ctx, records), check(ctx, records) }. write → { ok, records } | { code: 'not-routed', reason, at?, left? }
 *  (left: what an earlier on wrote on this route that could not be taken out, dropRoute's list);
 *  a record of this route that holds another door is undone first (a rebound port), then the route is written again. */
export function routeEntry(kind) {
  const w = KINDS[kind]
  if (!w) throw new TypeError(`no route writer for kind ${JSON.stringify(kind)}`)
  return {
    write(ctx, door) {
      // what this route's records say was written: the door, or for a PAC route the PAC address (its key in it). A record of another door or key, or
      // of an earlier version that wrote the address with no key, is trocar's stale value: undone (its prior back), then written anew (invariant 5)
      const mark = ctx.route && ctx.route.value === 'pac-url' && ctx.pacToken ? pacAddress(ctx.pacToken, door) : door
      const old = recordsOf(ctx.manifest, ctx.harness, ctx.routeId)
      if (old.some((x) => doorFp(x) !== sha256(mark)) && check(ctx, old).ok) undo(ctx, old) // not intact: a value of the user's, left for the journal to refuse and say
      // all or nothing: a route refused partway (its last key or item, the select meta) takes back what this call already wrote, so no record without
      // a route tag is left for off to miss (invariant 5)
      const m = ctx.manifest, had = new Set([...m.entries, ...m.files])
      const takeBack = () => { const added = [...m.entries, ...m.files].filter((x) => !had.has(x)); if (added.length) undo(ctx, added) }
      let res
      try { res = w({ ...ctx, door: mark }, door) } catch (e) { takeBack(); throw e }
      if (!res.ok) {
        takeBack()
        const left = res.code === 'not-routed' ? dropRoute(ctx, ctx.harness, ctx.routeId) : []
        return left.length ? { ...res, left } : res
      }
      // every record the journal wrote carries the route from its intent on; its last change is saved by the journal, or under defer by the next save
      // (flushResults at the end of on). What is left to save here is a record of an older run — one without the tag, or one holding its door in
      // clear, which the save seals (a save is two fsyncs, D62①)
      const saved = JSON.stringify(ctx.manifest)
      for (const x of res.records) if (x) x.route = ctx.routeId
      if (JSON.stringify(ctx.manifest) !== saved || recordsOf(ctx.manifest, ctx.harness, ctx.routeId).some((x) => typeof x.door === 'string')) saveManifest(ctx.dir, ctx.manifest, ctx.fs)
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
  for (const f of routedForms(pm, ctx.os, ctx)) {
    const hit = (pm.blockers || []).filter((b) => !b.forms || b.forms.includes(f.id)).map((b) => {
      const r = readSrc(b.at, ctx)
      if (r.error) return { reason: 'blocker-unreadable', at: r.where }
      return r.set && (!b.when || holds(b.when, ctx) === true) ? { reason: 'blocker', at: r.where } : null
    }).find(Boolean)
    if (hit) { blocked.push({ form: f.id, code: 'not-routed', ...hit }); continue }
    if (!routes.has(f.route)) routes.set(f.route, { id: f.route, route: pm.routes[f.route], forms: [] })
    routes.get(f.route).forms.push(f.id)
    if (f.hostTree) notes.push({ code: CODE.harnessNote, form: f.id, text: hostTreeNote(f.id) })
  }
  if (routes.size) for (const e of pm.effects || []) notes.push({ code: CODE.harnessNote, id: e.id, paths: e.paths.flatMap((p) => resolveLoc(p, ctx)), text: e.when })
  if (routes.size) for (const n of pm.notes || []) notes.push({ code: CODE.harnessNote, id: n.id, text: n.text }) // CM38: a launch that skips the hook
  return { routes: [...routes.values()], notRouted: blocked, notes }
}

/** `on` for one harness: plan, then write each planned route with its door (doorOf(routeId)). A write the journal refuses is that route's result, never a throw.
 *  → { results: [{ route, ok, code?, reason?, at? }], notRouted, notes } */
export function writeRoutes(desc, ctx, doorOf) {
  const plan = planRoutes(desc, ctx)
  const results = plan.routes.flatMap(({ id, route }) => {
    try {
      const r = routeEntry(route.kind).write({ ...ctx, harness: desc.name, route, routeId: id }, doorOf(id))
      if (r.ok) return [{ route: id, ok: true }]
      const { left = [], ...res } = r
      return [{ route: id, ok: false, ...res }, ...left.map((l) => ({ route: id, ok: false, ...l }))]
    } catch (e) {
      return [{ route: id, ok: false, code: (e && e.code) || 'entry-refused', reason: e && e.syscall ? errnoWords(e, 'write') : String((e && e.message) || e), ...(e && e.path ? { at: e.path } : {}) }]
    }
  })
  // a route of the harness no planned form uses (no form present, or every one blocked) is not-routed too: what an earlier on wrote there goes (P5)
  const planned = new Set(plan.routes.map((x) => x.id)), m = ctx.manifest
  const stale = [...new Set([...m.entries, ...m.files].filter((x) => x.harness === desc.name && x.phase === 'on' && typeof x.route === 'string' && !planned.has(x.route)).map((x) => x.route))]
  for (const id of stale) for (const l of dropRoute({ ...ctx, harness: desc.name }, desc.name, id)) results.push({ route: id, ok: false, ...l })
  // 1.6 §3.3: said when a loopback-direct route is in place after this on (written now, or already in place); not-routed or refused, not
  const inPlace = plan.routes.some((p, i) => results[i].ok && loopbackDirect(desc, p))
  return { results, notRouted: plan.notRouted, notes: inPlace ? [...plan.notes, loopbackNote()] : plan.notes }
}
