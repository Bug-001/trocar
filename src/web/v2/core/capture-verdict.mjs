// core/capture-verdict.mjs — what one `status` document (1.6 C.3) says about the 采集服务 (D38), in ONE place: the state, its mark
// and tone, its sentence, the per-agent rows and a failure group's sentence. The 总览 capture card, the 采集 page and the session
// library's empty state read this and no other, so they cannot word the same state two ways.
// Pure: no DOM, no timers. The state is the server's `health` (1.5 §采集状态: baked by the server, never re-folded here); its
// absence is K-28 (not known), never a failure. Field presence decides everywhere, never a version.
// The marks ✓ ✗ ! ○ – ? are the board's own glyphs, not emoji; the words are labels/common.mjs HEALTH_WORDS.
import { fmtWhen, has } from './fmt.mjs'
import { harnessKey, harnessName, HARNESS_ORDER } from './chips.mjs'
import { TRUST_REASON, RESTART_CODES, UNKNOWN_REASON } from '../labels/capture.mjs'
import { HEALTH_WORDS, HEALTH_READ } from '../labels/common.mjs'
import { failureBrief } from '../../../cli/words.mjs'

export const CAPH_MS = 1500 // the poll period of the pages that show this card (1.5 s while visible)

// state → { mark, cls }. cls: ok | warn | bad | dim. `loading`, `stale`, `unreadable` and `unrecognized` are the board's read states.
const LOOK = Object.freeze({
  unreadable: { mark: '?', cls: 'warn' },
  'not-running': { mark: '✗', cls: 'bad' }, 'not-responding': { mark: '✗', cls: 'bad' },
  failing: { mark: '!', cls: 'bad' },
  unknown: { mark: '?', cls: 'warn' },
  off: { mark: '○', cls: 'dim' },
  ok: { mark: '✓', cls: 'ok' },
  residue: { mark: '–', cls: 'warn' },
  'not-installed': { mark: '–', cls: 'dim' },
  loading: { mark: '?', cls: 'dim' }, stale: { mark: '?', cls: 'warn' }, unrecognized: { mark: '?', cls: 'warn' },
})
const list = (x) => (Array.isArray(x) ? x : [])
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {})

// the failing sentence's counts (1.5): agents whose `captured` is not true (by harnessKey), agent-less current conditions
// (`critical[]` without `harness`), failure groups of level `problem`. Wording only: the verdict is still `health.state`.
function failingItems(doc) {
  const agents = new Set()
  for (const [id, v] of Object.entries(obj(doc.harnesses))) if (!v || v.captured !== true) agents.add(harnessKey(id))
  const others = list(doc.critical).filter((c) => c && c.harness == null).length
  const groups = list(doc.failures && doc.failures.groups).filter((g) => g && g.level === 'problem').length
  return [agents.size && HEALTH_READ.agents(agents.size), others && HEALTH_READ.others(others), groups && HEALTH_READ.groups(groups)].filter(Boolean)
}

// The 采集服务 state of one answer. `doc` is the last good answer (null before the first), `okAt` when it arrived (epoch ms), `err`
// the reason of the last failed read (or null), `now` the clock. Precedence: two polls missed → stale; a failure before any answer →
// stale with no time; no answer yet → loading; a 503 → unreadable; then `doc.health`; no `health` → not known (K-28).
// → { state, mark, cls, n, since, reason, raw, readErrors, text } — text is never empty.
export function captureVerdict(doc, { okAt = null, err = null, now = Date.now() } = {}) {
  const mk = (state, text, x = {}) => ({ state, ...LOOK[state], n: null, since: null, reason: null, raw: null, readErrors: 0, text, ...x })
  if (okAt != null && now - okAt > 2 * CAPH_MS) return mk('stale', HEALTH_READ.stale(fmtWhen(okAt, now)))
  if (err && okAt == null) return mk('stale', HEALTH_READ.stale('—'))
  if (!doc) return mk('loading', HEALTH_READ.loading)
  if (doc.unreadable) return mk('unreadable', HEALTH_READ.unreadable(doc.unreadable), { reason: String(doc.unreadable) })
  const h = doc.health && typeof doc.health === 'object' ? doc.health : null
  if (!h) return mk('unknown', HEALTH_WORDS.unknown({}))
  const W = (t) => fmtWhen(t, now)
  const known = typeof h.state === 'string' && has(HEALTH_WORDS, h.state)
  const state = known ? h.state : 'unrecognized'
  const tail = h.read_errors ? HEALTH_READ.partial : ''
  const text = (known ? HEALTH_WORDS[state](h, W, state === 'failing' ? failingItems(doc) : null) : HEALTH_READ.unrecognized(String(h.state ?? '—'))) + tail
  return mk(state, text, { n: h.n ?? null, since: h.since ?? null, reason: h.reason ?? null, raw: known ? null : h.state ?? null, readErrors: h.read_errors || 0 })
}

// → the store patch ({capH, capHOkAt, capHErr}) for one api.get('status') result: any 200 document is a good answer; a 503 (the
// server could not read the health: {unreadable}); anything else is a recorded failure, never a silent success.
export function capHealthPatch(r, now = Date.now()) {
  if (r && r.ok && r.data && typeof r.data === 'object') return { capH: r.data, capHOkAt: now, capHErr: null }
  if (r && !r.ok && r.status === 503 && r.error) return { capH: { unreadable: r.error }, capHOkAt: now, capHErr: null }
  return { capHErr: r && r.ok ? 'HTTP 200 · no document' : (r && (r.error || 'HTTP ' + r.status)) || 'reason unknown' }
}

// ── per-agent verdicts (1.9 §每个 agent 一行; the 总览 page's 「<agent>:<状态句>」 item reads the same rows) ─────────────────
// the tier of a row's verdict, worst first — rowOrder() sorts by it (1.9 §行的次序)
export const AGENT_TIER = Object.freeze({ forwarderDown: 0, problem: 1, unknown: 2, fine: 3, off: 4 })

// one agent's status sentence, by 1.9's precedence (first rule that holds wins):
//   1 the daemon is not running / not responding → waiting for the capture service
//   2 this harness's desired state is off → off
//   3 a current condition (`critical[]` with this harness): negative-cache → its sentence; a restart code → restart; a generic
//     trust code → TRUST_REASON; else the condition's own reason; several → the first, then 「· N more」
//   4 the verdict `harnesses[id].captured` (else a cached `topology[id]` not older than the switch's last change):
//     true → capturing only while the daemon runs AND responds; false → forwarder-down / restart / not capturing: <why>;
//     null → unknown; a cache older than the switch's last change → unknown (no recent state)
//   5 no verdict for this harness at all: the `overview` document (C.5, `ov`) has a harnesses[].last_ts for it → no problems
//     found; it has none → not captured in the last 24 h; `ov` not read → unknown (no recent state) — never a guess (D38②)
// → [{ harness, cliId, desired, tier, text, cls, wait, restart, code, fromCache, at, conditions, topology, findings,
//      lastCaptured, lastFailure }] in chip-table order; `cliId` is the spelling the document used.
export function agentVerdicts(doc, ov = null) {
  const d = obj(doc && doc.daemon)
  const daemonDown = d.running === false || d.responding === false
  const daemonUp = d.running === true && d.responding === true
  const hs = obj(doc && doc.harnesses), topo = obj(doc && doc.topology)
  const by = new Map()
  const row = (id) => {
    const k = harnessKey(id)
    if (!by.has(k)) by.set(k, {
      harness: k, cliId: null, desired: null, tier: AGENT_TIER.fine, text: '', cls: '', wait: false, restart: false,
      code: null, fromCache: false, at: null, conditions: [], topology: null, findings: null, verdict: null,
      lastCaptured: null, lastFailure: null,
    })
    return by.get(k)
  }
  for (const [id, v] of Object.entries(hs)) { const r = row(id); r.cliId = id; r.verdict = v || null; r.desired = v && ['on', 'off', 'mixed'].includes(v.desired) ? v.desired : null }
  for (const c of list(doc && doc.critical)) if (c && c.harness != null) row(c.harness).conditions.push(c)
  for (const g of list(doc && doc.failures && doc.failures.groups)) {
    if (!g || g.harness == null) continue
    const r = row(g.harness)
    if (g.last_ts && (!r.lastFailure || String(g.last_ts) > String(r.lastFailure))) r.lastFailure = g.last_ts
  }
  for (const c of list(doc && doc.changed)) if (c && c.harness != null) row(c.harness)
  for (const [id, t] of Object.entries(topo)) { const r = row(id); r.topology = t || null; r.findings = t && Array.isArray(t.findings) ? t.findings : null }
  const lastCap = new Map()
  for (const x of list(ov && ov.harnesses)) {
    if (!x || x.harness == null || !x.last_ts) continue
    const k = harnessKey(x.harness)
    if (!lastCap.has(k) || String(x.last_ts) > String(lastCap.get(k))) lastCap.set(k, x.last_ts)
  }
  for (const r of by.values()) r.lastCaptured = lastCap.get(r.harness) ?? null

  for (const r of by.values()) {
    const name = harnessName(r.harness)
    if (daemonDown) { Object.assign(r, { tier: AGENT_TIER.unknown, text: 'waiting for the capture service', cls: 'dim', wait: true }); continue }
    if (r.desired === 'off') { Object.assign(r, { tier: AGENT_TIER.off, text: 'off', cls: 'dim' }); continue }
    if (r.conditions.length) {
      const codeOf = (c) => c.code ?? c.kind ?? null
      const rank = (c) => (c.kind === 'negative-cache' ? 2 : RESTART_CODES.includes(codeOf(c)) ? 0 : 1)
      const mine = [...r.conditions].sort((a, b) => rank(a) - rank(b))
      const lead = mine[0], code = codeOf(lead)
      let text, restart = false
      if (lead.kind === 'negative-cache') text = `not capturing: one of its processes refused asight's certificate`
      else if (RESTART_CODES.includes(code)) { text = `restart ${name} to capture it`; restart = true }
      else if (code != null && has(TRUST_REASON, code)) text = `not capturing: ${TRUST_REASON[code].why}`
      else text = `not capturing: ${lead.text || lead.reason || UNKNOWN_REASON}`
      if (mine.length > 1) text += ` · ${mine.length - 1} more`
      Object.assign(r, { tier: AGENT_TIER.problem, text, cls: 'warn', code, restart })
      continue
    }
    // rule 4 — the document's own verdict for this harness, else a cached one no older than the switch's last change
    const v = r.verdict, t = r.topology
    const tAt = t && t.at ? Date.parse(t.at) : NaN
    const fresh = t && !isNaN(tAt) && !(v && v.updated_at && tAt < Date.parse(v.updated_at))
    const src = v && 'captured' in v ? v : fresh ? t : null
    if (!src && !t && ov && r.lastCaptured) { Object.assign(r, { tier: AGENT_TIER.fine, text: 'no problems found', cls: 'ok' }); continue }
    if (!src && !t && ov) { Object.assign(r, { tier: AGENT_TIER.unknown, text: 'not captured in the last 24 hours', cls: '' }); continue }
    if (!src) { Object.assign(r, { tier: AGENT_TIER.unknown, text: 'unknown (no recent state)', cls: '' }); continue }
    const fromCache = src === t, at = fromCache ? t.at : null
    const asOf = fromCache ? ` · as of ${fmtWhen(t.at)}` : ''
    const why = src.reason ?? null
    let text, tier = AGENT_TIER.problem, cls = 'warn', restart = false
    if (src.captured === true) { tier = daemonUp ? AGENT_TIER.fine : AGENT_TIER.unknown; text = `${daemonUp ? 'capturing' : 'unknown'}${asOf}`; cls = daemonUp ? 'ok' : '' }
    else if (src.captured === false && why === 'forwarder-down') { text = `may not reach the network${asOf}`; tier = AGENT_TIER.forwarderDown; cls = 'bad' }
    else if (src.captured === false && RESTART_CODES.includes(why)) { text = `restart ${name} to capture it${asOf}`; restart = true }
    else if (src.captured === false) text = `not capturing: ${why != null && has(TRUST_REASON, why) ? TRUST_REASON[why].why : (v && v.why) || UNKNOWN_REASON}${asOf}`
    else { text = `unknown${asOf}`; tier = AGENT_TIER.unknown; cls = '' }
    Object.assign(r, { tier, text, cls, restart, fromCache, at, code: why })
  }
  const rank = (id) => { const i = HARNESS_ORDER.indexOf(id); return i < 0 ? HARNESS_ORDER.length : i }
  return [...by.values()].sort((a, b) => rank(a.harness) - rank(b.harness) || (a.harness < b.harness ? -1 : 1))
}

// the words of one C.3 failure group ({level, where, code, count, first_ts, last_ts, harness?, reason}) — the overview's
// capture-failure item reads the same sentence. With `where` the sentence is the CLI's own (failureBrief, passed the group as it
// is), so the two faces never word one failure two ways; without `where` no word can be looked up → reason unknown, flagged, and
// the caller puts level / where / code in the technical details. → { text, code, cls, unknown } — never empty, never a guess.
export function failureSentence(g) {
  const code = (g && g.code) ?? null
  if (g && g.where != null) return { text: failureBrief(g), code, cls: 'warn', unknown: false }
  return { text: UNKNOWN_REASON, code, cls: 'warn', unknown: true }
}

// ── the poll of `status` (1.5 §采集状态 轮询 — the one place, so the 总览 / 采集 / 采集记录 pages cannot disagree) ──
// While the page is visible: one read every CAPH_MS, never two in flight; hidden: no reads, and one read the moment the
// page is visible again. Every answer — including a failure — goes through capHealthPatch into the store (a failure keeps
// the last good answer, so the page keeps showing it under its 截至 mark). onAnswer(s) runs after each store write, on the
// caller's clock. → { stop() }.
export function pollCaptureHealth({ api, store, doc = typeof document === 'undefined' ? null : document, onAnswer = null }) {
  let timer = 0, inFlight = false, stopped = false
  const schedule = () => { if (!stopped) { clearTimeout(timer); timer = setTimeout(tick, CAPH_MS) } }
  const tick = async () => {
    if (stopped || inFlight) return (stopped ? undefined : schedule())
    if (doc && doc.hidden) return schedule() // hidden: no read; visibilitychange fires the read on return
    inFlight = true
    let r
    try { r = await api.get('status') } catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
    inFlight = false
    if (stopped) return
    store.set(capHealthPatch(r, api.now()))
    if (onAnswer) { try { onAnswer(store.get()) } catch { /* a listener that throws must not stop the poll */ } }
    schedule()
  }
  const onVis = () => { if (!stopped && doc && !doc.hidden) { clearTimeout(timer); tick() } }
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis)
  tick() // the first read at once
  return {
    stop() {
      stopped = true; clearTimeout(timer)
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis)
    },
  }
}
