// replay/analysis.mjs — pure helpers over the server-baked block list (`flat`) and per-call usage. No DOM, no wire names:
// everything here reads the one cross-provider block vocabulary (sec · kind · role · bytes · query · key) and the neutral
// usage shape {read, create, fresh, out}. `create` is null when a vendor reports no cache-write counter; `usage` itself is
// null when no usage came back at all — neither is ever turned into a zero here.
import { preview, fmtTime } from '../core/fmt.mjs'
import * as W from '../labels/replay.mjs'
import { QUIET_CAUSES as QUIET, refOf } from '../core/metrics.mjs' // for hasChangeLine below (the export above re-exports the same set)
// The cache and cost numbers moved to core/metrics.mjs (the one home of the cache predicate, plan P2.4–P2.5); the old names stay here
// so the replay modules keep importing them from where they always did.
export { hitRatio, hitPct, hitTier, QUIET_CAUSES, breakSteps, priceRow, priceMatch, costOf, sessionCost } from '../core/metrics.mjs'

// ── composition buckets (the stacked bars) ───────────────────────────────────────────────────────────────────────────
const COMP_KIND = { thinking: 'thinking', redacted_thinking: 'thinking', tool_use: 'tool_use', server_tool_use: 'tool_use', tool_result: 'tool_result', image: 'image' }
// Roles belong to the common block vocabulary. A role not in this table lands in `other`, so an unrecognised role is
// visible instead of being mis-coloured as something that was not observed (invariant 4).
const COMP_ROLE = { assistant: 'assistant', user: 'user', system: 'system', developer: 'system', tool: 'tool_result' }
export const CT_ORDER = ['tools', 'system', 'user', 'assistant', 'thinking', 'tool_use', 'tool_result', 'image', 'other']

export function compBucket(b) {
  if (b.sec === 'tools') return 'tools'
  if (b.sec === 'system') return 'system'
  return COMP_KIND[b.kind] || COMP_ROLE[b.role] || 'other'
}
// the skeleton row's `comp` wins (the server computes it while the blocks are in hand, so it exists for a step whose lane is
// not held); the local sum is for a call that carries its blocks. Null = not computable (hatched bar).
export function callComp(s) {
  if (s && s.comp) return s.comp
  if (!s || !s.flat || !s.flat.length) return null
  const c = Object.fromEntries(CT_ORDER.map((k) => [k, 0]))
  for (const b of s.flat) c[compBucket(b)] += flatBytes(b)
  return c
}
// bytes of one block: the server bakes `bytes` on every block (slim or inline); a block without it counts as unknown (0)
export const flatBytes = (b) => (b && typeof b.bytes === 'number' ? b.bytes : 0)

// a step's blocks, or null when there are none to compare against (its lane is not held: `stepOf(desk, rid).flat` is null)
export const blocksOf = (c) => (c && c.flat && c.flat.length ? c.flat : null)

// ── turns ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// a human query is the server's `query` on a message block (the human text with the harness's injections removed, absent
// when nothing human remains). Nothing is re-derived from a body here.
const humanOf = (b) => (b.sec === 'messages' && b.query ? b.query : '')

export function humanTurns(flat) {
  const out = []
  flat.forEach((b, i) => {
    if (b.sec !== 'messages' || b.role !== 'user' || b.kind !== 'text') return
    const h = humanOf(b)
    // `text` (the folded original) and `basis` (S1's queryBasis) ride along for the outline's 「第 N 步起」 pairing and
    // its 「推测」 mark; `label` stays the preview the rows print
    if (h) out.push({ label: preview(h), text: foldWs(h), basis: b.queryBasis || null, fi: i })
  })
  return out
}
// whitespace folded the way the server folds its event previews, so the two texts can be compared
export const foldWs = (t) => String(t || '').replace(/\s+/g, ' ').trim()
// a turn opens at a human query and runs to the next one, carrying the assistant's call turn and the tool results
export function messageTurns(flat) {
  const turns = []
  let cur = null
  flat.forEach((b, i) => {
    if (b.sec !== 'messages') return
    const human = humanOf(b)
    if (human || !cur) { cur = { label: human ? preview(human) : 'continued from the previous prompt', query: !!human, items: [] }; turns.push(cur) }
    cur.items.push(i)
  })
  for (const t of turns) {
    const k = t.items.map((i) => flat[i].kind)
    const tools = k.filter((x) => x === 'tool_use' || x === 'server_tool_use').length
    // the board's words (2.2 §提问卡): 调用 N 次工具 · 思考 · 工具结果 — the ones this turn has, in this order
    t.acts = [tools && `${tools} tool calls`, k.includes('thinking') && 'thinking', k.includes('tool_result') && 'tool result'].filter(Boolean).join(' · ')
  }
  return turns
}

// ── composition: who eats the re-sent window (2.2 §组成:段权重, D17②) ────────────────────────────────────────────────
// Bytes are the model-visible CONTENT bytes (Σ flat[].bytes, UTF-8, no JSON shell). The per-segment token is an ESTIMATE:
// Σ flat[].chars ÷ 4, a block without chars falls back to its bytes — the 组成 popover's calibre sentence says 按字符估,
// so the number behind it is exactly that. The render is a projection; nothing here enters the normalized schema (invariant 3).
export const TAX_ORDER = ['tools', 'system', 'history', 'task']
const charsOf = (b) => (b && typeof b.chars === 'number' ? b.chars : flatBytes(b))
export function segTax(flat) {
  const turns = messageTurns(flat)
  const taskItems = turns.length ? new Set(turns[turns.length - 1].items) : new Set() // the last turn is the current task
  const allVerbatim = flat.filter((b) => b.sec === 'tools').every((b) => b.faithfulness !== 'metadata') // an older capture kept no schema text
  const seg = { tools: 0, system: 0, history: 0, task: 0 }
  const chars = { tools: 0, system: 0, history: 0, task: 0 }
  flat.forEach((b, i) => {
    const n = flatBytes(b), c = charsOf(b)
    if (b.sec === 'tools') { seg.tools += n; chars.tools += c }
    else if (b.sec === 'system') { seg.system += n; chars.system += c }
    else if (taskItems.has(i)) { seg.task += n; chars.task += c }
    else { seg.history += n; chars.history += c }
  })
  const total = TAX_ORDER.reduce((a, k) => a + seg[k], 0) || 1
  const culprit = TAX_ORDER.reduce((a, k) => (seg[k] > seg[a] ? k : a), 'tools')
  return { seg, chars, total, culprit, allVerbatim, pct: (k) => Math.round((seg[k] / total) * 100), est: (k) => Math.round(chars[k] / 4) } // ≈tok = chars / 4
}

// ── cache reuse ──────────────────────────────────────────────────────────────────────────────────────────────────────
// hit ratio, the quiet-cause list and the break predicate live in core/metrics.mjs (re-exported above).
// The 缓存对比步 rule under its 2.3 name: the server names it (`cacheBreak.refRid`); a row without it gets the same walk —
// the nearest earlier call of the lane that did not fail.
export { refOf as cacheRefOf } from '../core/metrics.mjs'
// the 缓存对比步 of lane.calls[i]: the row the server named by rid when it is loaded, else the walk
export function refRowOf(lane, i) {
  const c = lane && lane.calls[i], rid = c && c.cacheBreak && c.cacheBreak.refRid
  const k = rid != null && lane.ridLocal ? lane.ridLocal.get(rid) : null
  return k != null ? lane.calls[k] : refOf(lane ? lane.calls : [], i)
}
// does THIS step's window draw the 变化线? ONE predicate for the step bar's 「跳到变化处」 and the window: the prefix
// actually changed (cause outside QUIET_CAUSES) and there is a block to stand before in the step's blocks (`flat`, null
// while its lane is not held).
export function hasChangeLine(call, flat = call && call.flat) {
  const b = call && call.cacheBreak
  return !!(b && !b.firstCall && b.cause && !QUIET.has(b.cause) && !call.unparsed
    && call.rec && Array.isArray(flat) && b.idx < flat.length)
}

// the flags of one *Incomplete object → its closed-set words, joined; an unknown flag set falls back to 「<请求/消息/回复>没采全」
const flagWords = (obj, TABLE) => Object.entries(TABLE).filter(([k]) => obj && obj[k]).map(([, v]) => v).join(' · ')
// ROUTING_LABELS: how the call reached trocar (2.3 §调用保真行): not a fidelity fact — the raw panel's tech details say it (2.6 §A)
export const ROUTING_LABELS = new Set(['capture-routing'])
// one call's fidelity facts (2.3 §调用保真行) → {facts: the row's words, tech: [code, text] pairs}; the row and the step head's ◐
// both read this (◐ iff facts is non-empty)
export function callFacts(call) {
  const w = (call && call.wire) || {}
  const facts = []
  const tech = []
  const add = (s) => s && facts.push(s)
  // contextState: the facts are {partial, reconstructed, server_edited}; 'complete' (the server's "nothing wrong")
  // and a missing value say nothing. A partial WITH contextMissing names the record and swallows wsIncomplete.partial
  // (one thing said once); a value outside the set falls back and goes to 技术细节
  if (w.contextState === 'partial') {
    if (w.contextMissing) add(`${W.CTX_FACT.partial}(${w.contextMissing})`)
    else if (!call.reqIncomplete && !(call.wsIncomplete && call.wsIncomplete.partial)) add(`${W.CTX_FACT.partialBare} · ${W.CTX_FACT.unknownWhy}`)
  } else if (w.contextState === 'reconstructed') add(W.CTX_FACT.reconstructed)
  else if (w.contextState === 'server_edited') add(W.CTX_FACT.server_edited)
  else if (w.contextState && w.contextState !== 'complete') { add(W.CTX_FACT.fallback); tech.push(['contextState', w.contextState]) }
  if (call.reqIncomplete) {
    const f = flagWords(call.reqIncomplete, W.REQ_FACT)
    add(`${W.INCOMPLETE_WORD.req}: ${f || 'incomplete'}`)
    if (call.reqIncomplete.text) tech.push(['reqIncomplete', call.reqIncomplete.text])
    if (!f) tech.push(['reqIncomplete', 'unknown flag'])
  }
  if (call.wsIncomplete) {
    const skipPartial = w.contextState === 'partial' && w.contextMissing
    const f = flagWords({ ...call.wsIncomplete, partial: skipPartial ? false : call.wsIncomplete.partial }, W.WS_FACT)
    if (f) add(`${W.INCOMPLETE_WORD.ws}:${f}`)
    else if (!skipPartial) add(`${W.INCOMPLETE_WORD.ws}: incomplete`)
    if (call.wsIncomplete.text) tech.push(['wsIncomplete', call.wsIncomplete.text])
    if (!f && !skipPartial) tech.push(['wsIncomplete', 'unknown flag'])
  }
  if (call.respIncomplete) {
    const f = flagWords(call.respIncomplete, W.RESP_FACT)
    add(`${W.INCOMPLETE_WORD.resp}: ${f || 'incomplete'}`)
    if (call.respIncomplete.text) tech.push(['respIncomplete', call.respIncomplete.text])
    if (!f) tech.push(['respIncomplete', 'unknown flag'])
  }
  // wire.labels: the server's own words, said unless the exact flag above already said the same thing
  const said = new Set([call.respIncomplete && call.respIncomplete.truncated && 'resp-truncated', call.respIncomplete && call.respIncomplete.undecoded && 'resp-undecoded', call.wsIncomplete && call.wsIncomplete.truncated && 'ws-truncated'].filter(Boolean))
  for (const l of (w.labels || [])) { if (!said.has(l.id) && !ROUTING_LABELS.has(l.id)) { add(String(l.label || l.id)); if (l.text) tech.push([l.id, l.text]) } }
  if (w.reqEncoding) add(W.reqEncodingFact(w.reqEncoding))
  return { facts, tech }
}

// the break to jump to from the playhead: the next one after it (dir > 0) or the previous one before it (dir < 0); null at the ends
export function breakTarget(breaks, playhead, dir) {
  if (dir > 0) { const n = breaks.find((b) => b > playhead); return n === undefined ? null : n }
  for (let i = breaks.length - 1; i >= 0; i--) if (breaks[i] < playhead) return breaks[i]
  return null
}

// key-set diff between a reference step and this one (no byte diff): ◆ added = in this step only, removed = in the
// reference only. Volatile blocks (per-request nonce) change every call by design and never count.
export function keyDiff(refFlat, curFlat) {
  const refKeys = new Set(refFlat.map((b) => b.key)), curKeys = new Set(curFlat.map((b) => b.key))
  const added = new Set(curFlat.filter((b) => !b.volatile && !refKeys.has(b.key)).map((b) => b.key))
  const removedBlocks = refFlat.filter((b) => !b.volatile && !curKeys.has(b.key))
  return { added, removed: new Set(removedBlocks.map((b) => b.key)), removedBlocks, refKeys, curKeys }
}

// a path shown relative to the session's working directory when it is inside it, else as is (no symlink resolution)
export function relPath(cwd, p) {
  const s = String(p)
  return cwd && s.startsWith(cwd + '/') ? s.slice(cwd.length + 1) : s
}

// a long path cut in the middle (2.4): the base name stays whole, middle segments give way to '…' from the inside out;
// a base name longer than max is returned with its own segment alone after '…/'
export function midClip(path, max) {
  const s = String(path)
  if (s.length <= max) return s
  const segs = s.split('/'), base = segs.pop()
  let head = 0, tail = segs.length // keep segs[0..head) in front and segs[tail..) before the base name
  const fit = (h, t) => [...segs.slice(0, h), '…', ...segs.slice(t), base].join('/').length <= max
  // grow from both ends while it still fits; the front first, so the root of the path reads as is
  for (let grew = true; grew;) {
    grew = false
    if (head < tail && fit(head + 1, tail)) { head++; grew = true }
    if (tail > head && fit(head, tail - 1)) { tail--; grew = true }
  }
  return [...segs.slice(0, head), '…', ...segs.slice(tail), base].join('/')
}

// a time shown inline: an unknown or invalid one is '—', never blank (no dangling " · " or " @ ")
export const when = (ts) => fmtTime(ts) || '—'
