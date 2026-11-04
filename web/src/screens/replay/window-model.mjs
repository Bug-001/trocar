// web/src/screens/replay/window-model.mjs — the window's rules, framework-free (2.3 §读与画「长对话的窗口」 · 1.4 ①–⑨): the
// playhead step's context window as keyed items in drawing order, drawn by both desks (legacy ctxwin.mjs maps them to units).
// The proof rule (2.3 §保真标) and the reply rule (2.3 §这一步的回复) live here; blocks.mjs and rawpanel.mjs re-export them.
import { bodyCache, isAddressed, bodyVersion, deskMode } from '../../../legacy/replay/cell.mjs'
import { messageTurns, keyDiff, refPending, refRowOf, hasChangeLine, callFacts } from '../../../legacy/replay/analysis.mjs'
import { turnAnchorKey, turnIsOpen } from '../../../legacy/replay/fold.mjs'
import { stepOf } from '../../../legacy/replay/model.mjs'
import { stepRef } from '../../../legacy/replay/lanes.mjs'
import { contentRefOf, contentRefKOf } from '../../../legacy/replay/stepbar.mjs'

// ── the proof rule (2.3): what a block's fidelity IS, and what it may claim ──────────────────────────────────────────
const KNOWN_FF = new Set(['metadata', 'opaque', 'summarized', 'omitted', 'truncated'])
// → one of: verbatim (proven — no visible word) · a known 3.2 value · unknown · unaddressable
// a tools block by the same rule (2.3): an older capture's tool definitions say `metadata`
export function faithOf(b) {
  if (b.text_ref && (b.faithfulness == null || b.faithfulness === 'verbatim')) return 'verbatim'
  if (b.faithfulness === 'verbatim') return 'unaddressable' // claims verbatim but has nothing to resolve it from
  if (b.faithfulness != null && KNOWN_FF.has(b.faithfulness)) return b.faithfulness
  if (b.faithfulness != null && b.faithfulness !== '') return 'unknown'
  return 'unaddressable'
}
// what an OPENED body proved: `decoded` is exact decompressed text the 调用保真行 already named once — nothing to add;
// verbatim proves the row again; anything else upgrades the row's mark on the spot
export function openedFf(got) {
  if (!got) return null
  if (got.status !== 'ok') return 'notfetched'
  if (got.fidelity == null || got.fidelity === '') return 'unknown'
  if (got.fidelity === 'verbatim' || got.fidelity === 'decoded') return null
  if (got.fidelity === 'reserialized') return 'reserialized'
  return 'unknown'
}
// a block's faithfulness as it stands NOW: an opened body that came back unproven beats the metadata's claim
export function faithNow(b) {
  if (isAddressed(b) && b._open) {
    const f = openedFf(bodyCache.get(b.text_ref))
    if (f) return f
  }
  return faithOf(b)
}

// ── the reply rule: its parts · stop reason · ONE fidelity mark ───────────────────────────────────────────────────
// replyOf({row, reply, detail}) is the one rule (2.3 §这一步的回复 · 2.6 §A) over a step as the desk holds it: `reply` = the
// step's reply definitions (thinking · text · tool calls, each with its `ref`), `detail` = the lane step's detail. The mark:
// the bytes only partially stored → 'partial' (「◐ 回复没采全」); every part resolving to its own span of the reply
// (`…::resp.raw::a-b`, or `…::resp.messages.<j>::a-b` on WebSocket; RFC 3.1 回复块也回源) → null; anything else → 'parsed' (「◐ 解析后的回复」). 逐字 is never written without that span.
// partMark(d) marks ONE part as the window's rows do: the request rows' proof rule (faithOf) over the part's span — proven on it
// with no non-verbatim value, a known value is that value's mark, no span is 'parsed' (the partial fact is the call line's, 2.3)
const RESP_SPAN = /::resp\.(raw|messages\.\d+)::\d+-\d+$/
const onSpan = (d) => RESP_SPAN.test(String(d.ref || ''))
export function partMark(d) {
  const f = faithOf({ ...d, text_ref: onSpan(d) ? d.ref : null })
  return f === 'verbatim' ? null : f === 'unaddressable' ? 'parsed' : f
}
const PARTIAL_LABELS = new Set(['resp-truncated', 'resp-partial', 'resp-undecoded'])
export function replyOf({ row, reply, detail } = {}) {
  const c = row || {}, parts = reply || [], norm = (detail && detail.norm) || {}
  const partial = !!(c.respIncomplete || ((c.wire && c.wire.labels) || []).some((l) => PARTIAL_LABELS.has(l.id)))
  const mark = partial ? 'partial' : parts.every(onSpan) ? null : 'parsed'
  // an unparsed step is a REQUEST-body fact; where the response itself parsed, the reply still renders (2.6 §A)
  let failed = null
  if (!(c.unparsed && parts.length) && c.error) {
    failed = { reason: c.unparsed ? '' : (typeof c.error === 'string' ? c.error : (c.errMsg || (c.error && c.error.message) || (c.status != null ? `status ${c.status}` : ''))) }
  }
  return { failed, mark, stop: norm.stop_reason || null, parts }
}

// ── one request row's marks (2.3 §block 卡 · §保真标 · §窗口行) ──────────────────────────────────────────────────────────
/** @typedef {{ ff: string, badge: boolean, quiet: boolean, sr: boolean, tech: string, cc: any, volatile: boolean, isNew: boolean }} RowMarks */
/** What a request row says about itself. `open`: the row is open (an opened body that came back unproven outranks the
 * metadata's claim); `prevKeys`: the 内容对比步's content keys (null: no 「新」); `windowLine`: the window line is up.
 * @returns {RowMarks} */
export function rowMarks(b, { prevKeys = null, open = false, windowLine = false } = {}) {
  const ff = open ? faithNow({ ...b, _open: true }) : faithOf(b)
  // the window line already said "nothing here resolves": the per-block 不能回源 is not repeated, its screen-reader word is
  const quiet = ff === 'unaddressable' && !!windowLine
  return {
    ff, quiet, badge: !quiet && ff !== 'verbatim', sr: ff === 'verbatim' || quiet,
    tech: ff === 'unknown' ? String(b.faithfulness) : ff === 'unaddressable' ? (b.unaddressable || '') : '',
    cc: b.cc || null, volatile: !!b.volatile, isNew: !!(prevKeys && !b.volatile && !prevKeys.has(b.key)),
  }
}
// ② the reasons of the window line, or null when some block of the step can return to the raw bytes
function windowReasons(flat) {
  if (!flat || !flat.length || flat.some((b) => b.text_ref)) return null
  return [...new Set(flat.map((b) => b.unaddressable).filter(Boolean))]
}
// ⑧ the section frames of a step whose lane is not held (2.3 §车道未到手): one per section the row's composition names, sized
// from its bytes (a unit of --cblk-pitch per 2,000)
const FRAME_SECS = [['tools', ['tools']], ['system', ['system']], ['messages', null]]
function framesOf(row) {
  const comp = (row && row.comp) || {}, named = new Set(FRAME_SECS.flatMap(([, ks]) => ks || []))
  const size = (ks) => Object.entries(comp).filter(([k]) => (ks ? ks.includes(k) : !named.has(k))).reduce((a, [, v]) => a + (Number(v) || 0), 0)
  return FRAME_SECS.map(([sec, ks]) => [sec, size(ks)]).filter(([, n]) => n > 0)
    .map(([sec, n]) => ({ sec, fr: Math.max(1, Math.min(12, Math.ceil(n / 2000))) }))
}
// the request rows' keys: bid + '#' + its occurrence in the list (the same bid may stand twice)
export function rowKeys(flat) {
  const seen = new Map()
  return flat.map((b) => { const n = seen.get(b.bid) || 0; seen.set(b.bid, n + 1); return `${b.bid}#${n}` })
}
// the turns of a list, each run of consecutive message blocks grouped on its own (indices into the whole list), with `at[i]` =
// the turn holding list position i (-1 outside messages). Memoised per list: stepOf hands out one list per step per desk change.
const TURNS = new WeakMap()
export function turnsOf(flat) {
  let T = TURNS.get(flat)
  if (T) return T
  const list = [], at = new Int32Array(flat.length).fill(-1)
  for (let i = 0; i < flat.length;) {
    if (flat[i].sec !== 'messages') { i++; continue }
    let j = i
    while (j < flat.length && flat[j].sec === 'messages') j++
    for (const t of messageTurns(flat.slice(i, j))) { const items = t.items.map((k) => k + i); for (const k of items) at[k] = list.length; list.push({ ...t, items }) }
    i = j
  }
  TURNS.set(flat, T = { list, at })
  return T
}
export const turnOpen = (s, flat, T, ti) => turnIsOpen(s.turnFold, flat, T.list[ti], ti, T.list.length - 1, s.turnLanded)
const refNo = (s, row) => { const r = row && stepRef(s.lanes, row.rid); return r ? (r.step ? r.n : r.k) : null }
const callOf = (s) => (s.anchor && s.anchor.calls[s.playhead]) || null

// ── the items ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** @typedef {{ key: string, type: string, [k: string]: any }} Item */
/** @typedef {{ state: 'none' | 'noreq' | 'unparsed' | 'frames' | 'items', items: Item[] }} WindowItems */
const REPLY_OPEN_ORDER = ['text', 'tool_use', 'thinking']
const replyTag = (d) => (d.kind === 'tool_use' ? 'action · ' + (d.name || '') : d.kind === 'thinking' ? 'thinking' : 'say')
// per list: the last call's inputs and answer (a repaint with nothing moved is one compare)
const MEMO = new WeakMap()
const sigOf = (x) => (x instanceof Set ? [...x].join('\n') : x instanceof Map ? [...x].map(([k, v]) => k + '\t' + JSON.stringify(v)).join('\n') : null)

/** The window of the playhead's step as keyed items, in 1.4's order ① fid · ② win · ③ sec / foldall / row / turn with ④ chline
 * and its removed list before row `cacheBreak.idx` · ⑨ reply; ⑥–⑧ (unparsed · noreq · frames) stand in for ③④⑨. The rows of
 * an open turn follow its turn item; a folded turn has its head only. Pure but for the desk's scratch it sets: s.curFlat,
 * s.curKeys, s.curReply (when the reply has parts), s.curRemoved.
 * @returns {WindowItems} */
export function windowItems(s) {
  const call = callOf(s)
  if (!call) return { state: 'none', items: [] }
  const { facts, tech } = callFacts(call) // ① — its fields are on the skeleton row, so it shows whether the lane is held or not
  const fid = facts.length ? [{ key: 'fid', type: 'fid', facts, tech }] : []
  if (!call.rec) return { state: 'noreq', items: [...fid, { key: 'noreq', type: 'noreq' }] }
  if (call.unparsed) return { state: 'unparsed', items: [...fid, { key: 'unparsed', type: 'unparsed', errMsg: call.errMsg }] }
  const st = s.desk ? stepOf(s.desk, call.rid) : null
  if (!st || !st.held) return { state: 'frames', items: [...fid, { key: 'frames', type: 'frames', frames: framesOf(call) }] }
  const flat = st.flat
  const refFlat = s.desk ? refList(s).flat : null // its lane not held: no 「新」, no removed list
  const marks = [s.openBlocks, s.turnFold, s.turnLanded, s.bodyFail], sigs = marks.map(sigOf)
  // a store that is not a plain Set / Map (a stand-in) has no signature: no cache then
  const memo = sigs.every((x, i) => x != null || marks[i] == null)
    ? [call, refFlat, st.reply, st.detail, s.lanes, contentRefKOf(s), s.navOpen && s.navOpen.has('cwremoved'), deskMode(), bodyVersion(), ...sigs] : null
  const hit = memo && MEMO.get(flat)
  if (hit && hit.key.length === memo.length && hit.key.every((x, i) => x === memo[i])) return scratch(s, hit.out)
  const out = build(s, call, st, refFlat, fid)
  if (memo) MEMO.set(flat, { key: memo, out })
  return scratch(s, out)
}
function scratch(s, out) {
  s.curFlat = out.flat; s.curKeys = out.keys; s.curRemoved = out.removed
  if (out.reply) s.curReply = out.reply
  return out.result
}
function build(s, call, st, refFlat, fid) {
  const flat = st.flat, keys = rowKeys(flat), items = [...fid]
  const reasons = windowReasons(flat), windowLine = !!reasons // ②
  if (reasons) items.push({ key: 'win', type: 'win', reasons })
  const diff = refFlat ? keyDiff(refFlat, flat) : null
  const brk = call.cacheBreak
  const line = hasChangeLine(call, flat)
  const removed = (line && diff && diff.removedBlocks.length) ? diff.removedBlocks : []
  const mark = (i) => (line && i === brk.idx ? [
    { key: 'chline', type: 'chline', k: refNo(s, refRowOf(s.anchor, s.playhead)), cause: brk.cause, compaction: brk.cause === 'compaction',
      inferred: !!call.compactionInferred, auto: !flat.some((b) => b.cc), first: flat[brk.idx] || {} },
    ...(removed.length ? [{ key: 'removed', type: 'removed', blocks: removed, keys: rowKeys(removed), refK: contentRefKOf(s), open: s.navOpen.has('cwremoved') }] : []),
  ] : [])
  const prevKeys = diff ? diff.refKeys : null
  const fail = (b) => (s.bodyFail && b.text_ref && s.bodyFail.get(b.text_ref)) || null
  const row = (b, i, turn) => {
    const open = s.openBlocks.has(keys[i])
    return { key: keys[i], type: 'row', bi: i, b, marks: rowMarks(b, { prevKeys, open, windowLine }), open, fail: fail(b), turn }
  }
  // ③ the sections, in list order: a header where the section changes, message blocks grouped into turns (a run of messages
  // is grouped on its own, so a block of another section between messages is drawn in its place, never dropped)
  const T = turnsOf(flat), tk = new Map(), hk = new Map(), bySec = new Map(), readable = deskMode() === 'read'
  // a header reads its rows as drawn: an open row's body that came back unproven takes back 以下逐字 on every repaint (2.3 §保真标)
  flat.forEach((b, i) => { if (!bySec.has(b.sec)) bySec.set(b.sec, []); bySec.get(b.sec).push(s.openBlocks.has(keys[i]) ? { ...b, _open: true } : b) })
  const head = (sec) => {
    const n = hk.get(sec) || 0, blocks = bySec.get(sec)
    hk.set(sec, n + 1)
    const claim = readable ? 'readable' : windowLine ? 'half' : blocks.every((b) => faithNow(b) === 'verbatim') ? 'verbatim' : null
    items.push({ key: `sec:${sec}#${n}`, type: 'sec', sec, n: blocks.length, size: blocks.reduce((a, b) => a + (typeof b.bytes === 'number' ? b.bytes : 0), 0),
      est: sec === 'tools' && blocks.some((b) => faithOf(b) === 'metadata'), claim }) // the size of a metadata-only definition is an estimate
  }
  let lastSec = null
  flat.forEach((b, i) => {
    if (b.sec !== lastSec) {
      head(b.sec)
      if (b.sec === 'messages' && hk.get('messages') === 1) items.push({ key: 'foldall', type: 'foldall' })
      lastSec = b.sec
    }
    if (b.sec !== 'messages') { items.push(...mark(i), row(b, i, null)); return }
    const ti = T.at[i], t = T.list[ti]
    if (t.items[0] !== i) return // a later item of a turn already drawn
    const open = turnOpen(s, flat, T, ti), anchor = turnAnchorKey(flat, t)
    const n = tk.get(anchor) || 0; tk.set(anchor, n + 1)
    items.push({ key: `q:${anchor}#${n}`, type: 'turn', anchor, ti, label: t.label, query: t.query, acts: t.acts, n: t.items.length, open })
    if (open) for (const j of t.items) items.push(...mark(j), row(flat[j], j, anchor)) // a folded turn draws its head only (rule 2)
  })
  const reply = replyItem(s, st, call) // ⑨
  if (reply.item) items.push(reply.item)
  return { flat, keys, removed, reply: reply.map, result: { state: 'items', items } }
}
// ⑨ this step's reply (2.3 §这一步的回复): one row per reply definition; default open = the rows of the first present kind
// among text → tool call → thinking, a reader's flip being `rp:<bid>` in s.openBlocks. Each row its own mark: an opened body
// that came back unproven outranks the span's proof, on every repaint (as faithNow for a request row).
function replyItem(s, st, call) {
  const r = replyOf({ row: call, reply: st.reply, detail: st.detail })
  if (r.failed) return { item: { key: 'reply', type: 'reply', failed: r.failed, stop: r.stop, rows: [] } }
  // no part: empty only when the bytes are whole; otherwise nothing is claimed about the content (the call line says why)
  if (!r.parts.length) return { item: { key: 'reply', type: 'reply', empty: r.mark === 'partial' ? 'unread' : 'empty', stop: r.stop, rows: [] } }
  const first = REPLY_OPEN_ORDER.find((k) => r.parts.some((d) => d.kind === k))
  const map = new Map(), seen = new Map()
  const rows = r.parts.map((d, i) => {
    const n = seen.get(d.bid) || 0; seen.set(d.bid, n + 1)
    const key = 'rp:' + d.bid + (n ? '#' + n : ''), b = { ...d, text_ref: d.ref }
    map.set(key, b)
    const open = (d.kind === first) !== s.openBlocks.has(key)
    return { key, b, tag: replyTag(d), mark: (open && openedFf(bodyCache.get(b.text_ref))) || partMark(d) || 'verbatim', open, last: i === r.parts.length - 1 }
  })
  return { item: { key: 'reply', type: 'reply', stop: r.stop, rows }, map }
}

// the 内容对比步's list: the pinned step's, else the 缓存对比步's. `wait`: not here yet (flat null), and this step's 「新」 not known
function refList(s) {
  const ref = contentRefOf(s), pinned = !!ref && ref === s.anchor.calls[s.diffRef]
  const wait = (!pinned && refPending(s.anchor, s.playhead)) || (!!ref && !stepOf(s.desk, ref.rid).held)
  return { flat: ref && !wait ? stepOf(s.desk, ref.rid).flat : null, wait }
}
export const refWaits = (s) => !!s.anchor && !!s.desk && refList(s).wait

// ── the landing rule (1.4 §打开一步时落在哪): a step 跟随最新 brought in → the reply ⑨; else the 变化线, else the first 「新」
// block, else the top. Pure: it names the target only; it never reorders blocks.
export function landingTarget(s) {
  const call = callOf(s)
  if (!call || !call.rec || call.unparsed) return null
  const st = s.desk ? stepOf(s.desk, call.rid) : null
  if (!st || !st.held) return null
  if (s.followLanding) return { reply: true } // 跟随最新 brought this step in: the reader watches the model's newest answer
  const flat = st.flat
  const brk = call.cacheBreak
  if (hasChangeLine(call, flat)) return { anchor: 'cachebrk', idx: brk.idx }
  const refFlat = refList(s).flat
  if (refFlat) {
    const refKeys = new Set(refFlat.map((b) => b.key))
    const i = flat.findIndex((b) => !b.volatile && !refKeys.has(b.key))
    if (i >= 0) return { bi: i }
  }
  return null
}
/** The landing due on this step: once per rid, the first time its lane is held (`s.landedFor` records it). → {t, fi, turn, wait}:
 * the target, its list position, the anchor of the folded turn holding it (the caller opens that turn for this display only:
 * s.turnLanded), and `wait`: the 内容对比步's lane is not held, so its 「新」 are not known and the landing is due again when it is
 * — unless the reader moved the box meanwhile (`top()`: the box's scroll position; s.landWait: what it was). null when nothing is
 * due. No side effect: the caller calls landed() and sets s.turnLanded. */
export function landingFor(s, top) {
  const call = callOf(s)
  if (!call || s.landedFor === call.rid || !call.rec || call.unparsed || !s.desk) return null
  const st = stepOf(s.desk, call.rid)
  if (!st.held) return null
  const moved = s.landWait?.rid === call.rid && s.landWait.top !== top()
  const t = moved ? null : landingTarget(s), flat = st.flat
  if (!t) return { t, fi: null, turn: null, wait: !moved && refList(s).wait }
  if (t.reply) return { t, fi: flat.length - 1, turn: null, wait: false }
  const fi = t.anchor ? t.idx : t.bi, T = turnsOf(flat), ti = T.at[fi] ?? -1
  return { t, fi, turn: ti >= 0 && !turnOpen(s, flat, T, ti) ? turnAnchorKey(flat, T.list[ti]) : null, wait: false }
}
/** The landing `due` (landingFor) ran: the step has landed, or waits with the box at `top()`. */
export function landed(s, due, top) {
  const { rid } = callOf(s)
  if (due.wait) s.landWait = { rid, top: top() }; else s.landedFor = rid
}
