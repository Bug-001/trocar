// core/capture-verdict.mjs — what one /api/capture-health answer says about the 采集服务 (D38), in ONE place: the state, its mark and
// tone, its sentence, and the per-harness facts the answer carries. The 总览 capture card, the 采集 page's 采集服务 row and the
// session library's empty state read this and no other, so they cannot word the same state two ways.
// Pure: no DOM, no timers. The state and N come from the server; this words them and says what a failed read means.
//
// The state is the answer's top-level `summary`: the server folds the collector and the old capture (旧采集) into it and the worse
// part wins. SEVERITY below is the board's copy of that order (1.5), so the page can cross-check it and can judge each part alone:
//   ?(unreadable) > ✗ > ! > ?(unknown) > ○ > ✓ > –
// Nothing here is ever empty: every state, including one this board has never seen, is a labelled non-empty sentence.
// The sentence of each state is 1.5's 关键状态矩阵 K-03 row (the words there win over any older copy, 1.9 §采集服务行); the marks
// ✓ ✗ ! ○ – ? are the board's own glyphs, not emoji. The subject 采集服务 is NOT part of the sentence: a caller that shows it
// somewhere unnamed (the overview card's label, the library's empty state) prefixes it itself.
import { fmtWhen, has } from './fmt.mjs'
import { harnessKey, harnessName, HARNESS_ORDER } from './chips.mjs'
import { TRUST_REASON, RESTART_CODES, NOT_CAPTURED, FAILURE_EVENT, CODE, RAW_OP, UNKNOWN_REASON } from '../labels/capture.mjs'

export const CAPH_MS = 1500 // the poll period of the pages that show this card (1.5 s while visible)

// state → { mark, cls, rank }. cls: ok | warn | bad | dim. rank: how bad (higher wins when two parts disagree).
// `loading`, `stale` and `unrecognized` are not answers of the server: the first read is pending, two polls were missed, or the state is new.
export const SEVERITY = Object.freeze({
  unreadable: { mark: '?', cls: 'warn', rank: 8 },
  'not-running': { mark: '✗', cls: 'bad', rank: 7 }, 'not-responding': { mark: '✗', cls: 'bad', rank: 7 },
  failing: { mark: '!', cls: 'bad', rank: 6 },
  unknown: { mark: '?', cls: 'warn', rank: 5 }, 'no-events': { mark: '?', cls: 'warn', rank: 5 },
  off: { mark: '○', cls: 'dim', rank: 4 },
  ok: { mark: '✓', cls: 'ok', rank: 3 },
  stopped: { mark: '○', cls: 'dim', rank: 2 }, residue: { mark: '–', cls: 'warn', rank: 2 },
  'not-installed': { mark: '–', cls: 'dim', rank: 1 },
  loading: { mark: '?', cls: 'dim', rank: 0 }, stale: { mark: '?', cls: 'warn', rank: 0 }, unrecognized: { mark: '?', cls: 'warn', rank: 0 },
})

// the sentence of each state (1.5 K-03). `W` words a timestamp (time of day when today, date and time otherwise).
const WORDS = {
  ok: (s, W, legacy) => (legacy ? `✓ 旧采集 · 在跑 · 最后启动于 ${W(s.since)}` : `✓ 在采 · 自 ${W(s.since)} 起`),
  failing: (s) => `! 采集有问题${s.n != null ? `:${s.n} 项` : ''}`,
  off: (s, W) => `○ 关着 · 自 ${W(s.since)} 起`,
  'not-running': (s, W, legacy) => `✗ ${legacy ? '旧采集没在跑' : '已停止'} · 最后记录于 ${W(s.since)}${s.signal ? ` · 因 ${s.signal}` : ''}`,
  stopped: (s, W) => `○ 旧采集已停 · 自 ${W(s.since)} 起`,
  'not-responding': (s, W) => `✗ 没响应 · 最后心跳 ${W(s.since)}`,
  unknown: (s, W, legacy) => `? ${legacy ? '旧采集 · ' : ''}不知道${s.reason ? `:${s.reason}` : ''}`,
  'no-events': () => '? 旧采集 · 没有事件记录(重启后才有)',
  residue: (s) => `– 未安装 · 留着${s.n != null ? ` ${s.n} 项` : ''}改动`,
  'not-installed': () => '– 未安装',
}

// the failing sentence with the counts 1.5 defines, off the whole answer: how many agents are not fully captured (the
// distinct agents of the current conditions, by harnessKey), how many agent-less conditions still hold, how many failure
// groups the last 24 h hold across all three parts. Only items above zero are said, joined by「;」. A summary-only view
// (a part judged alone, a hand-built answer) keeps summaryVerdict's generic n.
function failingText(h, base) {
  const c = (h && h.collector) || {}
  const agents = new Set(), others = []
  for (const k of Array.isArray(c.conditions) ? c.conditions : []) {
    if (!k || typeof k !== 'object') continue
    if (k.agent != null) agents.add(harnessKey(k.agent)); else others.push(k)
  }
  const nGroups = (x) => (Array.isArray(x) ? x.length : 0)
  const m = nGroups(c.failures) + nGroups(h && h.legacy && h.legacy.failures) + nGroups(h && h.raw && h.raw.failures)
  const items = []
  if (agents.size) items.push(`${agents.size} 个 agent 没有完整在采`)
  if (others.length) items.push(`另有 ${others.length} 项问题还在`)
  if (m) items.push(`24 小时内失败 ${m} 组`)
  return items.length ? `! 采集有问题:${items.join(';')}${base.readErrors ? ' · 读不全' : ''}` : base.text
}

// the verdict of one summary ({state, since, n, part, source, signal, reason, read_errors}) — the answer's top-level summary, or the
// summary of one part (h.collector.summary, h.legacy.summary). `part` names the part when the summary does not carry it.
export function summaryVerdict(summary, part = null) {
  const s = summary && typeof summary === 'object' ? summary : {}
  const p = s.part || part, legacy = p === 'legacy'
  const W = (t) => fmtWhen(t)
  const known = has(WORDS, s.state)
  const state = known ? s.state : 'unrecognized'
  const text = (known ? WORDS[s.state](s, W, legacy) : `? 不知道采集状态(${String(s.state || '状态未知')})`) + (s.read_errors ? ' · 读不全' : '')
  return { state, ...SEVERITY[state], part: p || null, n: s.n ?? null, since: s.since ?? null, reason: s.reason ?? null, readErrors: s.read_errors || 0, text }
}

// the worse of two verdicts (the higher rank); the first on a tie. A missing one never wins.
export const worse = (a, b) => (!a ? b : !b ? a : b.rank > a.rank ? b : a)

// The 采集服务 state of one answer. `h` is the last good answer (null before the first), `okAt` when it arrived (epoch ms), `err` the
// reason of the last failed read (or null), `now` the clock. Order of precedence: two polls missed → stale (whatever the answer said);
// a failure before any answer → stale with no time; no answer yet → loading; the server could not read the health (503) → unreadable;
// then the answer's own summary.
export function captureVerdict(h, { okAt = null, err = null, now = Date.now() } = {}) {
  const mk = (state, text) => ({ state, ...SEVERITY[state], part: null, n: null, since: null, reason: null, readErrors: 0, text })
  if (okAt != null && now - okAt > 2 * CAPH_MS) return mk('stale', `? 未刷新 · 截至 ${fmtWhen(okAt, now)}`)
  if (err && okAt == null) return mk('stale', '? 未刷新 · 截至 —')
  if (!h) return mk('loading', '? 读取中')
  if (h.unreadable) return { ...mk('unreadable', `? 读不到采集状态:${h.unreadable}`), reason: String(h.unreadable) }
  const v = summaryVerdict(h.summary)
  return v.state === 'failing' ? { ...v, text: failingText(h, v) } : v
}

// the two parts of an answer, each judged alone: the collector, and the old capture (null when the answer has no such part).
export function partVerdicts(h) {
  const of = (x, part) => (x && x.summary ? summaryVerdict(x.summary, part) : null)
  return { collector: of(h && h.collector, 'collector'), legacy: of(h && h.legacy, 'legacy') }
}

// → the store patch ({capH, capHOkAt, capHErr}) for one api.captureHealth() result: a good answer; a 503 (the server could not read
// the health: {unreadable}); anything else is a recorded failure, never a silent success. One place, so the polls and a screen that
// refreshes right after a change cannot disagree about what a 503 means.
export function capHealthPatch(r, now = Date.now()) {
  if (r && r.ok && r.data && r.data.summary) return { capH: r.data, capHOkAt: now, capHErr: null }
  if (r && !r.ok && r.status === 503 && r.error) return { capH: { unreadable: r.error }, capHOkAt: now, capHErr: null }
  return { capHErr: r && r.ok ? 'HTTP 200 · 没有 summary' : (r && (r.error || 'HTTP ' + r.status)) || '不知道原因' }
}

// ── per harness ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// What the answer carries about each agent, by read-side harness id (every id passes harnessKey): when it was last captured, when it last
// failed (and which failure group), the current conditions that name it, and — only when the answer carries them — the switch the operator
// set. A harness appears when any of those names it. Field presence decides, never a version: `desired` is null while the answer has no
// per-harness switch, and the page then states only what the whole collector's switch says.
//   → [{ harness, desired, lastCaptured, lastFailure, lastFailureKey, conditions:[{kind, pid, reason, text, since}] }] in chip-table order
export function agentFacts(h) {
  const c = (h && h.collector) || {}, by = new Map()
  const row = (id) => {
    const k = harnessKey(id)
    if (!by.has(k)) by.set(k, { harness: k, desired: null, lastCaptured: null, lastFailure: null, lastFailureKey: null, conditions: [] })
    return by.get(k)
  }
  for (const a of Array.isArray(c.agents) ? c.agents : []) {
    if (!a || a.agent == null) continue
    Object.assign(row(a.agent), { lastCaptured: a.last_captured ?? null, lastFailure: a.last_failure ?? null, lastFailureKey: a.last_failure_key ?? null })
  }
  for (const k of Array.isArray(c.conditions) ? c.conditions : []) {
    if (!k || k.agent == null) continue
    row(k.agent).conditions.push({ kind: k.kind || null, pid: k.pid ?? null, reason: k.code || k.reason || null, text: k.text ?? null, since: k.since ?? null })
  }
  const hs = c.switch && c.switch.harnesses
  if (hs && typeof hs === 'object') for (const [id, v] of Object.entries(hs)) row(id).desired = v && (v.desired === 'on' || v.desired === 'off') ? v.desired : null
  const rank = (id) => { const i = HARNESS_ORDER.indexOf(id); return i < 0 ? HARNESS_ORDER.length : i }
  return [...by.values()].sort((a, b) => rank(a.harness) - rank(b.harness) || (a.harness < b.harness ? -1 : 1))
}

// ── per-agent verdicts (1.9 §每个 agent 一行 — this section; the 总览 page's 「<agent>:<状态句>」 item reads the same rows) ──
// The contract era is judged by field presence, never a version: the answer is second-era when it has a top-level `netenv`
// key or `collector.switch.harnesses` (1.9 §前置定义 — switch alone is not enough, an absent collector has no switch).
export function commandEra(h) {
  const hs = h && h.collector && h.collector.switch && h.collector.switch.harnesses
  return (hs && typeof hs === 'object') || (h && h.netenv != null) ? 2 : 1
}

// the tier of a row's verdict, worst first — rowOrder() sorts by it (1.9 §行的次序)
export const AGENT_TIER = Object.freeze({ forwarderDown: 0, problem: 1, unknown: 2, fine: 3, off: 4 })

// one agent's status sentence, by 1.9's precedence (first rule that holds wins):
//   1 the daemon is not running / not responding → 等采集服务恢复 (the reason lives on the 采集服务 row, once)
//   2 the desired state is off (era 2: this harness's switch; era 1: the whole collector's) → 关着
//   3 a current condition names this agent: restart codes → 重启 <agent> 后生效 (no button, K-27); a generic trust code →
//     没在采:<TRUST_REASON why>; a harness-defined / unknown code → 没在采:<its own words: `text`, else the server's `reason`>;
//     negative-cache → 没在采:它的一个进程不认 asight 的证书; several → the first by this order, then 「· 另有 N 项」
//   4 era 2 only, a cached verdict (netenv.topology[h]) no older than the switch's last change: captured → 在采/不知道 · 截至 T
//     (在采 only while the daemon runs); forwarder-down → 可能连不上网 · 截至 T; restart reasons → 重启 <agent> 后生效 · 截至 T;
//     else → 没在采:<原因> · 截至 T; captured unknown → 不知道 · 截至 T; stale or missing → 不知道(没有最近的状态)
//   5 era 1: last_captured → 没有发现问题; else → 最近 24 小时没采到 (era 1 never says 在采: no per-agent evidence, D38②)
// → [{ harness, cliId, desired, tier, text, cls, wait, restart, code, fromCache, at, conditions, topology, findings,
//      lastCaptured, lastFailure, lastFailureKey }] in chip-table order; `cliId` is the era-2 spelling the answer itself
// used (the per-harness command is built from it; the front end keeps no CLI name table of its own).
export function agentVerdicts(h) {
  const c = (h && h.collector) || {}, era = commandEra(h)
  const daemonDown = c.daemon && (c.daemon.state === 'not-running' || c.daemon.state === 'not-responding')
  const hs = era === 2 && c.switch && c.switch.harnesses && typeof c.switch.harnesses === 'object' ? c.switch.harnesses : null
  const topo = era === 2 && h.netenv && h.netenv.topology && typeof h.netenv.topology === 'object' ? h.netenv.topology : null
  // every id any source names, folded by harnessKey (1.9 §行从哪来; S9 changes carry installed-but-quiet harnesses too)
  const by = new Map()
  const row = (id) => {
    const k = harnessKey(id)
    if (!by.has(k)) by.set(k, {
      harness: k, cliId: null, desired: null, tier: AGENT_TIER.fine, text: '', cls: '', wait: false, restart: false,
      code: null, fromCache: false, at: null, conditions: [], topology: null, findings: null,
      lastCaptured: null, lastFailure: null, lastFailureKey: null,
    })
    return by.get(k)
  }
  for (const a of Array.isArray(c.agents) ? c.agents : []) {    if (!a || a.agent == null) continue
    const r = row(a.agent)
    Object.assign(r, { lastCaptured: a.last_captured ?? null, lastFailure: a.last_failure ?? null, lastFailureKey: a.last_failure_key ?? null })
  }
  for (const g of Array.isArray(c.failures) ? c.failures : []) if (g && g.last && g.last.agent != null) row(g.last.agent)
  const ch = c.changes
  if (ch && typeof ch === 'object') {
    for (const e of Array.isArray(ch.entries) ? ch.entries : []) if (e && e.harness != null) row(e.harness)
    for (const f of Array.isArray(ch.files) ? ch.files : []) if (f && f.harness != null) row(f.harness)
  }
  for (const cond of Array.isArray(c.conditions) ? c.conditions : []) {
    if (!cond || cond.agent == null) continue
    row(cond.agent).conditions.push(cond)
  }
  if (hs) for (const [id, v] of Object.entries(hs)) { const r = row(id); r.cliId = id; r.desired = v && (v.desired === 'on' || v.desired === 'off') ? v.desired : null; r.desiredAt = v ? v.updated_at ?? null : null }
  if (topo) for (const [id, v] of Object.entries(topo)) { const r = row(id); r.topology = v || null; r.findings = (v && Array.isArray(v.findings)) ? v.findings : null; if (r.cliId == null && hs && has(hs, id)) r.cliId = id }

  for (const r of by.values()) {
    const name = harnessName(r.harness)
    if (daemonDown) { Object.assign(r, { tier: AGENT_TIER.unknown, text: '等采集服务恢复', cls: 'dim', wait: true }); continue }
    const off = era === 2 ? r.desired === 'off' : c.switch && c.switch.desired === 'off'
    if (off) { Object.assign(r, { tier: AGENT_TIER.off, text: '关着', cls: 'dim' }); continue }
    // rule 3 — the live conditions that name this agent, worst-order first
    const rank3 = (x) => {
      if (!x || x.kind !== 'untrusted') return x && x.kind === 'negative-cache' ? 3 : 4
      if (x.code != null && RESTART_CODES.includes(x.code)) return 0
      return 1
    }
    const mine = [...r.conditions].sort((a, b) => rank3(a) - rank3(b))
    if (mine.length) {
      const lead = mine[0], code = lead.code ?? null
      let text, restart = false
      if (lead.kind === 'negative-cache') text = `没在采:它的一个进程不认 asight 的证书`
      else if (code != null && RESTART_CODES.includes(code)) { text = `重启 ${name} 后生效`; restart = true }
      else if (code != null && has(TRUST_REASON, code)) text = `没在采:${TRUST_REASON[code].why}`
      else text = `没在采:${lead.text || lead.reason || UNKNOWN_REASON}`
      if (mine.length > 1) text += ` · 另有 ${mine.length - 1} 项`
      Object.assign(r, { tier: AGENT_TIER.problem, text, cls: 'warn', code, restart })
      continue
    }
    // rule 4 — era 2, a cached verdict no older than the switch's last change
    if (era === 2 && topo) {
      const t = r.topology
      const at = t && t.at ? Date.parse(t.at) : null
      const fresh = t && at != null && !isNaN(at) && !(r.desiredAt && at < Date.parse(r.desiredAt))
      if (t && fresh) {
        const W = fmtWhen(t.at)
        let text, tier = AGENT_TIER.problem, cls = 'warn', restart = false
        if (t.captured === true) { text = c.daemon && c.daemon.state === 'running' ? `在采 · 截至 ${W}` : `不知道 · 截至 ${W}`; tier = c.daemon && c.daemon.state === 'running' ? AGENT_TIER.fine : AGENT_TIER.unknown; cls = tier === AGENT_TIER.fine ? 'ok' : '' }
        else if (t.captured === false && t.reason === 'forwarder-down') { text = `可能连不上网 · 截至 ${W}`; tier = AGENT_TIER.forwarderDown; cls = 'bad' }
        else if (t.captured === false && t.reason != null && RESTART_CODES.includes(t.reason)) { text = `重启 ${name} 后生效 · 截至 ${W}`; restart = true }
        else if (t.captured === false) { const why = t.reason != null && has(TRUST_REASON, t.reason) ? TRUST_REASON[t.reason].why : UNKNOWN_REASON; text = `没在采:${why} · 截至 ${W}` }
        else { text = `不知道 · 截至 ${W}`; tier = AGENT_TIER.unknown; cls = '' }
        Object.assign(r, { tier, text, cls, restart, fromCache: true, at: t.at ?? null, code: t.reason ?? null })
        continue
      }
      Object.assign(r, { tier: AGENT_TIER.unknown, text: '不知道(没有最近的状态)', cls: '' })
      continue
    }
    // rule 5 — era 1: never 在采 (no per-agent evidence; D38② / invariant 4)
    Object.assign(r, { tier: AGENT_TIER.fine, text: r.lastCaptured ? '没有发现问题' : '最近 24 小时没采到', cls: r.lastCaptured ? 'ok' : '' })
  }
  const rank = (id) => { const i = HARNESS_ORDER.indexOf(id); return i < 0 ? HARNESS_ORDER.length : i }
  return [...by.values()].sort((a, b) => rank(a.harness) - rank(b.harness) || (a.harness < b.harness ? -1 : 1))
}

// the words of one failure group of the log (1.9 §采集记录 — the 总览 page's 「采集失败 · …」 item reads the same sentence).
// `g` = {key, count, first_ts, last_ts, last}. The key is where+code for a failure event, not_captured for a connection row,
// the event for the other failure events, agent-untrusted:<code>, or raw:<op>/<outcome>. A harness-defined or unknown code
// carries its own words (`last.text`, else the server's `last.reason` as-is); a Node errno is 「系统错误 <码>」.
// → { text, code, cls } — never empty, never a guess.
const ERRNO = /^(E[A-Z0-9_]+|ERR_[A-Z0-9_]+|Z_[A-Z_]+)$/
const untrustedText = (code, last, name) => {
  if (code != null && RESTART_CODES.includes(code)) return `重启 ${name} 后生效`
  if (code != null && has(TRUST_REASON, code)) return `没在采:${TRUST_REASON[code].why}`
  return `没在采:${(last && (last.text || last.reason)) || UNKNOWN_REASON}`
}
export function failureSentence(g) {
  const key = (g && g.key) || '', last = (g && g.last) || {}
  if (key.startsWith('flow:')) { const nc = key.slice(5); return { text: `漏采:${has(NOT_CAPTURED, nc) ? NOT_CAPTURED[nc] : UNKNOWN_REASON}`, code: nc, cls: 'warn' } }
  if (key.startsWith('agent-untrusted:')) {
    const code = key.slice('agent-untrusted:'.length) || null
    return { text: untrustedText(code, last, harnessName(last.agent)), code, cls: 'warn' }
  }
  if (key.startsWith('raw:')) {
    const rest = key.slice(4), i = rest.lastIndexOf('/')
    const op = i < 0 ? rest : rest.slice(0, i), outcome = i < 0 ? '' : rest.slice(i + 1)
    return { text: `${has(RAW_OP, op) ? RAW_OP[op] : op} · ${outcome || '结果未知'}`, code: key, cls: 'warn' }
  }
  const [ev] = key.split('/')
  // the other failure events key by their own event name (`helper-down`, possibly `/<where>`); a `failure` event keys
  // by `<where>/<code>` — its first segment is a WHERE, never the word 'failure' (groupKey), so the slash form below
  // is the failure branch. WHERE and the event names share no word, so the two forms cannot be confused.
  if (has(FAILURE_EVENT, ev)) return { text: FAILURE_EVENT[ev], code: ev, cls: 'warn' }
  if (key.includes('/')) {
    const code = last.code ?? null
    if (code != null && ERRNO.test(code)) return { text: `系统错误 ${code}`, code, cls: 'warn' }
    if (code != null && has(CODE, code)) return { text: CODE[code], code, cls: 'warn' }
    return { text: (last.text || last.reason) || UNKNOWN_REASON, code, cls: 'warn' }
  }
  return { text: UNKNOWN_REASON, code: key, cls: 'warn' }
}

// ── the poll of /api/capture-health (1.5 §采集状态 轮询 — the one place, so the 总览 / 采集 / 采集记录 pages cannot disagree) ──
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
    try { r = await api.captureHealth() } catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
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
