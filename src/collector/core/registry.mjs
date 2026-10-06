// registry.mjs — match a running process against harness descriptors (RFC 4.6 §身份与信任, D31②, D37).
// It knows no harness and no OS. Each descriptor in src/collector/harness/ carries its process
// signatures as DATA keyed by OS (`signatures.linux` today, `signatures.darwin` later); the OS-neutral
// facts object built by arch/<os>/procinfo says which key applies (`facts.os`). A process is judged on
// its own facts at exec time, never by its parent (§子进程与嵌套 agent). Unknown or ambiguous means no
// agent: an unrecognised process is never folded into a known identity (0.1 §5, D25).
//
// Pattern = { [factPath]: RegExp | RegExp[] | { [key]: string | RegExp } }; every entry must hold.
//   factPath is a dotted path into the facts ('exe', 'argv', 'argv.0', 'env', …).
//   RegExp   vs string  → test;      RegExp vs array → some element matches
//   RegExp[] vs array   → every RegExp matches some element
//   object   vs Map/obj → every key present and equal (string) or matching (RegExp)
// Put cheap paths (exe, argv) before 'env' in a pattern: env may be a lazy read of the process.

const RUNTIMES = new Set(['node', 'rust', 'python'])
const NAME_RE = /^[a-z][a-z0-9-]*$/

function factAt(facts, p) {
  let cur = facts
  for (const k of p.split('.')) {
    if (cur == null) return undefined
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k]
  }
  return cur
}

function holds(want, got) {
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

const anyOf = (patterns, facts) => (patterns || []).some((p) => matchPattern(p, facts))

function checkPattern(where, p) {
  if (!p || typeof p !== 'object' || Object.keys(p).length === 0) throw new Error(`${where}: every pattern needs at least one fact path`)
  for (const v of Object.values(p)) {
    for (const re of [v, ...(Array.isArray(v) ? v : []), ...(v && typeof v === 'object' && !(v instanceof RegExp) ? Object.values(v) : [])]) {
      if (re instanceof RegExp && (re.global || re.sticky)) throw new Error(`${where}: /g and /y RegExps are stateful; drop the flag`)
    }
  }
}

export function validateDescriptor(d) {
  const where = `harness descriptor ${JSON.stringify(d && d.name)}`
  if (!d || typeof d.name !== 'string' || !NAME_RE.test(d.name)) throw new Error(`${where}: name must be kebab-case`)
  if (!RUNTIMES.has(d.runtime)) throw new Error(`${where}: runtime must be one of ${[...RUNTIMES].join(', ')}`)
  const oses = d.signatures && typeof d.signatures === 'object' ? Object.keys(d.signatures) : []
  if (oses.length === 0) throw new Error(`${where}: signatures needs at least one OS key`)
  for (const os of oses) {
    const s = d.signatures[os]
    if (!s || !Array.isArray(s.match) || s.match.length === 0) throw new Error(`${where}: signatures.${os}.match must be a non-empty array`)
    for (const p of [...s.match, ...(s.exclude || []), ...(s.longLived || [])]) checkPattern(`${where} signatures.${os}`, p)
  }
  if (!Array.isArray(d.hosts)) throw new Error(`${where}: hosts must be an array`)
  if (!d.trust || !Array.isArray(d.trust.chain) || d.trust.chain.length === 0) throw new Error(`${where}: trust.chain must be a non-empty array`)
  return d
}

export function createRegistry(descriptors) {
  const byName = new Map()
  for (const d of descriptors) {
    validateDescriptor(d)
    if (byName.has(d.name)) throw new Error(`harness descriptor ${d.name} registered twice`)
    byName.set(d.name, d)
  }

  function match(facts) {
    const candidates = []
    let excluded = false
    for (const d of byName.values()) {
      const sig = d.signatures[facts.os]
      if (!sig || !anyOf(sig.match, facts)) continue
      if (anyOf(sig.exclude, facts)) { excluded = true; continue }
      candidates.push(d)
    }
    if (candidates.length === 1) return { agent: candidates[0].name, descriptor: candidates[0], reason: 'match' }
    if (candidates.length > 1) return { agent: null, descriptor: null, reason: 'ambiguous', candidates: candidates.map((d) => d.name) }
    return { agent: null, descriptor: null, reason: excluded ? 'excluded' : 'no-match' }
  }

  // Which descriptors COULD claim a process whose exe (and env) cannot be read, judged on what is readable (review B-1, 4.6
  // `exe-unreadable`): a match pattern counts when it has at least one constraint on a readable fact, every readable
  // constraint holds, and no exclude pattern holds on the readable facts; constraints on an unreadable fact are not tested. A
  // pattern made only of unreadable facts (a harness known by its exe alone) proves nothing, so it names no harness: the
  // process lands in the caller's "unjudged" count instead of being called a candidate. → [descriptor names]
  const UNREADABLE = new Set(['exe', 'env'])
  const readable = (pattern, facts) => {
    let known = 0
    for (const [p, want] of Object.entries(pattern)) {
      if (UNREADABLE.has(p.split('.')[0])) continue
      if (!holds(want, factAt(facts, p))) return false
      known++
    }
    return known > 0
  }
  function couldMatch(facts) {
    const out = []
    for (const d of byName.values()) {
      const sig = d.signatures[facts.os]
      if (!sig || !(sig.match || []).some((p) => readable(p, facts))) continue
      if ((sig.exclude || []).some((p) => readable(p, facts))) continue
      out.push(d.name)
    }
    return out
  }

  const isLongLived = (d, facts) => anyOf(d.signatures[facts.os] && d.signatures[facts.os].longLived, facts)

  return { match, couldMatch, isLongLived, get: (name) => byName.get(name) || null, names: () => [...byName.keys()] }
}
