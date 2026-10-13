// registry.mjs — match a running process against harness descriptors (RFC 4.6 §身份与信任, D31②, D37; 4.8 §5.4 for osMatch).
// It knows no harness and no OS. Each descriptor in src/collector/harness/ carries its process
// signatures as DATA keyed by OS (`signatures.linux` today, `signatures.darwin` later); the OS-neutral
// facts object built by arch/<os>/procinfo says which key applies (`facts.os`). An OS whose facts are not
// the Linux /proc set (Windows: the image path and a command line that arrives late) does not copy its
// patterns into `signatures.<os>`: the daemon hands the matcher in `osMatch` (createRegistry's second
// argument), the same `matchForm` the redirector routes by. A process is judged on
// its own facts at exec time, never by its parent (§子进程与嵌套 agent). Unknown or ambiguous means no
// agent: an unrecognised process is never folded into a known identity (0.1 §5, D25).
//
// Pattern = { [factPath]: RegExp | RegExp[] | { [key]: string | RegExp } }; every entry must hold.
//   factPath is a dotted path into the facts ('exe', 'argv', 'argv.0', 'env', …).
//   RegExp   vs string  → test;      RegExp vs array → some element matches
//   RegExp[] vs array   → every RegExp matches some element
//   object   vs Map/obj → every key present and equal (string) or matching (RegExp)
// Put cheap paths (exe, argv) before 'env' in a pattern: env may be a lazy read of the process.
// The matching itself (factAt / holds / matchPattern) lives in src/off/signature.mjs: `asight off` judges which live process belongs to
// which harness with the same code, from the signatures `install` copied into the manifest (1.6 R3, 4.6 撤销顺序).
import { factAt, holds, matchPattern, serializeSignature } from '../../off/signature.mjs'
import { UNTIL_TEXT } from './codes.mjs'

export { matchPattern }

const RUNTIMES = new Set(['node', 'rust', 'python'])
const NAME_RE = /^[a-z][a-z0-9-]*$/

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
  const au = d.trust.afterUninstall
  if (au !== undefined && typeof au !== 'function' && !(typeof au === 'string' && Object.hasOwn(UNTIL_TEXT, au))) throw new Error(`${where}: trust.afterUninstall must be one of ${Object.keys(UNTIL_TEXT).join(', ')} (or a function of the process): ${JSON.stringify(au)}`)
  if (d.trust.untilEnviron !== undefined && (typeof d.trust.untilEnviron !== 'string' || d.trust.untilEnviron === '')) throw new Error(`${where}: trust.untilEnviron must be the name of an environment variable`)
  return d
}

/** What `off` needs to judge, from the install manifest alone, which live process may hold what asight wrote for this harness (4.6 撤销顺序
 *  第 2 / 5 步; manifest `liveness.<harness>`): the signature for `osName` as JSON — `osSignature(d)` when the arch has one (macOS and Windows fold
 *  their form tables, arch/<os>/forms.mjs formSignature: one source for which process is which harness), else `d.signatures[osName]`; null when
 *  there is neither, which `off` reads as "not known", never as "no process" (4.6 「判活快照」) —, whether the harness re-reads its entry while running, and until when a running one still trusts asight after `off` — the data form of
 *  `trust.afterUninstall` ('restart' when it declares none, and when it is a function of the process, which a manifest cannot hold: Hermes). With
 *  `trust.untilEnviron` (Kimi), only a process whose environment names that variable at a file of asight's is reported at all. */
export function livenessOf(d, osName, osSignature = null) {
  const t = d.trust || {}
  const sig = typeof osSignature === 'function' ? osSignature(d) : d.signatures && d.signatures[osName]
  return {
    signature: sig ? serializeSignature(sig) : null,
    rereads: !!t.rereadsEntry,
    until: typeof t.afterUninstall === 'string' ? t.afterUninstall : 'restart',
    ...(typeof t.untilEnviron === 'string' ? { until_environ: t.untilEnviron } : {}),
  }
}

export function createRegistry(descriptors, { osMatch = null } = {}) {
  const byName = new Map()
  for (const d of descriptors) {
    validateDescriptor(d)
    if (byName.has(d.name)) throw new Error(`harness descriptor ${d.name} registered twice`)
    byName.set(d.name, d)
  }

  // `osMatch[os]` (facts) → the harness name or null: how an OS whose process facts are not the Linux /proc set is
  // matched. The daemon hands the same function the redirector routes by (Windows: `matchForm` over the harness files'
  // form data, 4.8 §5.4 「谁产生判定」), so the tracker and the redirector share ONE rule for which form a process is —
  // no copy of the patterns as `signatures.win32`. The function names a registered harness or null (a form whose
  // command line is not known yet is null: the tracker re-judges on `facts-update`); a name that is no registered
  // harness throws rather than passing as "no agent" (the wiring is ours, a wrong name is a bug to hear about, D38).
  const matcherOf = (facts) => (osMatch && typeof osMatch[facts.os] === 'function' ? osMatch[facts.os] : null)

  function match(facts) {
    const byFn = matcherOf(facts)
    if (byFn) {
      const agent = byFn(facts)
      if (agent == null) return { agent: null, descriptor: null, reason: 'no-match' }
      const d = byName.get(agent)
      if (!d) throw new Error(`the ${facts.os} matcher named ${JSON.stringify(agent)}, which is no registered harness; nothing was judged`)
      return { agent, descriptor: d, reason: 'match' }
    }
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
