// signature.mjs (src/off) — match a running process against the process signatures of a harness, with the signatures as JSON (RFC 4.6
// §身份与信任, §安装清单与卸载「撤销顺序」第 2 / 5 步, 1.6 R3). A harness descriptor declares its signatures as DATA (patterns over the facts
// of a process: exe, argv, env, and the derived names / name0 / rest …); `install` copies the one for this OS into the manifest (`liveness.<harness>.identity`; `signature` in a manifest an older asight wrote), and `off` — which
// runs without any descriptor, and in the standalone `asight-off` without the repo — judges which live process belongs to which harness
// from that copy alone. So the matching function lives here, and src/collector/core/registry.mjs imports it: the daemon and `off` cannot
// disagree about what a pattern means.
//
// Pattern = { [factPath]: RegExp | RegExp[] | { [key]: string | RegExp } }; every entry must hold.
//   factPath is a dotted path into the facts ('exe', 'argv', 'argv.0', 'env', …).
//   RegExp   vs string  → test;      RegExp vs array → some element matches
//   RegExp[] vs array   → every RegExp matches some element
//   object   vs Map/obj → every key present and equal (string) or matching (RegExp), or absent (null); vs null (unreadable) → false
// Put cheap paths (exe, argv) before 'env' in a pattern: env may be a lazy read of the process.
// The derived facts `names` / `name0` / `rest` (src/off/identity.mjs, D51) are read through identityView, so a signature compiled from a name list
// (compileIdentity) and an older one over exe / argv match with the same code. Imports only src/off/identity.mjs.
import { processNames, name0, argRest, entryOf, compileIdentity } from './identity.mjs'

function factAt(facts, p) {
  let cur = facts
  for (const k of p.split('.')) {
    if (cur == null) return undefined
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k]
  }
  return cur
}

export function holds(want, got) {
  if (want instanceof RegExp) {
    if (typeof got === 'string') return want.test(got)
    return Array.isArray(got) && got.some((g) => typeof g === 'string' && want.test(g))
  }
  if (Array.isArray(want)) return Array.isArray(got) && want.every((re) => got.some((g) => typeof g === 'string' && re.test(g)))
  if (got == null) return false // an environment that cannot be read (darwin, win32) holds no key, not even an absent one
  const get = got instanceof Map ? (k) => got.get(k) : (k) => got[k]
  return Object.entries(want).every(([k, v]) => {
    const g = get(k)
    if (v === null) return g == null // null: the key is absent
    return g != null && (v instanceof RegExp ? v.test(g) : g === v)
  })
}

export function matchPattern(pattern, facts) {
  return Object.entries(pattern).every(([p, want]) => holds(want, factAt(facts, p)))
}

const anyPattern = (patterns, facts) => (patterns || []).some((p) => matchPattern(p, facts))

// RegExp ↔ { re, flags }, anywhere in the signature; nothing else changes. A plain object that has exactly the two string keys `re` and
// `flags` would be read back as a RegExp, which no declared signature has (an env pattern naming both variables `re` and `flags`).
const asRegExp = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && typeof v.re === 'string' && typeof v.flags === 'string'
const walk = (v, leaf) => {
  const out = leaf(v)
  if (out !== undefined) return out
  if (Array.isArray(v)) return v.map((x) => walk(x, leaf))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, leaf)]))
  return v
}

/** A signature (`{ match, exclude, longLived }` of patterns) as a JSON-able value: every RegExp becomes `{ re, flags }`. */
export const serializeSignature = (sig) => walk(sig, (v) => (v instanceof RegExp ? { re: v.source, flags: v.flags } : undefined))

/** The inverse of serializeSignature; takes the object or its JSON text. */
export const reviveSignature = (json) => walk(typeof json === 'string' ? JSON.parse(json) : json, (v) => (asRegExp(v) ? new RegExp(v.re, v.flags) : undefined))

// the facts as the patterns read them: `env` may be the lazy read of a process (a function), or a Map, or null when it cannot be read
function patternView(facts) {
  const d = Object.getOwnPropertyDescriptor(facts, 'env')
  if (!d || d.get || typeof d.value !== 'function') return facts // none, a Map / null, or the daemon's own lazy getter (reading `facts.env` here would force it)
  const view = Object.create(facts)
  let env
  Object.defineProperty(view, 'env', { get() { if (env === undefined) { try { env = facts.env() } catch { env = null } } return env } })
  return view
}

/** The facts as a pattern reads them, plus the derived identity facts as lazy getters: `names` (processNames), `name0`, `rest` (argRest), `entry` (entryOf). None of
 *  them reads `env`, so a lazy env stays unread until a pattern asks for it. */
export function identityView(facts) {
  const view = Object.create(patternView(facts))
  const lazy = (key, of) => {
    let v, done = false
    Object.defineProperty(view, key, { get() { if (!done) { v = of(facts); done = true } return v } })
  }
  lazy('names', processNames)
  lazy('name0', name0)
  lazy('rest', argRest)
  lazy('entry', entryOf)
  return view
}

const revived = new WeakMap() // reviving builds RegExps; a table of hundreds of processes asks about the same few signatures
const isObj = (v) => !!v && typeof v === 'object'
/** A liveness record's patterns, as JSON: `identity` (the compiled name list, D51), else the key an older asight wrote, `signature` (a Linux path signature,
 *  or the macOS / Windows form tables folded, PR #65) — a manifest from before the next `on` is judged by what it has, and `on` unites with it. The one
 *  place this rule is written (here, withAgentList, src/collector/install.mjs). */
export const patternsOf = (l) => (!isObj(l) ? null : isObj(l.identity) ? l.identity : isObj(l.signature) ? l.signature : null)

function signatureOf(l) {
  const sig = patternsOf(l)
  if (!sig) return null
  if (!revived.has(sig)) revived.set(sig, reviveSignature(sig))
  return revived.get(sig)
}

/** Does this liveness record (`liveness.<harness>`) carry patterns (`identity`, or the older `signature`)? A record with neither tells no process
 *  apart, so `off` reads it as "not known", never as "no process of it" (4.6 「判活快照」, D50②). */
export const hasIdentity = (l) => { const sig = signatureOf(l); return sig !== null && Array.isArray(sig.match) && sig.match.length > 0 } // an empty `match` tells no process apart either

/** The manifest's `liveness` with the user's agents.json of NOW (readAgentList's result) added to each record that has patterns: a name put on the
 *  list after `on` is a process of that harness too, so it may hold what asight wrote (4.6 「判活快照」). Only additions — an `ignore` item never
 *  takes a name away here (the safe direction: one more holder, never one less). A record with no patterns stays without (D50②: not known). The
 *  manifest's own object is not changed. → { liveness, note }: `note` says why the list was not added (a file that cannot be read or parsed). */
export function withAgentList(liveness, list) {
  const out = { ...(liveness || {}) }
  if (!list) return { liveness: out, note: null }
  const note = list.state === 'unreadable' || list.state === 'unparsable'
    ? `${list.path} could not be used (${(list.problems[0] || {}).detail || list.state}); the names put there are not counted when judging which processes still hold asight's files`
    : null
  for (const [h, l] of Object.entries(out)) {
    const base = patternsOf(l)
    const names = (list.entries || []).filter((e) => e.harness === h && !e.ignore).map((e) => (e.args == null ? { name: e.name } : { name: e.name, args: e.args }))
    if (!base || !names.length) continue
    let custom
    try { custom = serializeSignature(compileIdentity({ harness: h, names })) } catch { continue } // readAgentList let it through; compiling may still refuse: not added
    out[h] = { ...l, identity: { ...base, match: [...(base.match || []), ...custom.match] } }
  }
  return { liveness: out, note }
}

/** Every harness whose record in `liveness` claims this process (`match` holds, `exclude` does not), in the record order. For judging who may
 *  HOLD a file (`off` steps 2, 3, 5) a process two harnesses claim is a process of each — a name on two lists (agents.json added after `on`, or a
 *  name moved between harnesses and kept by the union) must add a holder, never take one away (D50: a bundle is not deleted under a running agent).
 *  A process two harnesses claim is never folded into one of them (0.1 §5); a harness whose record has no patterns (a manifest from before
 *  the snapshot) never claims anything — the caller asks hasIdentity first. */
export function harnessesOf(liveness, facts) {
  const view = identityView(facts)
  const hit = []
  for (const [id, l] of Object.entries(liveness || {})) {
    const sig = signatureOf(l)
    if (sig && anyPattern(sig.match, view) && !anyPattern(sig.exclude, view)) hit.push(id)
  }
  return hit
}

/** May a live process of a harness have read asight's entry for it (4.6 撤销顺序 第 2 / 5 步; 4.11 P12)? It started inside the window [since, until) — since =
 *  the harness's first install time (undo) or its on_at (holders), until = its off_at, open when null — or the harness re-reads its entry while running
 *  (`rereads`: alive at `until` is enough), or a time it needs is unknown (the safe direction: one more holder, never one less). The one copy undo.mjs
 *  (steps 2 / 3 / 5) and holders.mjs judge with. */
export const mayHaveRead = (p, l, since, until = null) => (l && l.rereads)
  ? (p.startedAt == null || until == null || p.startedAt < until)
  : (p.startedAt == null || since == null || (p.startedAt >= since && (until == null || p.startedAt < until)))
