// src/query/answers.mjs — one request of the query worker answered as bytes, and the answers it keeps (RFC 3.5 §谁执行它 答案缓存).
//
// answer({name, params, indent, gzip, etag}, ctx) → {status, bytes, enc, tag}: runQuery's document as the wire carries it (JSON, gzipped when
// asked: `enc` says `gzip`, else `-`); 400 = the caller's mistake (QueryArgError), 500 = this process's, both as `{error}`.
//
// A name that declares `version` (src/query/named/index.mjs versionOf) is asked it FIRST, before any fold: it reads the warm index
// rows only. Its version equal to the one a kept answer was made under → those very bytes, no query run, no record read (D62 附近的
// 查询 ≤ 50 ms · 采集着也算: the board asks every 1.5 s, and most polls are of a session that did not grow). An answer is kept only
// when its `errors` are exactly the version's own index problems: one that could not read a record says so on every answer (D38) and
// is never remembered. A hit and a miss are the same bytes, because the answer is a function of what the version names.
//
// THE VERSION TAG (4.4 §条件 GET, the version part of `session` / `lane`'s two-part ETag): `tag` = a digest of the name, the
// parameters and the version, on an answer that would be kept and carries no `pending` (an answer still folding is not a
// version anyone may hold: the fold goes on with no file the stamp sees changing); `-` otherwise. A request carrying `etag`
// equal to the tag its version has now → 304, no bytes, no fold.
import { createHash } from 'node:crypto'
import nodeFs from 'node:fs'
import { promisify } from 'node:util'
import { gzip as gzipCb } from 'node:zlib'
import { runQuery, versionOf, QueryArgError } from './named/index.mjs'
import { trocarHome } from '../paths.mjs'
import { fsTag } from './warm.mjs'

const gzip = promisify(gzipCb)
// A board polls one session at a time, a second tab or a CLI look is another: a few answers cover them.
const MAX_ANSWERS = 6
// The kept bytes are Buffers, outside the V8 heap and so outside the warm caches' ledger (src/query/warm.mjs): capped on their own.
const MAX_ANSWER_BYTES = 24 * 1048576

const kept = new Map() // request → { version, status, bytes, enc }, least recently used first
let keptBytes = 0
const tagOf = (name, params, version) => createHash('sha1').update(JSON.stringify([name, params, version])).digest('hex').slice(0, 20)
const NONE = Buffer.alloc(0)
const drop = (k) => { const e = kept.get(k); if (e) { kept.delete(k); keptBytes -= e.bytes.length } }

export async function answer({ name, params = {}, indent = 0, gzip: zip = false, etag = null } = {}, ctx = {}) {
  const { home = trocarHome(), fs = nodeFs } = ctx
  const key = JSON.stringify([fsTag(fs), home, name, params, Number(indent) || 0, zip === true])
  let status = 200, text, version = null, tag = '-'
  try {
    const c = { ...ctx, home, fs, once: {} } // one read of the segment index for the version and the run (session.mjs indexed)
    const v = await versionOf(name, params, c)
    version = v && `${v.key}\n${JSON.stringify(v.errors)}`
    if (version != null && etag != null && etag === tagOf(name, params, version)) return { status: 304, bytes: NONE, enc: '-', tag: etag }
    const hit = version != null && kept.get(key)
    if (hit && hit.version === version) { kept.delete(key); kept.set(key, hit); return { status: hit.status, bytes: hit.bytes, enc: hit.enc, tag: hit.tag } }
    const doc = await runQuery(name, params, c)
    // kept only under the version it answers: a run may move what the version names (session: a fold the measured heap bound
    // stopped is cut again, 3.5 §内存有界), and then the next ask is answered afresh, never with these bytes
    const w = v && (await versionOf(name, params, c))
    if (!(w && w.key === v.key && JSON.stringify(doc.errors) === JSON.stringify(v.errors))) version = null
    if (version != null && !doc.pending) tag = tagOf(name, params, version)
    text = typeof doc.$text === 'string' ? doc.$text : JSON.stringify(doc, null, Number(indent) || 0) // a text answer: its bytes, never re-stringified
  } catch (e) {
    status = e instanceof QueryArgError ? 400 : 500
    text = JSON.stringify({ error: String((e && e.message) || e) })
    version = null
  }
  let bytes = Buffer.from(text, 'utf8')
  text = null
  if (zip === true) bytes = await gzip(bytes)
  const got = { status, bytes, enc: zip === true ? 'gzip' : '-', tag }
  drop(key)
  if (version != null && bytes.length <= MAX_ANSWER_BYTES) {
    kept.set(key, { version, ...got })
    keptBytes += bytes.length
    for (const k of kept.keys()) { if (kept.size <= MAX_ANSWERS && keptBytes <= MAX_ANSWER_BYTES) break; drop(k) }
  }
  return got
}
