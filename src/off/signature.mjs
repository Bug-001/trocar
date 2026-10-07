// signature.mjs (src/off) — match a running process against the process signatures of a harness, with the signatures as JSON (RFC 4.6
// §身份与信任, §安装清单与卸载「撤销顺序」第 2 / 5 步, 1.6 R3). A harness descriptor declares its signatures as DATA (patterns over the facts
// of a process: exe, argv, env …); `install` copies the one for this OS into the manifest (`liveness.<harness>.signature`), and `off` — which
// runs without any descriptor, and in the standalone `asight-off` without the repo — judges which live process belongs to which harness
// from that copy alone. So the matching function lives here, and src/collector/core/registry.mjs imports it: the daemon and `off` cannot
// disagree about what a pattern means. Imports nothing.
//
// Pattern = { [factPath]: RegExp | RegExp[] | { [key]: string | RegExp } }; every entry must hold.
//   factPath is a dotted path into the facts ('exe', 'argv', 'argv.0', 'env', …).
//   RegExp   vs string  → test;      RegExp vs array → some element matches
//   RegExp[] vs array   → every RegExp matches some element
//   object   vs Map/obj → every key present and equal (string) or matching (RegExp)
// Put cheap paths (exe, argv) before 'env' in a pattern: env may be a lazy read of the process.

export function factAt(facts, p) {
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
  const get = got instanceof Map ? (k) => got.get(k) : (k) => (got || {})[k]
  return Object.entries(want).every(([k, v]) => {
    const g = get(k)
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

const revived = new WeakMap() // reviving builds RegExps; a table of hundreds of processes asks about the same few signatures
function signatureOf(l) {
  if (!l || !l.signature || typeof l.signature !== 'object') return null
  if (!revived.has(l.signature)) revived.set(l.signature, reviveSignature(l.signature))
  return revived.get(l.signature)
}

/** Which harness a process belongs to, from `liveness` (`{ <harness>: { signature, … } }`, the manifest's snapshot) alone: the one whose
 *  `match` holds and whose `exclude` does not; none, or two that both claim it, is null (a process is never folded into a known identity on a
 *  guess, 0.1 §5). A harness whose snapshot has no signature (another OS, a manifest from before the snapshot) never matches. */
export function matchHarness(liveness, facts) {
  const view = patternView(facts)
  const hit = []
  for (const [id, l] of Object.entries(liveness || {})) {
    const sig = signatureOf(l)
    if (sig && anyPattern(sig.match, view) && !anyPattern(sig.exclude, view)) hit.push(id)
  }
  return hit.length === 1 ? hit[0] : null
}
