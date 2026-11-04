// apply.mjs (src/rules) — applyRules, the one entry of `rules test`, the live path and `resend` (RFC 5.1 §规则「多条规则都命中时」, §分派), and the tier 1
// replace. The daemon loads this file, so the rule process's half comes in as `full`, and a script as `script`: tier 1 touches neither.
import { Buffer, isUtf8 } from 'node:buffer'
import { isSecretHeader } from '../capture/redact.mjs'
import { scanJson } from '../dissect/json-scan.mjs'
import { LIMITS } from './closed.mjs'
import { FAST_LITERAL } from './conditions.mjs'
import { applySteps, editsCost, editsLimit, INVERTED_ON, recordEdits, recoverOf, spansToSteps } from './edits.mjs'
import { checkHeaderSet } from './headers.mjs'
import { actionKind } from './validate.mjs'

const MAX_HITS = 4096
const MAX_OUTPUT = 1024 * 1024
const MAX_GROWTH = 256 * 1024
const BACKSLASH = 0x5C
// `\uXXXX` is the longest escape: a hit up to five bytes after a backslash may be its tail.
const ESCAPE_REACH = 5
// The escapes JSON.stringify writes itself. A string spelled with these and no raw control character is what tier 2's re-escaping writes back.
const SHORT_ESCAPES = '"\\bfnrt'
const NOT_TIER_1 = new Set(['json', 'blocks', 'script'])

// Thrown inside tier 1 to leave it: nothing it did has reached anyone yet.
const ESCALATE = Symbol('escalate')
const fault = (why) => Object.assign(new Error(why), { why })

// What an action that changes no bytes leaves on the result, and how `rules test` says it. They run after the rule's edits stood.
const EFFECTS = {
  hold(action, out) {
    out.hold_ms ??= action.release_after_ms
    return `hold ${action.release_after_ms}`
  },
  drop(action, out) {
    out.drop = true
    return 'drop'
  },
  delay(action, out) {
    out.delay_ms = Math.min(out.delay_ms + action.delay_ms, LIMITS.delayMs)
    return `delay ${action.delay_ms}`
  },
  reply(action, out) {
    out.reply ??= action.reply
    return `reply ${action.reply.status}`
  },
  inject(action, out) {
    out.inject.push(action.inject)
    return 'inject'
  },
}

// pairs as checkHeaderSet reads them: a null value removes. False when a pair may not be written.
function setHeaders(state, pairs) {
  if (checkHeaderSet(pairs, { before: state.headers }).length) return false
  for (const [name, value] of pairs) {
    const same = ([n]) => n.toLowerCase() === name.toLowerCase()
    const at = state.headers.findIndex(same)
    if (value === null) state.headers = state.headers.filter((h) => !same(h))
    else state.headers = at < 0 ? [...state.headers, [name, value]] : state.headers.with(at, [state.headers[at][0], value])
  }
  return true
}

function isCanonical(text, from, to) {
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c === BACKSLASH && !SHORT_ESCAPES.includes(text[++i]))) return false
  }
  return true
}

// A leaf tier 1 can vouch for as JSON. A number only in its shortest spelling: 1.0 is valid and goes to tier 2 all the same, a wrong answer here would not.
function isPlainLiteral(token) {
  if (token === 'true' || token === 'false' || token === 'null') return true
  const n = Number(token)
  return Number.isFinite(n) && String(n) === token
}

// The string values of a scan, the ones tier 2 reads, into `out`. False when one of them may read differently there.
function collect(node, text, out) {
  if (node.kind === 'string') {
    out.push(node)
    return isCanonical(text, node.start + 1, node.end - 1)
  }
  if (node.kind === 'literal') return isPlainLiteral(text.slice(node.start, node.end))
  for (const child of node.items ?? node.props.values()) {
    if (!collect(child, text, out)) return false
  }
  return true
}

// → tier 2's steps for `hits` hits in a JSON text, one per string with its quotes; null when the text is no JSON; false when only tier 2 can tell.
function stringSteps(action, text, hits) {
  let root
  try { root = scanJson(text) } catch { return null }
  const strings = []
  if (!collect(root, text, strings)) return false
  const spans = []
  let found = 0
  for (const { start, end } of strings) {
    const parts = text.slice(start + 1, end - 1).split(action.replace)
    if (parts.length === 1) continue
    found += parts.length - 1
    spans.push({ start, end, ins: `"${parts.join(action.with)}"` })
  }
  return found === hits && spansToSteps(text, spans.sort((a, b) => a.start - b.start))
}

const isFastReplace = (action, unit) => action.literal === true && !action.blocks && !unit.encoding && unit.body !== null && action.replace.isWellFormed()
  && (action.in === 'body' || (!unit.sse && FAST_LITERAL.test(action.replace) && FAST_LITERAL.test(action.with)))

const fitsTier1 = (action, unit) => (actionKind(action) === 'replace' ? isFastReplace(action, unit) : !NOT_TIER_1.has(actionKind(action)))

// False sends the unit to tier 2. Past the checks here the bytes and the steps are the ones `full.act` makes. Every pass over the body is paid for first.
function tier1Replace(action, state, budget) {
  const { bytes } = state, { length } = bytes, inText = action.in !== 'body'
  if (!budget.spend(length) || !isUtf8(bytes)) return false
  if (action.with === action.replace) return true
  if (!budget.spend(length)) return false
  const needle = Buffer.from(action.replace), hits = []
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + needle.length)) {
    if (hits.length === MAX_HITS) return false
    hits.push(at)
  }
  if (inText && (!budget.spend(length) || bytes.includes('\\u'))) return false
  if (!hits.length) return true
  const each = Buffer.byteLength(action.with) - needle.length, grown = hits.length * each
  if (grown > MAX_GROWTH || length + grown > MAX_OUTPUT) return false
  let steps = null
  if (inText) {
    if (hits.some((at) => bytes.subarray(Math.max(0, at - ESCAPE_REACH), at).includes(BACKSLASH)) || !budget.spend(length)) return false
    steps = stringSteps(action, bytes.toString(), hits.length)
    if (steps === false) return false
  }
  steps ??= hits.map((at, i) => ({ at: at + i * each, del: needle.length, ins: action.with, old: action.replace }))
  if (!budget.spend(length + grown)) return false
  state.bytes = applySteps(bytes, steps)
  state.steps.push(...steps)
  return true
}

function newOutcome() {
  const spent = new Map()
  const out = {
    hits: [], skipped: [], changed: [], would: [], inject: [], delay_ms: 0, drop: false, reply: null, hold_ms: null, spent,
    tally: (name, since) => spent.set(name, (spent.get(name) ?? 0) + performance.now() - since),
    skip({ name, rule }, why) {
      out.skipped.push({ rule: name, why, ms: spent.get(name) ?? 0 })
      if (rule.on_error === 'drop') out.drop = true
    },
  }
  return out
}

// `edit` does one action that touches the bytes or the headers. A rule that fails leaves nothing behind: its edits go back, and its effects never run.
async function runRules(hits, state, out, edit, unreadable = null) {
  for (const compiled of hits) {
    const { rule, name } = compiled, since = performance.now(), before = { ...state }, mark = state.steps.length
    let why = null
    try {
      if (compiled.readsBody && unreadable) throw unreadable
      for (const action of rule.do) {
        if (EFFECTS[actionKind(action)]) continue
        const pending = edit(compiled, action, state)
        if (pending) await pending
      }
      for (const action of rule.do) {
        const effect = EFFECTS[actionKind(action)]
        if (effect) out.would.push({ rule: name, text: effect(action, out) })
      }
      if (state.bytes !== before.bytes || state.headers !== before.headers) out.changed.push(compiled)
    } catch (e) {
      if (e === ESCALATE) throw e
      Object.assign(state, before)
      state.steps.length = mark
      why = e.why ?? 'rule-error'
    }
    out.tally(name, since)
    if (why) out.skip(compiled, why)
  }
}

// `base` is what arrived, decoded. Edits run from the wire to the agent: going up the changed bytes are the wire's, coming down they are the agent's.
function recordOf(unit, state, { base, coded, spend }) {
  const up = INVERTED_ON.has(unit.on)
  const edits = state.opaque ? [] : recordEdits(unit.on, state.steps)
  const wire = up ? state.bytes : base, agent = up ? unit.body ?? base : state.bytes
  if (![wire.length, agent.length, agent.length].every(spend)) throw ESCALATE
  return { edits, recover: recoverOf({ wire, agent, edits, compressed: state.opaque || (up && coded) }) }
}

function settle(unit, state, out, { base, start, survivors, spend = () => true }) {
  const touched = state.steps.length > 0 || state.opaque, coded = Boolean(unit.body) && base !== unit.body
  const record = touched ? recordOf(unit, state, { base, coded, spend }) : { edits: [], recover: null }
  let bytes = touched ? state.bytes : null
  let headers = state.headers === start ? null : state.headers
  if (touched && coded) headers = state.headers.filter(([name]) => name.toLowerCase() !== 'content-encoding')
  const { recover } = record
  if (recover && (recover.edits ? editsCost(recover.edits) : recover.body_b64.length) > editsLimit(unit.body?.length ?? 0)) {
    for (const compiled of out.changed) out.skip(compiled, 'edits-full')
    bytes = headers = null
    Object.assign(record, { edits: [], recover: null })
  }
  const verdict = out.drop ? 'drop' : out.reply ? 'reply' : out.hold_ms !== null ? 'hold' : 'forward'
  return {
    escalate: false, survivors, hits: out.hits, bytes, headers, ...record, verdict,
    reply: verdict === 'reply' ? out.reply : null, delay_ms: out.delay_ms, hold_ms: verdict === 'hold' ? out.hold_ms : null, inject: out.inject,
    would: out.would, skipped: out.skipped, rule_ms: Object.fromEntries(out.spent),
  }
}

async function tier1(unit, compiled, budget) {
  const out = newOutcome(), survivors = []
  let waits = false
  for (const rule of compiled) {
    const since = performance.now(), verdict = rule.judge(unit, budget)
    out.tally(rule.name, since)
    if (verdict === 'miss') continue
    survivors.push(rule)
    if (verdict === 'tier2') waits = true
  }
  if (waits || budget.over || survivors.some(({ rule }) => !rule.do.every((action) => fitsTier1(action, unit)))) return { escalate: true, survivors }
  out.hits = survivors.map((rule) => rule.name)
  const start = unit.headers ?? []
  const state = { bytes: unit.body, headers: start, steps: [], opaque: false }
  const edit = (_, action) => {
    const done = actionKind(action) === 'replace' ? tier1Replace(action, state, budget) : setHeaders(state, [[action.header, action.remove ? null : action.set]])
    if (!done) throw ESCALATE
  }
  try {
    await runRules(survivors, state, out, edit)
    return settle(unit, state, out, { base: unit.body, start, survivors, spend: (n) => budget.spend(n) })
  } catch (e) {
    if (e === ESCALATE) return { escalate: true, survivors }
    throw e
  }
}

// `bytes` is the script's own copy: what it does to them in place must not reach the state or what the record restores. Not pooled, or a script could read the pool's neighbours.
function scriptMessage(unit, state) {
  const { on, harness, pid, method, host, path, status } = unit
  const bytes = Buffer.allocUnsafeSlow(state.bytes.length)
  state.bytes.copy(bytes)
  const headers = state.headers.map(([name, value]) => [name, isSecretHeader(name) ? '' : value])
  return { on, harness, pid, method, host, path, status, headers, bytes, ...(state.text === null ? {} : { text: state.text }) }
}

// A script's patch is the whole body, so it is one step. Edits are text: bytes that are not UTF-8 on either side leave the record to the whole body.
function setBody(state, next) {
  const bytes = Buffer.from(next), old = state.bytes
  if (bytes.equals(old)) return
  const text = isUtf8(bytes) ? bytes.toString() : null
  if (text === null || state.text === null) state.opaque = true
  else state.steps.push({ at: 0, del: old.length, ins: text, old: state.text })
  Object.assign(state, { bytes, text })
}

// A script answers with a new body (string or Buffer), or `{body, headers}` with headers as pairs. Nothing at all changes nothing.
function takeResult(result, state) {
  if (result === null || result === undefined) return
  const whole = typeof result === 'string' || Buffer.isBuffer(result)
  if (!whole && typeof result !== 'object') throw fault('bad-result')
  const { body, headers } = whole ? { body: result } : result
  if (headers !== undefined) {
    if (!Array.isArray(headers)) throw fault('bad-result')
    if (!setHeaders(state, headers)) throw fault('rule-error')
  }
  if (body === undefined) return
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) throw fault('bad-result')
  setBody(state, body)
}

async function tier2(unit, compiled, { full, script }) {
  const out = newOutcome()
  let decoded = null, unreadable = null
  if (compiled.some((rule) => rule.readsBody)) {
    try { decoded = full.decode(unit) } catch (e) { unreadable = e }
  }
  // A rule's head conditions run first in full.judge, so a body that cannot be decoded faults only the rules that get as far as reading it.
  const reading = decoded ?? { get text() { throw unreadable } }
  const hits = []
  for (const rule of compiled) {
    const since = performance.now()
    let why = null
    try {
      if (full.judge(rule.rule, unit, reading)) hits.push(rule)
    } catch (e) { why = e.why ?? 'rule-error' }
    out.tally(rule.name, since)
    if (why) out.skip(rule, why)
  }
  out.hits = hits.map((rule) => rule.name)
  const base = decoded?.bytes ?? unit.body ?? Buffer.alloc(0)
  const start = unit.headers ?? []
  const state = { bytes: base, text: decoded?.text ?? null, headers: start, steps: [], opaque: false }
  let scripts = 0
  const edit = ({ rule, name }, action) => {
    if (actionKind(action) !== 'script') return full.act(action, state, { on: rule.on, unit })
    if (++scripts > 1) throw fault('multi-script')
    if (!script) { out.would.push({ rule: name, text: 'script' }); return undefined }
    return (async () => takeResult(await script(rule, scriptMessage(unit, state)), state))()
  }
  await runRules(hits, state, out, edit, unreadable)
  return settle(unit, state, out, { base, start, survivors: compiled })
}

/** One unit through the rules `lookup` returned, in file order. tier 1 → `{escalate: true, survivors}` when the unit needs the rule process, nothing of it kept; else, and
 *  always on tier 2, `{escalate: false, survivors, hits, bytes, headers, edits, recover, verdict, reply, delay_ms, hold_ms, inject, would, skipped, rule_ms}`. `bytes` and
 *  `headers` are null when unchanged, `recover` is recoverOf's record of a changed body. Nothing here happens to the unit: verdict and the rest are the caller's to carry out. */
export async function applyRules(unit, compiled, { tier, budget, full, script }) {
  return tier === 1 ? tier1(unit, compiled, budget) : tier2(unit, compiled, { full, script })
}
