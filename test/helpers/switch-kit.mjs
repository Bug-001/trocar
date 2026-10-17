// test/helpers/switch-kit.mjs — the switch contract's generator, driver and invariants (RFC 4.11 CM15, CM25, CM26, CM27, CM32; D48, D54),
// over any list of descriptors: switch-contract.test.mjs runs it over every loaded harness, eighth.test.mjs over the data-only eighth harness (CM27).
// The rules of the generation are in switch-contract.test.mjs's head. Exports only.
import path from 'node:path'
import fs from 'node:fs'
import tls from 'node:tls'
import { contractWorld, daemonFor, placesOf, snapshot } from './contract-world.mjs'
import { seeds, userEdits, readDotenv, readJsonc, PROXY_NAMES } from './file-shapes.mjs'
import { resolveLoc } from '../../src/collector/core/proxymode/sources.mjs'

export const OSES = ['darwin', 'win32']
const BASE = { dotenv: ["# the user's own", 'OPENAI_API_KEY=sk-x', 'FOO_TIMEOUT=30'], json: ['{', '  "model": "m-1",', '  "env": {', '    "FOO_TIMEOUT": "30"', '  }', '}'] }
const SHAPES = {
  absent: () => null,
  lf: (f) => Buffer.from(BASE[f].join('\n') + '\n'),
  crlf: (f) => Buffer.from(BASE[f].join('\r\n') + '\r\n'),
  bom: (f) => Buffer.from('﻿' + BASE[f].join('\n') + '\n'),
  'no-final-eol': (f) => Buffer.from(BASE[f].join('\n')),
}
const EDITS = ['none', 'unrelated', 'proxy-key']
const USER_PROXY = 'http://user-own.example:3128'
const USER_PEM = `${tls.rootCertificates[3].trim()}\n`
const LOGIN_ENV = /^(\.zshrc|\.zshenv|\.zprofile|\.zlogin|\.bashrc|\.bash_profile|\.bash_login|\.profile|\.config[\\/]environment\.d([\\/].*)?)$/
const LOGIN_EXEC = /launchctl setenv|launchctl config|\breg(\.exe)? add .*Environment|\bsetx\b|SetEnvironmentVariable/i
const ADMIN_EXEC = /\bsudo\b|with administrator privileges|-Verb RunAs|\brunas\b|authorizationdb|security add-trusted-cert -d|certutil (-f )?-addstore (?!-user)/i
const TRUST_WRITE = /security (add-trusted-cert|delete-certificate|remove-trusted-cert)|certutil .*-(addstore|delstore)/
// 1.6 §1.1: a plain uninstall keeps the captures (capture-*.ndjson, flows/, audit/, replays/), control.json, and the retention settings with their log
const KEPT = /^\.asight([\\/](collector([\\/](control\.json|capture-[^\\/]*\.ndjson|(flows|audit|replays)([\\/].*)?))?|retention\.json|logs([\\/]retention\.ndjson)?))?$/
export const ASIGHT = /^\.asight([\\/]|$)/
const CERT_DIR = /^\.asight[\\/]collector[\\/]ca([\\/]|$)/
const LOG = /^\.asight[\\/]collector[\\/]flows([\\/]|$)/

const formatOf = (route) => (route.kind === 'dotenv-block' ? 'dotenv' : route.kind === 'json-key' && route.file ? 'json' : null)
const keyName = (k) => (Array.isArray(k) ? k.join('.') : k)

/** The changed paths between two snapshots: [{ p, why: 'added' | 'removed' | 'bytes' | 'mode' | 'mtime' }]. */
export function diff(a, b) {
  const out = []
  for (const p of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    const x = a.files[p], y = b.files[p]
    const why = !x ? 'added' : !y ? 'removed' : x.bytes !== y.bytes || x.link !== y.link || !!x.dir !== !!y.dir ? 'bytes' : x.mode !== y.mode ? 'mode' : x.mtime !== y.mtime ? 'mtime' : null
    if (why) out.push({ p, why })
  }
  return out
}
const under = (roots) => (p) => roots.some((r) => p === r || p.startsWith(r + path.sep) || r.startsWith(p + path.sep))
/** What the user sees of a route file: its keys (dotenv names, json key paths). */
function view(bytes, format) {
  if (!bytes) return {}
  try { return readOf(bytes, format) } catch { return { '(bytes no reader can read)': bytes.toString('base64') } } // undeterminable: any change is a change
}
function readOf(bytes, format) {
  if (format === 'dotenv') return readDotenv(bytes)
  const flat = (o, at = [], out = {}) => { if (o && typeof o === 'object' && !Array.isArray(o)) { for (const [k, v] of Object.entries(o)) flat(v, [...at, k], out) } else out[at.join('.')] = JSON.stringify(o); return out }
  return flat(readJsonc(bytes))
}

// ---- the invariants: each returns the violations it finds, [] when it holds -------------------------------------------------------------------------
export const invariants = {
  /** CM15: on touches only the harness's class-1 entries (the descriptor's route files, only their proxy keys) and asight's own switch / state files —
   *  never a certificate byte, never a trust store; `on h; off h` gives back the bytes of before `on h` (with no user edit). */
  cm15({ c, s1, s2, s4, edited }) {
    const bad = []
    const routes = c.routePaths
    for (const { p, why } of diff(s1, s2)) {
      if (CERT_DIR.test(p) || (!ASIGHT.test(p) && /BEGIN CERTIFICATE/.test(Buffer.from((s1.files[p] || {}).bytes || '', 'base64').toString('latin1')))) bad.push(`on changed certificate bytes: ${p} (${why})`)
      else if (!ASIGHT.test(p) && !under(routes)(p)) bad.push(`on wrote outside the class-1 entries: ${p} (${why})`)
    }
    if (c.file && c.format) {
      const before = view(fileOf(s1, c.file), c.format), after = view(fileOf(s2, c.file), c.format)
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k] && !c.ownKeys.has(k)) bad.push(`on changed ${k} in ${c.file}, not a proxy key of the route`)
    }
    if (s2.store.length !== s1.store.length || s2.exec.slice(s1.exec.length).some((x) => TRUST_WRITE.test(x))) bad.push('on touched a trust store')
    if (s4.store.length !== s1.store.length || s4.exec.slice(s1.exec.length).some((x) => TRUST_WRITE.test(x))) bad.push('off touched a trust store')
    for (const { p, why } of diff(s1, s4)) {
      if (CERT_DIR.test(p)) bad.push(`off changed certificate bytes: ${p} (${why})`)
      else if (!ASIGHT.test(p) && why !== 'mtime' && !(edited && under([c.file])(p))) bad.push(`on; off left ${p} other than before on (${why})`)
    }
    return bad
  },
  /** CM25: no file under HOME owned by anyone but the user, at any point; no admin step among the OS-tool calls. */
  cm25({ snaps }) {
    const me = process.getuid()
    return [...snaps.flatMap((s) => Object.entries(s.files).filter(([, f]) => f.uid !== me).map(([p, f]) => `${p} is owned by uid ${f.uid}`)), ...snaps.at(-1).exec.filter((x) => ADMIN_EXEC.test(x)).map((x) => `an admin step: ${x}`)]
  },
  /** CM26: no login-environment variable — no rc / profile / environment.d file changes, no launchctl setenv, no HKCU\Environment write. */
  cm26({ snaps }) {
    const bad = []
    for (let i = 1; i < snaps.length; i++) for (const { p, why } of diff(snaps[i - 1], snaps[i])) if (LOGIN_ENV.test(p)) bad.push(`${p} changed (${why})`)
    return [...bad, ...snaps.at(-1).exec.filter((x) => LOGIN_EXEC.test(x)).map((x) => `a login-environment write: ${x}`)]
  },
  /** CM32: after uninstall, HOME is the pre-install HOME byte for byte, but for the descriptor's `effects` paths and what 1.6 §1.1 keeps. */
  cm32({ c, s0, s6, edited }) {
    return diff(s0, s6).filter(({ p, why }) => why !== 'mtime' && !KEPT.test(p) && !under(c.effects)(p) && !(edited && under([c.file])(p))).map(({ p, why }) => `uninstall left ${p} (${why})`)
  },
  /** D54: a second on / off writes nothing — no byte anywhere but the event log, no mtime outside asight's directory. */
  d54({ a, b, verb }) {
    return diff(a, b).filter(({ p, why }) => !LOG.test(p) && (why !== 'mtime' || !ASIGHT.test(p))).map(({ p, why }) => `the second ${verb} wrote ${p} (${why})`)
  },
}
export const fileOf = (s, rel) => { const f = rel && s.files[rel]; return f && f.bytes != null ? Buffer.from(f.bytes, 'base64') : null }

// ---- the cases ------------------------------------------------------------------------------------------------------------------------------------
export function casesFor(os, harnesses) {
  const out = []
  let k = 0
  harnesses.forEach((h, hi) => {
    const neighbour = harnesses[(hi + 1) % harnesses.length]
    // forms with the same route and the same first `present` place are one world to the product: one case names them all
    const worlds = new Map()
    for (const f of h.proxyMode.forms.filter((x) => x.os.includes(os))) {
      const p0 = f.present[0], key = JSON.stringify([f.route, p0 && p0.perOs ? p0.perOs[os] : p0])
      worlds.set(key, [...(worlds.get(key) || []), f.id])
    }
    for (const forms of [...worlds.values(), null]) {
      const shapes = Object.keys(SHAPES)
      out.push({ os, h: h.name, form: forms && forms[0], forms, neighbour: neighbour.name, shape: forms ? shapes[k % shapes.length] : 'absent', edit: forms ? EDITS[Math.floor(k / shapes.length) % EDITS.length] : 'none', cert: forms ? k % 2 === 1 : false })
      if (forms) k++
    }
  })
  return out
}
// the measured shapes, once each, on the harnesses whose route file has their format
export const seedCasesFor = (harnesses) => seeds.flatMap((s, i) => harnesses.flatMap((h) => {
  const form = h.proxyMode.forms.find((f) => formatOf(h.proxyMode.routes[f.route]) === s.format)
  return form ? [{ os: OSES[i % 2], h: h.name, form: form.id, neighbour: null, shape: s.id, seed: s, edit: 'none', cert: false }] : []
}))

// One case at a time in a process. The commands are synchronous where they write (a durable write is fsync, F_FULLFSYNC on macOS: unbounded
// under disk load) and the daemon they ask is a server on this same event loop. Cases run side by side interleave, so one case's writes hold the loop
// while another's bounded request waits: uninstall's 2 s GET /holders timed out under load and uninstall refused (collectors-online). A command runs
// alone in its process in the product; and side by side bought no time, the writes being synchronous: the cases overlapped only in their waits.
let driving = null
export async function run(spec, harnesses) {
  if (driving) throw new Error(`switch-kit run(${label(spec)}) while ${driving} is still running in this process: one case's synchronous writes would hold back the other's daemon requests; run the cases with { concurrency: 1 }`)
  driving = label(spec)
  try { return await drive(spec, harnesses) } finally { driving = null }
}

async function drive(spec, harnesses) {
  const desc = harnesses.find((x) => x.name === spec.h)
  const certEnv = spec.cert ? Object.fromEntries((desc.proxyMode.userCertFiles || []).filter((u) => u.env).map((u) => [u.env, null])) : {}
  const w = await contractWorld({ os: spec.os, env: (home) => Object.fromEntries(Object.keys(certEnv).map((n) => [n, path.join(home, 'certs', 'mine.pem')])) })
  const own = w.install
  w.harnesses = harnesses // the world serves the descriptors under test, not only the loaded seven (CM27's eighth)
  w.install = (o) => own({ ...o, harnesses })
  const rel = (p) => path.relative(w.home, p)
  if (Object.keys(certEnv).length) { fs.mkdirSync(path.join(w.home, 'certs')); fs.writeFileSync(path.join(w.home, 'certs', 'mine.pem'), USER_PEM) }
  for (const f of ['.zshrc', '.profile']) fs.writeFileSync(path.join(w.home, f), "# the user's shell\n")
  const form = spec.form && desc.proxyMode.forms.find((f) => f.id === spec.form)
  if (form) w.place(placesOf(form, w.ctx)[0])
  if (spec.neighbour) { const nd = harnesses.find((x) => x.name === spec.neighbour), nf = nd.proxyMode.forms.find((f) => f.os.includes(spec.os) && placesOf(f, w.ctx).length); if (nf) w.place(placesOf(nf, w.ctx)[0]) }
  const route = form && desc.proxyMode.routes[form.route]
  const format = route && formatOf(route)
  const file = route && route.file ? resolveLoc(route.file, w.ctx)[0] : null
  const bytes = !format ? null : spec.seed ? spec.seed.bytes : SHAPES[spec.shape](format)
  if (file && bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
  const routePaths = Object.values(desc.proxyMode.routes).flatMap((r) => [r.file, r.select && r.select.dir, r.dir].filter(Boolean).flatMap((l) => resolveLoc(l, w.ctx))).map(rel)
  const ownKeys = new Set(route ? [...(route.proxyKeys || []), ...(route.noProxyKeys || []), ...(route.ownKeys || []), ...(route.arrayItems || []).map((a) => a.keys)].map(keyName) : [])
  const c = { home: w.home, file: file && rel(file), format, routePaths, ownKeys, effects: (desc.proxyMode.effects || []).flatMap((e) => e.paths.flatMap((l) => resolveLoc(l, w.ctx))).map(rel) }
  return (async () => {
    const bad = (phase) => spec.bad && spec.bad(phase, w, c)
    if (spec.world) spec.world(w) // the test's own furniture of the machine (a VPN / proxy product's data directories), before the first snapshot
    const s0 = snapshot(w)
    const ins = await w.cmd.install()
    bad('install')
    const s1 = snapshot(w)
    const d = await daemonFor(w)
    try {
      const on = await w.cmd.on([spec.h])
      bad('on')
      const s2 = snapshot(w)
      await w.cmd.on([spec.h])
      bad('on2')
      const s3 = snapshot(w)
      const edited = applyEdit(spec, file, format, route)
      const sE = snapshot(w)
      const off = await w.cmd.off([spec.h])
      bad('off')
      const s4 = snapshot(w)
      const off2 = await w.cmd.off([])
      bad('off2')
      const s5 = snapshot(w)
      const un = await w.cmd.uninstall()
      bad('uninstall')
      const s6 = snapshot(w)
      return { w, c, on, ins, off, off2, un, s0, s1, s2, s3, sE, s4, s5, s6, edited, file, format, route }
    } finally { await d.close() }
  })()
}

/** The user edits the route file while asight is on: an unrelated key added, or the proxy key itself set to the user's own value (D48②). */
function applyEdit(spec, file, format, route) {
  if (spec.edit === 'none' || !file || !format || !fs.existsSync(file)) return null
  const bytes = fs.readFileSync(file), proxy = keyName(route.proxyKeys[0])
  if (format === 'dotenv') {
    const op = userEdits('dotenv', { proxyName: proxy }).find((e) => e.id === (spec.edit === 'unrelated' ? 'add-unrelated' : 'set-proxy-in-place'))
    const next = op.apply(bytes, { before: bytes })
    if (!next) return null
    fs.writeFileSync(file, next)
    return spec.edit === 'unrelated' ? { key: 'ASIGHT_SHAPES_ADDED', value: 'added' } : { key: proxy, value: USER_PROXY }
  }
  const value = readJsonc(bytes) || {}
  const keys = spec.edit === 'unrelated' ? ['asightContractAdded'] : route.proxyKeys[0]
  let o = value
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}
  o[keys.at(-1)] = spec.edit === 'unrelated' ? 'added' : USER_PROXY
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n') // an editor saving the whole file again
  return { key: keys.join('.'), value: JSON.stringify(spec.edit === 'unrelated' ? 'added' : USER_PROXY) }
}

/** D48②: after off the user's edit is there, and everything else of the file is as before on. */
export function editKept(r) {
  if (!r.edited) return []
  const before = view(fileOf(r.s1, r.c.file), r.format), after = view(fileOf(r.s4, r.c.file), r.format)
  const want = { ...before, [r.edited.key]: r.edited.value }
  const bad = []
  for (const k of new Set([...Object.keys(want), ...Object.keys(after)])) if (want[k] !== after[k] && !(r.format === 'dotenv' && PROXY_NAMES.includes(k) && k !== r.edited.key && !(k in before))) bad.push(`${k}: wanted ${want[k]}, off left ${after[k]}`)
  return bad
}

export const label = (s) => `${s.os} · ${s.forms ? s.forms.join(' = ') : s.form || `${s.h} (no form present)`} · file ${s.shape} · edit ${s.edit}${s.cert ? ' · user cert file' : ''}`
