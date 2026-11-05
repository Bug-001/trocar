// web/src/screens/replay/call-details.mjs — Call details (2.6 §A), framework-free: the two window items that follow the reply, the wire
// facts of the step that the window says nowhere else. Drawn by CallDetails.tsx; the list and tech helpers are the legacy panel's too.
import { ROUTING_LABELS } from '../../../legacy/replay/analysis.mjs'
import * as W from '../../../legacy/labels/replay.mjs'

// the lane step's lists: a bare locator string is that ref; an object form `{key: ref}` is one key each
export const refsOf = (xs) => (xs || []).map((x) => (typeof x === 'string' ? { ref: x } : x))
export function keysOf(ks) {
  if (Array.isArray(ks)) return ks
  return Object.entries(ks || {}).map(([key, v]) => (v && typeof v === 'object' ? { key, ...v } : { key, ref: v }))
}
// the server ships `value` only for a short scalar (2.6 §A: the threshold lives in nonBlockKeysOf); the board never judges length
export const scalarShown = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
export const wireOf = (call, d) => ({ ...(call.wire || {}), ...(d.wire || {}) })

/** The step's technical details as [name, value] rows. `parts`: the step's reply definitions. */
export function techRows(c, d, w, parts) {
  const bits = []
  if (w.format) bits.push(['format', w.format])
  bits.push(['vendor', w.vendor != null ? String(w.vendor) : `${W.VENDOR_WORD} not known`])
  for (const p of parts) if (p.kind === 'tool_use' && p.id) bits.push(['tool id', String(p.id)]) // 2.6 §A: the tool call's id
  if (c.unparsed && c.errMsg) bits.push(['errMsg', String(c.errMsg)]) // an unparsed step's reason is a tech detail (2.6 §A)
  for (const x of refsOf(d.respRefs)) if (x && (x.label || x.why)) bits.push([W.RAW_REPLY, `${x.label || ''}${x.why ? ' — ' + x.why : ''}`])
  for (const x of keysOf(d.extraMessages)) if (x && x.note) bits.push([x.key, x.note])
  for (const o of w.observerEffect || []) bits.push(['observer', `${o.id || ''}${o.cause ? ' · ' + o.cause : ''} — ${o.what || ''}`])
  for (const l of w.labels || []) if (l && ROUTING_LABELS.has(l.id)) bits.push([l.id, String(l.text || l.label || '')]) // how the call reached trocar (2.3 → 2.6 §A)
  const id = (c.rec && c.rec.id) || c.rid
  if (id) bits.push(['id', String(id)])
  return bits
}

/** ⑩ what capturing changed for the client, when it changed anything (never folded: D37), and ⑪ the folded details of a held step.
 * The fold is `cd` in s.openBlocks and a row's is `cd:<ref>`: both stay across steps. */
export function callDetailItems(call, st, s) {
  const d = st.detail || {}, w = wireOf(call, d), fx = w.observerEffect || []
  const rows = (xs) => xs.map((x) => ({ ...x, open: !!x.ref && s.openBlocks.has('cd:' + x.ref) }))
  return [
    ...(fx.length ? [{ key: 'impact', type: 'impact', lines: fx.map((o, i) => ({ key: `impact:${i}`, text: o.text ?? o.what })) }] : []),
    { key: 'details', type: 'details', open: s.openBlocks.has('cd'), params: rows(keysOf(d.nonBlockKeys)), unparsed: !!call.unparsed,
      raw: rows(refsOf(d.respRefs)), extra: rows(keysOf(d.extraMessages)), transport: w.transport ?? null, tech: techRows(call, d, w, st.reply || []) },
  ]
}
