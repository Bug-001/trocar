// screens/traffic/request-model.mjs — the request detail (2.6 §C) as data: one request's line, headers and bodies with a fidelity
// mark on EACH side (never one sentence over both), credential-class header values masked unless 「显示」 revealed exactly that one
// (the masked value never enters the view), copies that carry only what is shown, and 技术细节's pairs. The host page hosts it.
// Framework-free (D75②): it eats the `calls {ref}` document only; RequestView.tsx renders what this returns.
import { bytes } from '../../../legacy/core/fmt.mjs'
import { isCredentialHeader } from '../../../legacy/core/sensitive.mjs'
import * as W from '../../../legacy/labels/traffic.mjs'

/** The `calls {ref}` document → its one record and the byte figures (null = not recorded, never 0); an unknown ref → the error's reason. */
export function detailModel(doc) {
  const rec = doc && Array.isArray(doc.records) && doc.records.length ? doc.records[0] : null
  if (!rec) {
    const e = doc && Array.isArray(doc.errors) && doc.errors[0]
    return { rec: null, error: (e && e.reason) || null }
  }
  return { rec, ref: rec.ref ?? null, sent: rec.sent_bytes ?? null, received: rec.received_bytes ?? null }
}

const str = (x) => (x == null ? null : String(x))
const labelBy = (labels, id) => (labels || []).find((l) => l && l.id === id) || null

// 'old' (the old capture stored the '<redacted>' placeholder), 'masked', 'open' (the one this answer reveals) or 'plain'
function maskState(name, value, masked, open) {
  if (value === W.OLD_REDACTED) return 'old'
  if (isCredentialHeader(name)) return open != null && open === name.toLowerCase() && value != null ? 'open' : 'masked'
  return masked ? 'masked' : 'plain'
}

/** One header table: the server's list [{name, value, masked?}] or a plain object; a masked or old value never enters the row. */
function headersOf(h, revealed) {
  const list = Array.isArray(h) ? h : h && typeof h === 'object' ? Object.entries(h).map(([name, value]) => ({ name, value })) : null
  if (!list) return null
  const open = revealed != null ? String(revealed).toLowerCase() : null
  const rows = list.map((x) => {
    const name = str(x && x.name) ?? '', value = str(x && x.value)
    const state = maskState(name, value, !!(x && x.masked), open)
    return { name, state, value: state === 'plain' || state === 'open' ? (value ?? '') : null }
  })
  const copyOf = (r) => `${r.name}: ${r.state === 'old' ? W.MASK_NOTE_OLD : r.state === 'masked' ? W.MASKED_COPY : r.value}`
  return { rows, masked: rows.some((r) => r.state === 'masked'), copy: rows.map(copyOf).join('\n') }
}

// one body, by its kind (the closed set of control-wire.mjs's file header). `rec` is the whole answer: a SMALL parsed-JSON reply keeps
// its body in resp.body (not in ctl.resp.text), so the reprint comes from there.
function bodyOf(side, ctl, rec) {
  const b = (side === 'req' ? ctl.req : ctl.resp) || {}
  const marks = []
  const wireN = b.bytes != null ? b.bytes : null
  const out = (kind, text, fold = '', copy = '', extra = {}) => ({ marks, kind, text, fold, copy, ...extra })
  // a prefix, not the whole body: cut at the capture cap, or a request that never finished (invariant 4)
  if (b.truncated) marks.push({ text: b.stored_bytes != null && wireN != null ? W.PREFIX_ONLY(b.stored_bytes, wireN) : side === 'req' ? W.REQ_TRUNCATED : W.RESP_TRUNCATED })
  else if (b.partial) marks.push({ text: side === 'req' ? W.REQ_PARTIAL : W.RESP_PARTIAL })
  switch (b.kind) {
    case 'text':
    case 'sse':
      if (b.clipped) marks.push({ text: W.CLIPPED(b.shown_chars, b.chars), sub: W.REST_IN_SOURCE })
      if (side === 'req' && b.decoded_from) marks.push({ text: W.DECODED_FROM(b.decoded_from) })
      return out('pre', b.text || '', b.truncated || b.partial ? W.FOLD_PREFIX : W.VERBATIM_BYTES(b.bytes ?? b.chars ?? 0), b.text || '')
    case 'json': {
      let text = typeof b.text === 'string' ? b.text : ''
      if (typeof b.text !== 'string') {
        const src = side === 'req' ? rec.req_body : rec.resp && rec.resp.body
        try { text = src === undefined ? '' : JSON.stringify(src, null, 2) } catch { text = '' }
      }
      return out('pre', text, W.PARSED_JSON_CHARS((b.chars ?? text.length) || 0), text, { head: W.PARSED_JSON })
    }
    case 'ws':
      return out('pre', b.text || '', W.VERBATIM_BYTES(b.bytes ?? b.chars ?? 0), b.text || '')
    case 'binary':
      return out('hex', b.hex || '', W.VERBATIM_BYTES(b.bytes ?? 0), b.hex || '', { head: W.BINARY_LABEL(b.bytes ?? 0) })
    case 'undecoded':
      return out('note', `${W.UNDECODED} · ${b.encoding || '?'} · ${bytes(wireN ?? 0)}`)
    case 'length-only': {
      // MUST NOT read as an empty body: the record kept a size, and the level says whose choice that was
      const log = labelBy(ctl.labels, 'retention-log')
      marks.push({ text: ctl.retention === 'log' && log ? log.label : side === 'req' ? W.REQ_LEGACY : W.RESP_LEGACY })
      return out('note', bytes(wireN ?? 0))
    }
    case 'empty':
      return out('note', W.EMPTY_BODY)
    case 'none':
      return out('note', W.NO_BODY)
    default:
      marks.push({ text: W.UNKNOWN_KIND })
      return out('note', W.UNKNOWN_KIND, '', '', { unknownKind: str(b.kind) })
  }
}

// each side's own marks from the server's labels and the body's state, written next to the body they are about
function reqMarks(b) {
  return b && b.kind === 'undecoded' ? [{ text: W.UNDECODED }] : []
}
function respMarks(ctl, b) {
  const out = []
  if (labelBy(ctl.labels, 'resp-json-reserialized')) out.push({ text: W.RESP_RESERIALIZED })
  if (b && b.kind === 'undecoded') out.push({ text: W.RESP_UNDECODED(b.encoding || '?') })
  if (b && b.error) out.push({ text: `Response: ${b.error}` })
  else if (b && b.interrupted) out.push({ text: W.RESP_PARTIAL })
  // trocar's own additions (the off switch's Connection: close): the server's words, on the response side
  for (const l of ctl.labels || []) if (l && l.id && l.id.startsWith('trocar')) out.push({ text: `${W.TROCAR_ADDED} · ${l.label || l.id}` })
  return out
}
const withSide = (side, b) => ({ ...b, marks: [...side, ...b.marks] })

const SIDE_IDS = /^(req-|resp-|retention-|trocar)/

/** detailModel's model → the detail's view. `revealed` is the one header name the viewer chose to show (a `calls {ref, reveal}` read). */
export function requestView(model, { revealed = null } = {}) {
  const rec = (model && model.rec) || {}, ref = (model && model.ref) || null
  const ctl = rec.ctl || {}
  if (ctl.error) return { ref, unshaped: true } // a record the server could not shape: its reason travels in the answer's error
  const resp = rec.resp || rec.response || {}
  const req = bodyOf('req', ctl, rec), res = bodyOf('resp', ctl, rec)
  const wire = (n) => (n != null ? W.WIRE_N(n) : W.UNRECORDED)
  const tech = [
    ...(ref ? [['ref', ref]] : []),
    ...(ctl.omitted ? [['left in the source record', ctl.omitted.join(', ')]] : []),
    ...(ctl.req && ctl.req.decoded_from ? [['decoded_from', ctl.req.decoded_from]] : []),
    ...(req.unknownKind ? [['req.kind', req.unknownKind]] : []),
    ...(res.unknownKind ? [['resp.kind', res.unknownKind]] : []),
    ...(ctl.host ? [['SNI', ctl.host]] : []),
    ...(ctl.hostHeader ? [['Host', ctl.hostHeader]] : []),
    ...(ctl.labels || []).filter((l) => l && l.id).map((l) => [l.id, l.text || l.label || '']),
  ].map(([k, v]) => [k, { text: String(v) }])
  return {
    ref,
    line: { method: str(rec.method) ?? '', endpoint: str(rec.endpoint) ?? '', status: resp.status != null ? String(resp.status) : '—' },
    meta: { cls: W.classWord(ctl.traffic_class), logOnly: ctl.retention === 'log' },
    callMarks: (ctl.labels || []).filter((l) => l && l.id && !SIDE_IDS.test(l.id)).map((l) => String(l.label || l.id)),
    host: ctl.host || ctl.hostHeader ? { differs: !!ctl.hostDiffers, connected: ctl.host || null, requested: ctl.hostHeader || null } : null,
    req: { headers: headersOf(rec.req_headers != null ? rec.req_headers : rec.request_headers, revealed), body: withSide(reqMarks(ctl.req), req) },
    resp: { headers: headersOf(resp.headers, revealed), body: withSide(respMarks(ctl, ctl.resp), res) },
    wire: { sent: wire(model && model.sent), received: wire(model && model.received) },
    tech,
  }
}
