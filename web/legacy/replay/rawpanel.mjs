// replay/rawpanel.mjs — the right page's lower panel (2.6 §A): the raw online facts of the playhead's step — the reply
// as parsed (text, tool calls, stop reason), the reply bytes it can resolve to, the request keys that are not context
// blocks, the messages the client sent while the call was open, the wire / transport, and what capturing changed for
// the client. Or, when a resource is pinned, that resource's verbatim content (the pin is set by resources.mjs; this
// module is only the host: 「回到原始数据」 and a scrub both return to the default state).
// Usage and cost are NOT here — they live behind the step bar's buttons (2.2). `el` is #rawpanel; `s` is the desk's state.
import { esc, kf } from '../core/fmt.mjs'
import { techDetailsHtml, mark } from '../core/ui.mjs'
import { relPath, ROUTING_LABELS } from './analysis.mjs'
import { showBody, bodyFor, faithOf } from './blocks.mjs'
import { replyOf } from '../../src/screens/replay/window-model.mjs'
import { stepOf } from './model.mjs'
import { stepRef } from './lanes.mjs'
import { keyed, patchInto } from '../core/units.mjs'
import * as W from '../labels/replay.mjs'

// ── the reply: its parts · stop reason · ONE fidelity mark — replyOf / partMark are the window model's (one reply rule,
// two drawings: 2.3 §这一步的回复 · 2.6 §A)
export { replyOf, partMark } from '../../src/screens/replay/window-model.mjs'
// the reply's ONE fidelity mark as HTML (a replyOf result). Shared with the call drawer: one rule.
export function replyMarkHtml(r) {
  const m = r && r.mark
  if (!m) return ''
  const w = m === 'partial' ? W.REPLY_PARTIAL : W.REPLY_PARSED
  return `<span class="rpmark">${mark('part', w)} ${esc(w)}</span>`
}
// a reply part's body: a cell like every other body (2.6 §A), slot-marked so the panel fills it once the bytes arrive
const partBody = (d) => `<div class="rpbody" data-rpb="${esc(d.bid)}">${bodyFor({ ...d, text_ref: d.ref })}</div>`
// the reply of one step as this panel's compact rows (the window draws the same replyOf as block rows: ctxwin.mjs); a part's
// unit is keyed by its bid, so a body already filled stays when the step's other rows change
function replyUnits(r) {
  // the visible line is the fixed sentence; the server's raw reason is a tech detail (1.5 §数据规则)
  if (r.failed) return [{ key: 'reply', html: `<div class="rpk"><b>${esc(W.REPLY_WORD)}</b> · ${esc(W.FAILED_NO_REPLY)}${r.failed.reason ? techDetailsHtml([['reason', r.failed.reason]], { id: 'rpfail' }) : ''}</div>` }]
  const parts = keyed(r.parts.map((d) => ({ key: 'rp:' + d.bid, html: d.kind === 'thinking' ? `<div class="rpk rpthink">${esc(W.THINKING_ROW)}${partBody(d)}</div>`
    : d.kind === 'tool_use' ? `<div class="rpk">${esc(W.toolCallRow(d.name || ''))}${partBody(d)}</div>` : partBody(d) })))
  return [{ key: 'reply', html: `<div class="rpk rpreply"><b>${esc(W.REPLY_WORD)}</b> ${replyMarkHtml(r)}</div>` }, ...parts,
    ...(r.stop ? [{ key: 'stop', html: `<div class="rpk">${W.stopReasonRow(`<span class="mono">${esc(r.stop)}</span>`)}</div>` }] : [])]
}
// ── the pieces the capture can still hand over verbatim: reply bytes · non-block request keys · later messages ─────
// the lane step's lists, as the panel reads them: a bare locator string is that ref; an object form `{key: ref}` is one key each
const refsOf = (xs) => (xs || []).map((x) => (typeof x === 'string' ? { ref: x } : x))
function keysOf(ks) {
  if (Array.isArray(ks)) return ks
  return Object.entries(ks || {}).map(([key, v]) => (v && typeof v === 'object' ? { key, ...v } : { key, ref: v }))
}
// one row item, kept whole on a line (a key never parts from its value); `word` = the label is our words (sans), not a literal key
const refRow = (x, label, { word = false, value = '' } = {}) => {
  const tag = word ? 'span' : 'code'
  return `<span class="rpkv">${x.ref
    ? `<${tag} class="nbk" data-nbk="${esc(x.ref)}" style="cursor:pointer">${esc(label)}</${tag}>${x.chars != null ? ' ' + kf(x.chars) + ' characters' : ''}`
    : `<${tag}>${esc(label)}</${tag}> <span class="metabadge" title="${esc(x.why || '')}">${esc(x.why ? 'no bytes to read back' : W.NO_RAW_REPLY)}</span>`}${value}</span>`
}
function rawReplyHtml(d, w) {
  const rs = refsOf(d.respRefs)
  if (!rs.length) return ''
  const ws = w.transport === 'ws'
  return `<div class="rpk" title="The captured reply bytes — each piece can be read back from the raw record"><b>${esc(W.RAW_REPLY)}</b> · ${rs.map((x, j) => (ws ? refRow(x, W.rawReplyNth(j + 1), { word: true }) : refRow({ ...x, chars: null }, x.chars != null ? `${kf(x.chars)} characters` : '—', { word: true }))).join(' · ')}<div class="nbkbody"></div></div>`
}
// the server ships `value` only for a short scalar (2.6 §A: the threshold lives in nonBlockKeysOf); the panel never judges length
const scalarShown = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
function paramsHtml(c, d) {
  const ks = keysOf(d.nonBlockKeys)
  if (c.unparsed) return `<div class="rpk"><b>${esc(W.REQ_PARAMS)}</b> · ${esc(W.UNPARSED_PARAMS)}</div>`
  if (!ks.length) return `<div class="rpk"><b>${esc(W.REQ_PARAMS)}</b> · ${esc(W.NO_PARAMS)}</div>`
  // a value the server shipped is shown as is (mono); a key without one keeps its length — the bytes open as a cell
  const row = (k) => (scalarShown(k.value)
    ? refRow({ ref: k.ref, chars: null, why: k.note }, k.key, { value: ` <span class="mono">${esc(String(k.value))}</span>` })
    : refRow({ ref: k.ref, chars: k.chars, why: k.note }, k.key))
  return `<div class="rpk" title="Request keys that are not context blocks — kept verbatim in the raw record"><b>${esc(W.REQ_PARAMS)}</b> · ${ks.map(row).join(' · ')}<div class="nbkbody"></div></div>`
}
function extraHtml(d) {
  const xs = keysOf(d.extraMessages)
  if (!xs.length) return ''
  return `<div class="rpk" title="Messages the client sent while this call was running — they belong to this call, not to the context; kept verbatim in the raw record"><b>${esc(W.EXTRA_MSGS(xs.length))}</b> · ${xs.map((k) => refRow({ ref: k.ref, chars: k.chars, why: k.note }, k.key)).join(' · ')}<div class="nbkbody"></div></div>`
}
// ── the wire: the transport in words; format / vendor are 技术细节, not a visible row (2.6 §A) ──────────────────────────
const wireHtml = (w) => `<div class="rpk"><b>${esc(w.transport === 'ws' ? W.TRANSPORT_WS : W.TRANSPORT_HTTP)}</b></div>`
// what capturing changed for the client (D37): one visible line each — never hidden in a hover (invariant 4)
const observerUnits = (w) => keyed((w.observerEffect || []).map((o) => ({ key: 'obs', html: `<div class="rpk rpobs">${esc(o.text || o.what || '')}</div>` })))
function techHtml(c, d, w, r) {
  const bits = []
  if (w.format) bits.push(['format', w.format])
  bits.push(['vendor', w.vendor != null ? String(w.vendor) : `${W.VENDOR_WORD} not known`])
  for (const p of r.parts) if (p.kind === 'tool_use' && p.id) bits.push(['tool id', String(p.id)]) // 2.6 §A: the tool call's id
  if (c.unparsed && c.errMsg) bits.push(['errMsg', String(c.errMsg)]) // an unparsed step's reason is a tech detail (2.6 §A)
  for (const x of refsOf(d.respRefs)) if (x && (x.label || x.why)) bits.push([W.RAW_REPLY, `${x.label || ''}${x.why ? ' — ' + x.why : ''}`])
  for (const x of keysOf(d.extraMessages)) if (x && x.note) bits.push([x.key, x.note])
  for (const o of w.observerEffect || []) bits.push(['observer', `${o.id || ''}${o.cause ? ' · ' + o.cause : ''} — ${o.what || ''}`])
  for (const l of w.labels || []) if (l && ROUTING_LABELS.has(l.id)) bits.push([l.id, String(l.text || l.label || '')]) // how the call reached trocar (2.3 → 2.6 §A)
  const id = (c.rec && c.rec.id) || c.rid
  if (id) bits.push(['id', String(id)])
  return techDetailsHtml(bits, { id: 'rptech' })
}
// a step whose lane is not held: the rows that need the lane are sized empty frames — no text, no control (2.6 §A)
const BUSY_ROW = '<div class="rpk rpbusy" aria-busy="true"></div>'
const busyRowsHtml = () => BUSY_ROW.repeat(3)

// the panel as keyed units, one per row (2.3 三个面板按键打补丁): head, model, the reply's rows, raw reply, parameters, extra
// messages, transport, what capturing changed, technical details — a row whose html is unchanged keeps its node
function rawPanel(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call) return { units: [], parts: [] }
  const u = (key, html) => (html ? [{ key, html }] : [])
  const ref = stepRef(s.lanes, call.rid)
  const n = ref ? (ref.step ? ref.n : ref.k) : s.playhead + 1
  const head = u('head', `<div class="rphd">${esc(W.RAW_HEAD(n))}${s.anchor.kind === 'main' ? '' : `<span class="rpsub"> · ${esc(W.callNo(W.laneWord(s.anchor.kind), n, ref ? ref.m : s.anchor.calls.length))}</span>`}</div>`)
  if (!call.rec) return { units: [...head, ...u('empty', `<div class="rpempty">${esc(W.NO_REQUEST)}</div>`)], parts: [] }
  const model = String((call.rec.request || {}).model || '')
  const modelLine = u('model', model ? `<div class="rpk">${esc(model)}</div>` : '')
  const st = s.desk ? stepOf(s.desk, call.rid) : null
  const d = (st && st.detail) || {}, w = { ...(call.wire || {}), ...(d.wire || {}) }
  if (!st || !st.held) return { units: [...head, ...modelLine, ...u('wire', wireHtml(w)), ...[0, 1, 2].map((i) => ({ key: 'busy' + i, html: BUSY_ROW }))], parts: [] }
  const r = replyOf({ row: call, reply: st.reply, detail: d })
  return { parts: r.parts, units: [...head, ...modelLine, ...replyUnits(r), ...u('rawreply', rawReplyHtml(d, w)), ...u('params', paramsHtml(call, d)),
    ...u('extra', extraHtml(d)), ...u('wire', wireHtml(w)), ...observerUnits(w), ...u('tech', techHtml(call, d, w, r))] }
}
export const rawPanelUnits = (s) => rawPanel(s).units

export function renderRawPanel(el, s) {
  if (s.viewPin) return renderResourceView(el, s)
  const { units, parts } = rawPanel(s)
  patchInto(el, units)
  // the reply's cells whose bytes are not here show the pending box; the step's own reads fetch them once the playhead rests
  // (2.3 §快速拖动) and repaint; a body whose read failed shows that failure here
  if (el.querySelectorAll && s.bodyFail && s.bodyFail.size) {
    const defs = new Map(parts.map((p) => [p.bid, p]))
    for (const slot of el.querySelectorAll('[data-rpb]')) { const p = defs.get(slot.dataset.rpb), got = p && s.bodyFail.get(p.ref); if (got && slot.querySelector('pre[data-ref]')) showBody(slot, { ...p, text_ref: p.ref }, got) }
  }
}

// ── a pinned resource: its content instead of the call raw ────────────────────────────────────────────────────────────
// Found only by resKey (the server's key for the resource); nothing is guessed from tool arguments or label text.
export function renderResourceView(el, s) {
  const pin = s.viewPin, flat = s.curFlat || []
  const cwd = s.meta && s.meta.project_path
  const path = relPath(cwd, pin.label || pin.resKey || '')
  // a step whose lane is not held has no blocks to search: "not found" would be a claim about data we do not have
  const call = s.anchor && s.anchor.calls[s.playhead]
  const held = !!(call && s.desk && stepOf(s.desk, call.rid).held)
  const notHere = !call ? '' : call.unparsed ? W.UNPARSED_LINE : !call.rec ? W.NO_REQUEST : ''
  const tools = pin.resKey ? flat.filter((x) => x.sec === 'tools' && x.resKey === pin.resKey) : []
  // prefer a block that carries the content (a result / injected text) over the call that requested it
  const b = pin.resKey && !tools.length ? (flat.find((x) => x.resKey === pin.resKey && x.kind !== 'tool_use') || flat.find((x) => x.resKey === pin.resKey)) : null
  let body
  if (notHere) body = `<div class="rpk">${esc(notHere)}</div>`
  else if (call && !held) body = busyRowsHtml()
  else if (tools.length) {
    // a capability = the tool definitions it put on the wire, each a row of what its definition carries; the tier by the proof
    // rule over all of them (2.4 §能力的分档): all proven · all an older capture's metadata · anything else
    const ff = tools.map(faithOf), proven = ff.every((f) => f === 'verbatim')
    const tier = proven ? W.CAP_VERBATIM : ff.every((f) => f === 'metadata') ? W.CAP_METADATA : W.CAP_MIXED
    body = `<div class="rpk"><b>${esc(pin.label || pin.resKey)}</b> · ${tools.length} tool definitions</div>` +
      tools.map((t) => `<div class="rpk">${esc(W.capToolRow(t.name || '', kf(t.chars || 0)))}</div>`).join('') +
      `<div class="rpk ${proven ? 'rpok' : 'rpwarn'}">${esc(tier)}</div>`
  } else if (b) body = `<div class="pinbody" data-bi="${flat.indexOf(b)}"></div>`
  else body = `<div class="rpk">${esc(W.RES_NOT_FOUND)}</div>`
  el.innerHTML = `<div class="rphd"><span class="mono">${esc(path)}</span> <span class="rpx" id="rpx" role="button" tabindex="0">${esc(W.BACK_TO_RAW)}</span></div>${body}`
  const pb = el.querySelector('.pinbody')
  if (pb && b) fillBody(s.ctx.api, pb, b)
}

export function wireRawPanel(el, s) {
  const onClick = (e) => {
    if (e.target.closest('#rpx')) { s.viewPin = null; renderRawPanel(el, s); return }
    const t = e.target.closest('[data-nbk]')
    if (!t || !t.dataset.nbk) return
    const bc = t.closest('.rpk')?.querySelector('.nbkbody')
    if (bc) fillBody(s.ctx.api, bc, { text_ref: t.dataset.nbk })
  }
  el.addEventListener('click', onClick)
  return () => el.removeEventListener('click', onClick)
}
