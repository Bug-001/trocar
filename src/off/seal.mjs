// seal.mjs — the door password at rest (RFC 4.6「日志」, 1.6 R2: the door's password is a credential too). A manifest record keeps the door only as
// `door_sha256`, and the password as `***` in the fields trocar wrote (`value`, `vars.<k>`, `line`, `ops[i].inserted`), with
// `secret: {sha256, fields}` saying which. Every reader of a recorded value unseals it against the file first: the password is taken back from the
// file itself (the text around each `***` matched there, the capture checked against `secret.sha256`), so a sealed record is judged and undone
// exactly like a clear one, and the password never returns to the manifest (unseal gives a copy).
//   sealRecord(rec)     in place: door → door_sha256; the password, when the door has one, masked; never prior_value or ops[].removed (the user's bytes)
//   unseal(entry, text) a copy with the password back and no `secret`, or `entry` itself when it has no secret or the file holds no match
//   doorFp(x)           the record's door fingerprint, sealed or clear
import { sha256 } from './fsutil.mjs'

const SEAL_MASK = '***'
const SEAL_CHARS = 'A-Za-z0-9._~-' // the only charset a sealed password may have: the listener token is hex32 (ingress-config.mjs)
const SEAL_PW = new RegExp(`^[${SEAL_CHARS}]+$`)
const sealPaths = (rec) => [['value'], ...Object.keys(rec.vars && typeof rec.vars === 'object' ? rec.vars : {}).map((k) => ['vars', k]), ['line'],
  ...(Array.isArray(rec.ops) ? rec.ops.map((_, i) => ['ops', i, 'inserted']) : [])]
const sealGet = (o, p) => p.reduce((x, k) => (x == null ? undefined : x[k]), o)
const sealSet = (o, p, v) => { sealGet(o, p.slice(0, -1))[p.at(-1)] = v }
const sealEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function sealRecord(rec) {
  if (typeof rec.door !== 'string') return rec
  const pw = new URL(rec.door).password
  if (pw && !SEAL_PW.test(pw)) throw new TypeError(`the door's password has a character outside [${SEAL_CHARS}]`)
  rec.door_sha256 = sha256(rec.door)
  delete rec.door
  if (!pw) return rec
  const fields = rec.secret && Array.isArray(rec.secret.fields) ? [...rec.secret.fields] : []
  for (const p of sealPaths(rec)) {
    const v = sealGet(rec, p)
    if (typeof v !== 'string' || !v.includes(pw)) continue
    sealSet(rec, p, v.split(pw).join(SEAL_MASK))
    if (!fields.some((q) => JSON.stringify(q) === JSON.stringify(p))) fields.push(p)
  }
  rec.secret = { sha256: sha256(pw), fields }
  return rec
}

export function unseal(entry, text) {
  const s = entry && entry.secret
  if (!s || !text || !Array.isArray(s.fields)) return entry
  for (const p of s.fields) {
    const v = sealGet(entry, p)
    if (typeof v !== 'string' || !v.includes(SEAL_MASK)) continue
    const re = new RegExp(v.split(SEAL_MASK).map(sealEscape).join(`([${SEAL_CHARS}]+)`), 'g')
    for (const m of String(text).matchAll(re)) {
      const caps = m.slice(1)
      if (!caps.every((c) => c === caps[0]) || sha256(caps[0]) !== s.sha256) continue
      const out = structuredClone(entry)
      delete out.secret
      for (const q of s.fields) { const w = sealGet(out, q); if (typeof w === 'string') sealSet(out, q, w.split(SEAL_MASK).join(caps[0])) }
      return out
    }
  }
  return entry
}

export const doorFp = (x) => x.door_sha256 ?? (typeof x.door === 'string' ? sha256(x.door) : null)
