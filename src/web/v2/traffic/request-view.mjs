// traffic/request-view.mjs — the request detail widget (2.6 §C): one request's line, headers and bodies with a fidelity
// mark on EACH side (never one sentence covering both), credential-class header values masked until「显示」reveals
// exactly one (the server masks by default; masking is a display default, not isolation), copies that never carry a
// still-masked value, and 技术细节 for the codes. The host page (1.10) hosts it; the model-call lead line is the host
// page's, not this widget's. Pure: it eats the `calls {ref}` document only.
import { esc, bytes } from '../core/fmt.mjs'
import { techDetailsHtml, disclosureHtml } from '../core/ui.mjs'
import { copyBtn } from '../core/dom.mjs'
import { isCredentialHeader } from '../core/sensitive.mjs'
import * as W from '../labels/traffic.mjs'

const normHeaders = (h) => {
  if (Array.isArray(h)) return h // the server's masked list: [{name, value, masked?}]
  if (h && typeof h === 'object') return Object.entries(h).map(([name, value]) => ({ name, value, masked: false })) // an unmasked shape: this board still masks the credential ones (two layers, 2.6 §Risk)
  return null
}
const labelBy = (labels, id) => (labels || []).find((l) => l && l.id === id) || null

// the display state of one header: 'old' (the old capture stored the '<redacted>' placeholder — masked at CAPTURE time),
// 'masked' (the server masked it, or the front end's own list does for an answer that carries no mask), 'open' (the one
// this answer reveals), or 'plain'. A credential-class header is masked unless this answer reveals exactly it.
const maskState = (h, open) => {
  const name = h && h.name != null ? String(h.name) : ''
  const value = h && h.value != null ? String(h.value) : null
  if (value === W.OLD_REDACTED) return 'old'
  if (isCredentialHeader(name)) return open != null && open === name.toLowerCase() && value != null ? 'open' : 'masked'
  return h && h.masked ? 'masked' : 'plain'
}

// ── one header table ────────────────────────────────────────────────────────────────────────────────────────────────
// `revealed` is the one header name the viewer chose to show (from the document already held). A header whose stored value is
// the old capture's '<redacted>' placeholder says so — that is capture-time masking, not display masking.
export function headersHtml(headers, { revealed = null } = {}) {
  const list = normHeaders(headers)
  if (!list) return `<p class="rqd-none">${esc('This record has no headers recorded')}</p>`
  const open = revealed != null ? String(revealed).toLowerCase() : null
  const rows = list.map((h) => {
    const name = h && h.name != null ? String(h.name) : ''
    const value = h && h.value != null ? String(h.value) : null
    const st = maskState(h, open)
    if (st === 'old') return `<span class="k" title="${esc(name)}">${esc(name)}</span><span class="v"><span class="c2">${esc(W.MASK_NOTE_OLD)}</span></span>`
    if (st === 'plain') return `<span class="k" title="${esc(name)}">${esc(name)}</span><span class="v mono">${esc(value == null ? '' : value)}</span>`
    if (st === 'open') return `<span class="k" title="${esc(name)}">${esc(name)}</span><span class="v mono">${esc(value)}</span>`
    return `<span class="k" title="${esc(name)}">${esc(name)}</span><span class="v"><span class="mask-dots" aria-hidden="true">••••••</span> <span class="c2">${esc(W.MASKED)}</span> ` +
      `<button type="button" class="lnk" data-reveal="${esc(name)}">${esc(W.REVEAL)}</button></span>`
  }).join('')
  const hasMasked = list.some((h) => maskState(h, open) === 'masked')
  return `<div class="kvt">${rows}</div>` + (hasMasked ? `<p class="rqd-masknote">${esc(W.MASK_NOTE)}</p>` : '')
}

// what a header table copies: what is on screen — a still-masked value copies as 「(已遮挡)」, the revealed one is in
export function headersCopy(headers, { revealed = null } = {}) {
  const list = normHeaders(headers) || []
  const open = revealed != null ? String(revealed).toLowerCase() : null
  return list.map((h) => {
    const name = h && h.name != null ? String(h.name) : ''
    const value = h && h.value != null ? String(h.value) : null
    const st = maskState(h, open)
    if (st === 'old') return `${name}: ${W.MASK_NOTE_OLD}`
    if (st === 'masked') return `${name}: ${W.MASKED_COPY}`
    return `${name}: ${value == null ? '' : value}`
  }).join('\n')
}

// ── one body, by its kind (the closed set of control-wire.mjs's file header) ───────────────────────────────────────
// → { marks: [html], content: html, copy: string, fold: '逐字 · N 字节' | '解析后的 JSON · N 字符' | '前缀,不是完整的体' }
// `rec` is the whole S8 answer: a SMALL parsed-JSON reply keeps its body in resp.body (not in ctl.resp.text), so the
// reprint comes from there.
export function bodyHtml(side, ctl, rec = null) {
  const b = (side === 'req' ? ctl && ctl.req : ctl && ctl.resp) || {}
  const retention = ctl && ctl.retention
  const labels = (ctl && ctl.labels) || []
  const marks = []
  const pre = (text, cls = '') => `<pre class="rqd-pre ${cls}">${esc(text)}</pre>`
  const wireN = b.bytes != null ? b.bytes : null
  const jsonText = () => {
    if (typeof b.text === 'string') return b.text
    const src = side === 'req' ? (rec && rec.req_body) : (rec && rec.resp && rec.resp.body)
    try { return src === undefined ? '' : JSON.stringify(src, null, 2) } catch { return '' }
  }

  // a prefix, not the whole body: cut at the capture cap, or a request that never finished (invariant 4)
  if (b.truncated || b.partial) {
    marks.push(b.truncated
      ? (b.stored_bytes != null && wireN != null ? esc(W.PREFIX_ONLY(b.stored_bytes, wireN)) : esc(side === 'req' ? W.REQ_TRUNCATED : W.RESP_TRUNCATED))
      : esc(side === 'req' ? W.REQ_PARTIAL : W.RESP_PARTIAL))
  }
  switch (b.kind) {
    case 'text':
    case 'sse':
      if (b.clipped) marks.push(`${esc(W.CLIPPED(b.shown_chars, b.chars))} <span class="c2">${esc(W.REST_IN_SOURCE)}</span>`)
      if (side === 'req' && b.decoded_from) marks.push(esc(W.DECODED_FROM(b.decoded_from)))
      return { marks, fold: b.truncated || b.partial ? W.FOLD_PREFIX : W.VERBATIM_BYTES(b.bytes ?? b.chars ?? 0), content: pre(b.text || ''), copy: b.text || '' }
    case 'json':
      return { marks, fold: W.PARSED_JSON_CHARS((b.chars ?? jsonText().length) || 0), content: `<p class="rqd-kind">${esc(W.PARSED_JSON)}</p>${pre(jsonText())}`, copy: jsonText() }
    case 'ws':
      return { marks, fold: W.VERBATIM_BYTES(b.bytes ?? b.chars ?? 0), content: pre(b.text || ''), copy: b.text || '' }
    case 'binary':
      return { marks, fold: W.VERBATIM_BYTES(b.bytes ?? 0), content: `<p class="rqd-kind">${esc(W.BINARY_LABEL(b.bytes ?? 0))}</p><pre class="rqd-pre hex">${esc(b.hex || '')}</pre>`, copy: (b.hex || '') }
    case 'undecoded':
      return { marks, fold: '', content: `<p class="rqd-kind">${esc(W.UNDECODED)} · ${esc(b.encoding || '?')} · ${esc(bytes(wireN ?? 0))}</p>`, copy: '' }
    case 'length-only': {
      // MUST NOT read as an empty body: the record kept a size, and the level says whose choice that was
      const log = labelBy(labels, 'retention-log')
      const word = retention === 'log' && log ? esc(log.label) : esc(side === 'req' ? W.REQ_LEGACY : W.RESP_LEGACY)
      return { marks, fold: '', content: `<p class="rqd-kind">${word} · ${esc(bytes(wireN ?? 0))}</p>`, copy: '' }
    }
    case 'empty':
      return { marks, fold: '', content: `<p class="rqd-kind">${esc(W.EMPTY_BODY)}</p>`, copy: '' }
    case 'none':
      return { marks, fold: '', content: `<p class="rqd-kind">${esc(W.NO_BODY)}</p>`, copy: '' }
    default:
      return { marks: [...marks, esc(W.UNKNOWN_KIND)], fold: '', content: `<p class="rqd-kind">${esc(W.UNKNOWN_KIND)}</p>`, copy: '', unknownKind: b.kind }
  }
}

// the response side's own marks, from the server's labels (each written once, next to the body it is about)
function respMarks(ctl, b) {
  const out = []
  if (labelBy(ctl.labels, 'resp-json-reserialized')) out.push(esc(W.RESP_RESERIALIZED))
  if (b && b.kind === 'undecoded') out.push(esc(W.RESP_UNDECODED(b.encoding || '?')))
  if (b && b.error) out.push(esc(`Response: ${b.error}`))
  else if (b && b.interrupted) out.push(esc(W.RESP_PARTIAL))
  // asight's own additions (the off switch's Connection: close): the server's words, on the response side (#45 lands the label)
  for (const l of ctl.labels || []) if (l && l.id && l.id.startsWith('asight')) out.push(esc(`${W.ASIGHT_ADDED} · ${l.label || l.id}`))
  return out
}
function reqMarks(ctl, b) {
  const out = []
  if (b && b.kind === 'undecoded') out.push(esc(W.UNDECODED))
  return out
}

// the `calls {ref}` document → the detail's model: its one record, and the byte figures from the record's own
// sent_bytes / received_bytes (null = not recorded, never 0). An unknown ref is records:[] + an errors[] entry.
export function detailModel(doc) {
  const rec = doc && Array.isArray(doc.records) && doc.records.length ? doc.records[0] : null
  if (!rec) {
    const e = doc && Array.isArray(doc.errors) && doc.errors[0]
    return { rec: null, error: (e && e.reason) || null }
  }
  return { rec, ref: rec.ref ?? null, sent: rec.sent_bytes ?? null, received: rec.received_bytes ?? null }
}

// ── the widget ─────────────────────────────────────────────────────────────────────────────────────────────────────
// model is detailModel's; opts = { revealed, foldRequest } — `foldRequest` is the host page's model-call treatment:
// the request side folds into a default-closed 「原始请求」 disclosure (the content is in the replay).
export function requestDetailHtml(model, { revealed = null, foldRequest = false } = {}) {
  const rec = (model && model.rec) || {}, ref = (model && model.ref) || null
  const ctl = (rec && rec.ctl) || {}
  if (ctl.error) return `<p class="rqd-none">${esc(W.UNKNOWN_KIND)}</p>` // a record the server could not shape: its reason travels in the answer's error, not here
  const method = rec && rec.method ? String(rec.method) : ''
  const endpoint = rec && rec.endpoint ? String(rec.endpoint) : ''
  const resp = (rec && (rec.resp || rec.response)) || {}
  const status = resp.status != null ? String(resp.status) : '—'
  const line = `${esc(method)} <span class="mono rqd-endpoint">${esc(endpoint)}</span> <span class="c2">· ${esc(status)}</span>`

  const clsWord = W.classWord(ctl.traffic_class)
  const meta = `${esc(clsWord)}${ctl.retention === 'log' ? ` · ${esc(W.RETENTION_MARK.log.label)}` : ''}`

  // the call-level marks: labels that belong to neither side (today the WebSocket size cap)
  const SIDE_IDS = /^(req-|resp-|retention-|asight)/
  const callMarks = (ctl.labels || []).filter((l) => l && l.id && !SIDE_IDS.test(l.id)).map((l) => `<p class="rqd-mark">${esc(l.label || l.id)}</p>`).join('')

  // the domains: the connected one always; the request's own Host header beside it when they differ (a behaviour
  // signal — except the reverse-proxy records the server already excludes)
  const hostRow = (ctl.host || ctl.hostHeader)
    ? (ctl.hostDiffers
      ? `<p class="rqd-hostdiff">${esc(W.HOST_DIFFERS)}</p>` +
        `<p>${esc(W.CONNECTED_HOST)} <span class="mono">${esc(ctl.host || '—')}</span></p>` +
        `<p>${esc(W.REQUESTED_HOST)} <span class="mono">${esc(ctl.hostHeader || '—')}</span></p>`
      : `<p>${esc(W.CONNECTED_HOST)} <span class="mono">${esc(ctl.host || '—')}</span></p>`)
    : `<p class="rqd-none">${esc(W.NO_HOST)}</p>`

  const reqBody = bodyHtml('req', ctl, rec), respBody = bodyHtml('resp', ctl, rec)
  const reqHeaders = rec && (rec.req_headers != null ? rec.req_headers : rec.request_headers)
  const respHeaders = resp.headers

  const sec = (title, inner, extra = '', id = '') => `<section class="rqd-sec"${id ? ` data-side="${id}"` : ''}><div class="rqd-sh"><b>${esc(title)}</b>${extra}</div>${inner}</section>`
  const bodySec = (title, side, b, sideMarks) => {
    const marksHtml = [...sideMarks, ...b.marks].map((m) => `<p class="rqd-mark">${m}</p>`).join('')
    const fold = b.fold ? `<span class="c2 rqd-fold">${esc(b.fold)}</span>` : ''
    const copy = b.copy ? copyBtn(b.copy) : ''
    return sec(title, `${marksHtml}${b.content}`, `<span class="spacer"></span>${fold}${copy}`, `${side}-body`)
  }

  const reqSecs = sec(W.REQ_HEADERS, headersHtml(reqHeaders, { revealed }), copyBtn(headersCopy(reqHeaders, { revealed })), 'req-headers') +
    bodySec(W.REQ_BODY, 'req', reqBody, reqMarks(ctl, ctl.req))
  const reqPart = foldRequest ? disclosureHtml({ id: 'rq-raw', title: W.RAW_REQUEST, body: reqSecs, open: false }) : reqSecs
  const respSecs = sec(W.RESP_HEADERS, headersHtml(respHeaders, { revealed }), copyBtn(headersCopy(respHeaders, { revealed })), 'resp-headers') +
    bodySec(W.RESP_BODY, 'resp', respBody, respMarks(ctl, ctl.resp))

  const wireLine = `<p class="rqd-wire">${esc(W.WIRE_SIZE)} · ` +
    `${esc(W.REQ_BODY)} ${esc(model.sent != null ? W.WIRE_N(model.sent) : W.UNRECORDED)} · ` +
    `${esc(W.RESP_BODY)} ${esc(model.received != null ? W.WIRE_N(model.received) : W.UNRECORDED)}</p>`

  const tech = techDetailsHtml([
    ...(ref ? [['ref', ref]] : []),
    ...(ctl.omitted ? [['left in the source record', ctl.omitted.join(', ')]] : []),
    ...(reqBody.decoded_from || (ctl.req && ctl.req.decoded_from) ? [['decoded_from', (ctl.req && ctl.req.decoded_from) || reqBody.decoded_from]] : []),
    ...(reqBody.unknownKind ? [['req.kind', String(reqBody.unknownKind)]] : []),
    ...(ctl.host ? [['SNI', ctl.host]] : []),
    ...(ctl.hostHeader ? [['Host', ctl.hostHeader]] : []),
    ...(ctl.labels || []).map((l) => [l.id, l.text || l.label || '']),
  ])

  return `<div class="rqd" data-ref="${esc(ref || '')}">` +
    `<p class="rqd-line">${line}</p><p class="rqd-meta">${meta}</p>` +
    (callMarks ? `<div class="rqd-callmarks">${callMarks}</div>` : '') +
    `<div class="rqd-host">${hostRow}</div>` +
    reqPart + respSecs + wireLine + tech + `</div>`
}

// what the whole detail copies when asked as one — kept for the host page; each part carries its own copy button
export function copyText(part, rec, { revealed = null } = {}) {
  const ctl = (rec && rec.ctl) || {}
  if (part === 'headers-req') return headersCopy(rec && (rec.req_headers != null ? rec.req_headers : rec.request_headers), { revealed })
  if (part === 'headers-resp') return headersCopy(rec && rec.resp && rec.resp.headers, { revealed })
  if (part === 'body-req') return bodyHtml('req', ctl, rec).copy
  if (part === 'body-resp') return bodyHtml('resp', ctl, rec).copy
  return ''
}
