// replay/rawpanel.mjs — the right page's lower panel (2.6 §A): the raw online facts of the playhead's step — the reply
// as parsed (text, tool calls, stop reason), the reply bytes it can resolve to, the request keys that are not context
// blocks, the messages the client sent while the call was open, the wire / transport, and what capturing changed for
// the client. Or, when a resource is pinned, that resource's verbatim content (the pin is set by resources.mjs; this
// module is only the host: 「回到原始数据」 and a scrub both return to the default state).
// Usage and cost are NOT here — they live behind the step bar's buttons (2.2). `el` is #rawpanel; `s` is the desk's state.
import { esc, kf } from '../core/fmt.mjs'
import { techDetailsHtml, mark } from '../core/ui.mjs'
import { relPath, ROUTING_LABELS } from './analysis.mjs'
import { fillBody, clipText, clipCut } from './blocks.mjs'
import * as W from '../labels/replay.mjs'
import { pageState } from './follow.mjs'

// ── the reply: parsed text · tool calls · stop reason · ONE fidelity mark ───────────────────────────────────────────
// The mark rule (2.6 §A): the bytes only partially stored → 「◐ 回复没采全」; bytes that resolve (a respRef with a
// locator) → no mark (the verbatim text is one click away); anything else → 「◐ 解析后的回复」. 逐字 is never written
// for the parsed reply. Shared with the call drawer (2.6 §B): one rule, one predicate.
export function replyMarkHtml(c) {
  const partial = !!(c.respIncomplete || ((c.wire && c.wire.labels) || []).some((l) => ['resp-truncated', 'resp-partial', 'resp-undecoded'].includes(l.id)))
  if (partial) return `<span class="rpmark">${mark('part', W.REPLY_PARTIAL)} ${esc(W.REPLY_PARTIAL.replace('◐ ', ''))}</span>`
  const resolves = (c.respRefs || []).some((x) => x && x.ref)
  if (resolves) return ''
  return `<span class="rpmark">${mark('part', W.REPLY_PARSED)} ${esc(W.REPLY_PARSED)}</span>`
}
// the parsed reply's own rows: ONE fidelity mark, the thinking and the text (over the display cap: the prefix + ONE note in
// this panel's own words — 2.6 §A 「已截断显示 · 前 N / 共 M 字符」, never the context window's block wording stacked on
// top), the tool calls with their arguments as JSON (verbatim, monospace), the stop reason as the provider's own value.
const clippedPre = (t) => {
  const cut = clipCut(t)
  return `<pre class="rawpre">${esc(cut < t.length ? t.slice(0, cut) : t)}</pre>${cut < t.length ? `<div class="cbsrc warn">${esc(W.clipShownNote(cut, t.length))}</div>` : ''}`
}
function parsedReplyHtml(c) {
  const n = c.norm || {}
  let h = `<div class="rpk rpreply"><b>${esc(W.REPLY_WORD)}</b> ${replyMarkHtml(c)}</div>`
  if (n.thinking) h += `<div class="rpk rpthink">${esc(W.THINKING_ROW)}<div class="rpbody">${clippedPre(String(n.thinking))}</div></div>`
  if (n.text) h += `<div class="rpbody">${clippedPre(n.text)}</div>`
  for (const t of n.tools || []) {
    // 2.6 §A 「回复 · 工具调用」: the name and the arguments (JSON) as they are, monospace — a very long input rides the
    // same display clip. The server's norm.tools never carries a ref, so there is no click surface here; the tool id is
    // a tech detail, not a visible row fact.
    h += `<div class="rpk">${esc(W.toolCallRow(t.name || ''))}<pre class="rawpre">${esc(clipText(JSON.stringify(t.input ?? {}, null, 2)))}</pre></div>`
  }
  if (n.stop_reason) h += `<div class="rpk">${W.stopReasonRow(`<span class="mono">${esc(n.stop_reason)}</span>`)}</div>`
  return h
}
// the reply of one step: shared by this panel and the context window's closing reply segment (2.3 §这一步的回复) — one rule
export function replyHtml(c, techId = 'rpfail') {
  // an unparsed step is a REQUEST-body fact (the params row says it, errMsg rides in 技术细节); where the response itself
  // parsed, the reply still renders — 「这次调用失败,没有回复」 would deny a reply we do have (2.6 §A)
  if (c.unparsed && c.norm && c.norm.text) return parsedReplyHtml(c)
  if (c.error || (c.status != null && c.status !== 200)) {
    const msg = c.unparsed ? '' : (typeof c.error === 'string' ? c.error : (c.errMsg || (c.error && c.error.message) || (c.status != null ? `status ${c.status}` : '')))
    // the visible line is the fixed sentence; the server's raw reason is a tech detail (1.5 §数据规则)
    return `<div class="rpk"><b>${esc(W.REPLY_WORD)}</b> · ${esc(W.FAILED_NO_REPLY)}${msg ? techDetailsHtml([['reason', msg]], { id: techId }) : ''}</div>`
  }
  return parsedReplyHtml(c)
}
// ── the pieces the capture can still hand over verbatim: reply bytes · non-block request keys · later messages ─────
const refRow = (x, label) => x.ref
  ? `<code class="nbk" data-nbk="${esc(x.ref)}" style="cursor:pointer">${esc(label)}</code>${x.chars != null ? ' ' + kf(x.chars) + ' characters' : ''}`
  : `<code>${esc(label)}</code> <span class="metabadge" title="${esc(x.why || '')}">${esc(x.why ? 'no bytes to read back' : W.NO_RAW_REPLY)}</span>`
function rawReplyHtml(c) {
  const rs = c.respRefs || []
  if (!rs.length) return ''
  const ws = (c.wire && c.wire.transport) === 'ws'
  return `<div class="rpk" title="The captured reply bytes — each piece can be read back from the raw record"><b>${esc(W.RAW_REPLY)}</b> · ${rs.map((x, j) => (ws ? refRow(x, W.rawReplyNth(j + 1)) : refRow({ ...x, chars: null }, x.chars != null ? `${kf(x.chars)} characters` : '—'))).join(' · ')}<div class="nbkbody"></div></div>`
}
// the server ships `value` only for a short scalar (2.6 §A: the threshold lives in nonBlockKeysOf); the panel never judges length
const scalarShown = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
function paramsHtml(c) {
  const ks = c.nonBlockKeys || []
  if (c.unparsed) return `<div class="rpk"><b>${esc(W.REQ_PARAMS)}</b> · ${esc(W.UNPARSED_PARAMS)}</div>`
  if (!ks.length) return `<div class="rpk"><b>${esc(W.REQ_PARAMS)}</b> · ${esc(W.NO_PARAMS)}</div>`
  // a value the server shipped is shown as is (mono); a key without one keeps its length — the bytes stay one click away
  const row = (k) => (scalarShown(k.value)
    ? `${refRow({ ref: k.ref, chars: null, why: k.note }, k.key)} <span class="mono">${esc(String(k.value))}</span>`
    : refRow({ ref: k.ref, chars: k.chars, why: k.note }, k.key))
  return `<div class="rpk" title="Request keys that are not context blocks — kept verbatim in the raw record"><b>${esc(W.REQ_PARAMS)}</b> · ${ks.map(row).join(' · ')}<div class="nbkbody"></div></div>`
}
function extraHtml(c) {
  const xs = c.extraMessages || []
  if (!xs.length) return ''
  return `<div class="rpk" title="Messages the client sent while this call was running — they belong to this call, not to the context; kept verbatim in the raw record"><b>${esc(W.EXTRA_MSGS(xs.length))}</b> · ${xs.map((k) => refRow({ ref: k.ref, chars: k.chars, why: k.note }, k.key)).join(' · ')}<div class="nbkbody"></div></div>`
}
// ── the wire: the transport in words; format / vendor are 技术细节, not a visible row (2.6 §A: the closed-set ids ride
// there raw and monospace; an empty vendor is said, not guessed — 2026-10-08 审查) ─────────────────────────────────────
function wireHtml(c) {
  const w = c.wire || {}
  const tr = w.transport === 'ws' ? W.TRANSPORT_WS : W.TRANSPORT_HTTP
  return `<div class="rpk"><b>${esc(tr)}</b></div>`
}
// what capturing changed for the client (D37): one visible line each — never hidden in a hover (invariant 4)
function observerHtml(c) {
  const os = (c.wire && c.wire.observerEffect) || []
  if (!os.length) return ''
  return os.map((o) => `<div class="rpk rpobs">${esc(o.text || o.what || '')}</div>`).join('')
}
function techHtml(c) {
  const bits = []
  const w = c.wire || {}
  if (w.format) bits.push(['format', w.format])
  bits.push(['vendor', w.vendor != null ? String(w.vendor) : `${W.VENDOR_WORD} not known`])
  for (const t of (c.norm && c.norm.tools) || []) if (t && t.id) bits.push(['tool id', String(t.id)]) // 2.6 §A: the tool call's id
  if (c.unparsed && c.errMsg) bits.push(['errMsg', String(c.errMsg)]) // an unparsed step's reason is a tech detail (2.6 §A)
  for (const x of c.respRefs || []) if (x && (x.label || x.why)) bits.push([W.RAW_REPLY, `${x.label || ''}${x.why ? ' — ' + x.why : ''}`])
  for (const x of c.extraMessages || []) if (x && x.note) bits.push([x.key, x.note])
  for (const o of (c.wire && c.wire.observerEffect) || []) bits.push(['observer', `${o.id || ''}${o.cause ? ' · ' + o.cause : ''} — ${o.what || ''}`])
  for (const l of w.labels || []) if (l && ROUTING_LABELS.has(l.id)) bits.push([l.id, String(l.text || l.label || '')]) // how the call reached trocar (2.3 → 2.6 §A)
  if (c.rec && c.rec.id) bits.push(['id', String(c.rec.id)])
  if (!bits.length) return ''
  return techDetailsHtml(bits, { id: 'rptech' })
}

// the load control of a paged-out step (2.3 §未下发态), one for the window and the raw panel: busy while its read is out; after an
// answer that still lacked the step, a line says so and the button reads again
export function loadStepHtml(s, call, attr) {
  const st = pageState(s, call)
  if (st === 'loading') return `<button type="button" class="pobtn" ${attr} disabled aria-busy="true">${esc(W.LOADING_THIS_STEP)}</button>`
  const btn = `<button type="button" class="pobtn" ${attr}>${esc(W.LOAD_THIS_STEP)}</button>`
  return st === 'missed' ? `<span class="pomissed" data-state="missed">${esc(W.PAGE_MISSED)}</span> ${btn}` : btn
}

export function renderRawPanel(el, s) {
  if (s.viewPin) return renderResourceView(el, s)
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call) { el.innerHTML = ''; return }
  const isMain = s.anchor.kind === 'main'
  const n = s.playhead + 1
  const head = `<div class="rphd">${esc(W.RAW_HEAD(n))}${isMain ? '' : `<span class="rpsub"> · ${esc(W.callNo(W.laneWord(s.anchor.kind), n, s.anchor.calls.length))}</span>`}</div>`
  if (!call.rec) { el.innerHTML = head + `<div class="rpempty">${esc(W.NO_REQUEST)}</div>`; return }
  const model = String((call.rec.request || {}).model || '')
  const modelLine = model ? `<div class="rpk mono">${esc(model)}</div>` : ''
  if (call.paged_out) {
    // 未下发 ≠ 没有: the reply / params rows become the window's own paged-out sentence + the load button; what did not
    // ride the page (respRefs, extraMessages, wire) still renders
    el.innerHTML = head + modelLine + `<div class="rpk"><span class="pobadge" title="The verbatim request body of this step was not sent with this page; it is kept in full in the raw capture">${esc(W.PAGED_TITLE)}</span> ${loadStepHtml(s, call, `data-load-step="${s.playhead}"`)}</div>` +
      rawReplyHtml(call) + extraHtml(call) + wireHtml(call) + observerHtml(call) + techHtml(call)
    return
  }
  el.innerHTML = head + modelLine + replyHtml(call) + rawReplyHtml(call) + paramsHtml(call) + extraHtml(call) + wireHtml(call) + observerHtml(call) + techHtml(call)
}

// ── a pinned resource: its content instead of the call raw ────────────────────────────────────────────────────────────
// Found only by resKey (the server's key for the resource); nothing is guessed from tool arguments or label text.
export function renderResourceView(el, s) {
  const pin = s.viewPin, flat = s.curFlat || []
  const cwd = s.meta && s.meta.project_path
  const path = relPath(cwd, pin.label || pin.resKey || '')
  // a step whose body has not arrived (or never will) has no blocks to search: "not found" would be a claim about data we do not have
  const call = s.anchor && s.anchor.calls[s.playhead]
  const notHere = !call ? '' : call.unparsed ? W.UNPARSED_LINE : !call.rec ? W.NO_REQUEST : call.paged_out ? W.RES_NOT_LOADED : ''
  const tools = pin.resKey ? flat.filter((x) => x.sec === 'tools' && x.resKey === pin.resKey) : []
  // prefer a block that carries the content (a result / injected text) over the call that requested it
  const b = pin.resKey && !tools.length ? (flat.find((x) => x.resKey === pin.resKey && x.kind !== 'tool_use') || flat.find((x) => x.resKey === pin.resKey)) : null
  let body
  if (tools.length) {
    // a capability = the tool definitions it put on the wire: listed as metadata, each row marked by its own faithfulness.
    // The proof rule is 2.3's own (blocks.mjs : faithOf): verbatim must be === true AND the block addressable — an
    // undefined verbatim is not evidence of the verbatim tier.
    const proven = tools.every((t) => t.verbatim === true && t.text_ref)
    body = `<div class="rpk"><b>${esc(pin.label || pin.resKey)}</b> · ${tools.length} tool definitions</div>` +
      tools.map((t) => `<div class="rpk mono">${esc(t.name || '')} · ${kf(t.descChars || 0)}-character description · ${(t.props || []).length} parameters</div>`).join('') +
      `<div class="rpk ${proven ? 'rpok' : 'rpwarn'}">${esc(proven ? W.CAP_VERBATIM : W.CAP_METADATA)}</div>`
  } else if (b) body = `<div class="pinbody" data-bi="${flat.indexOf(b)}"></div>`
  else if (notHere) body = `<div class="rpk">${esc(notHere)}</div>`
  else body = `<div class="rpk">${esc(W.RES_NOT_FOUND)}</div>`
  el.innerHTML = `<div class="rphd">${esc(path)} <span class="rpx" id="rpx" role="button" tabindex="0">${esc(W.BACK_TO_RAW)}</span></div>${body}`
  const pb = el.querySelector('.pinbody')
  if (pb && b) fillBody(s.ctx.api, pb, b)
}

export function wireRawPanel(el, s) {
  const onClick = (e) => {
    if (e.target.closest('#rpx')) { s.viewPin = null; renderRawPanel(el, s); return }
    const ld = e.target.closest('[data-load-step]')
    if (ld) { const c = s.anchor && s.anchor.calls[s.playhead]; if (c) s.ensurePage(c, true); return }
    const t = e.target.closest('[data-nbk]')
    if (!t || !t.dataset.nbk) return
    const bc = t.parentElement.querySelector('.nbkbody')
    if (bc) fillBody(s.ctx.api, bc, { text_ref: t.dataset.nbk })
  }
  el.addEventListener('click', onClick)
  return () => el.removeEventListener('click', onClick)
}
