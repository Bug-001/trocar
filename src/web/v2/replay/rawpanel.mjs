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
// replyOf(c) is the one rule (2.3 §这一步的回复 · 2.6 §A): the parts (thinking → text → each tool call, in the block
// vocabulary), the stop reason, the ONE fidelity mark, or the failure reason. This panel draws it as compact rows; the
// context window draws each part as a block row. The mark rule: the bytes only partially stored → 'partial' (「◐ 回复没采全」);
// bytes that resolve (a respRef with a locator) → null (the verbatim text is one click away); anything else → 'parsed'
// (「◐ 解析后的回复」). 逐字 is never written for the parsed reply.
export function replyOf(c) {
  const n = c.norm || {}
  const partial = !!(c.respIncomplete || ((c.wire && c.wire.labels) || []).some((l) => ['resp-truncated', 'resp-partial', 'resp-undecoded'].includes(l.id)))
  const mark = partial ? 'partial' : (c.respRefs || []).some((x) => x && x.ref) ? null : 'parsed'
  // an unparsed step is a REQUEST-body fact (the params row says it, errMsg rides in 技术细节); where the response itself
  // parsed, the reply still renders — 「这次调用失败,没有回复」 would deny a reply we do have (2.6 §A)
  let failed = null
  if (!(c.unparsed && n.text) && (c.error || (c.status != null && c.status !== 200))) {
    failed = { reason: c.unparsed ? '' : (typeof c.error === 'string' ? c.error : (c.errMsg || (c.error && c.error.message) || (c.status != null ? `status ${c.status}` : ''))) }
  }
  const parts = []
  if (n.thinking) parts.push({ kind: 'thinking', block: { type: 'thinking', thinking: String(n.thinking) } })
  if (n.text) parts.push({ kind: 'text', block: { type: 'text', text: n.text } })
  for (const t of n.tools || []) parts.push({ kind: 'tool_use', block: { type: 'tool_use', name: t.name, input: t.input ?? {}, id: t.id } })
  return { failed, mark, stop: n.stop_reason || null, parts }
}
// the reply's ONE fidelity mark as HTML. Shared with the call drawer (2.6 §B) and the window's reply header: one rule.
export function replyMarkHtml(c) {
  const m = replyOf(c).mark
  if (!m) return ''
  const w = m === 'partial' ? W.REPLY_PARTIAL : W.REPLY_PARSED
  return `<span class="rpmark">${mark('part', w)} ${esc(m === 'partial' ? w.replace('◐ ', '') : w)}</span>`
}
// the parsed reply's own rows: ONE fidelity mark, the thinking and the text (over the display cap: the prefix + ONE note in
// this panel's own words — 2.6 §A 「已截断显示 · 前 N / 共 M 字符」, never the context window's block wording stacked on
// top), the tool calls with their arguments as JSON (verbatim, monospace), the stop reason as the provider's own value.
const clippedPre = (t) => {
  const cut = clipCut(t)
  return `<pre class="rawpre">${esc(cut < t.length ? t.slice(0, cut) : t)}</pre>${cut < t.length ? `<div class="cbsrc warn">${esc(W.clipShownNote(cut, t.length))}</div>` : ''}`
}
function parsedReplyHtml(c, r) {
  let h = `<div class="rpk rpreply"><b>${esc(W.REPLY_WORD)}</b> ${replyMarkHtml(c)}</div>`
  for (const { kind, block: b } of r.parts) {
    if (kind === 'thinking') h += `<div class="rpk rpthink">${esc(W.THINKING_ROW)}<div class="rpbody">${clippedPre(b.thinking)}</div></div>`
    else if (kind === 'text') h += `<div class="rpbody">${clippedPre(b.text)}</div>`
    // 2.6 §A 「回复 · 工具调用」: the name and the arguments (JSON) as they are, monospace — a very long input rides the
    // same display clip. The server's norm.tools never carries a ref, so there is no click surface here; the tool id is
    // a tech detail, not a visible row fact.
    else h += `<div class="rpk">${esc(W.toolCallRow(b.name || ''))}<pre class="rawpre">${esc(clipText(JSON.stringify(b.input ?? {}, null, 2)))}</pre></div>`
  }
  if (r.stop) h += `<div class="rpk">${W.stopReasonRow(`<span class="mono">${esc(r.stop)}</span>`)}</div>`
  return h
}
// the reply of one step as this panel's compact rows (the window draws the same replyOf as block rows: ctxwin.mjs)
export function replyHtml(c, techId = 'rpfail') {
  const r = replyOf(c)
  // the visible line is the fixed sentence; the server's raw reason is a tech detail (1.5 §数据规则)
  if (r.failed) return `<div class="rpk"><b>${esc(W.REPLY_WORD)}</b> · ${esc(W.FAILED_NO_REPLY)}${r.failed.reason ? techDetailsHtml([['reason', r.failed.reason]], { id: techId }) : ''}</div>`
  return parsedReplyHtml(c, r)
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
    // 未下发 ≠ 没有: the panel is the window's own paged-out sentence + the load button; the reply, its bytes, the params, later
    // messages, the transport, the observer lines and the tech details arrive with the body (2.6 §A, 3.5 §分页 PAGED_META)
    el.innerHTML = head + modelLine + `<div class="rpk"><span class="pobadge" title="The verbatim request body of this step was not sent with this page; it is kept in full in the raw capture">${esc(W.PAGED_TITLE)}</span> ${loadStepHtml(s, call, `data-load-step="${s.playhead}"`)}</div>`
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
