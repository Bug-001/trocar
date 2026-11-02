// test/view/prefix-proof.test.mjs — 3.3 acceptance #12: the board's "reusable prefix byte-identical" flag (`prefixByteIdentical`,
// and the `gt` it feeds) compares, over [0, idx), each block's verbatim slice with its cache_control member cut out by byte span;
// volatile positions skipped; a block with no verbatim slice, or a context shown in part, makes it false with no gt.
//
// One lane of whole-context calls (test/query/big-session.mjs 'http'), every call with a tool and a billing-header system block
// that differs per call (volatile); the cache marker sits on the last message's last block, so it moves every call. Each case
// rewrites the request bytes of one call (K) and reads K's cache break out of the reduced document.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { reduce } from '../../src/view/reduce.mjs'
import { extractMembers, blockAt } from '../../src/view/extract.mjs'
import { openProjection } from '../../src/query/projection.mjs'
import { parseTextRef } from '../../src/raw/refs.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001', K = 3
const TOOL = { name: 'Read', description: 'Read a file.', input_schema: { type: 'object', properties: { limit: { type: 'number', default: 2 } } } }

// the session's records; `edit(body text, i)` → call i's request bytes; `streamless(i)`: call i carries no stream to address
function session({ edit = (t) => t, streamless = () => false, usage = null } = {}) {
  const s = bigSession({ home: tmpDir('trocar-prefix-'), wire: 'http', growth: 200, subEvery: 0, subLanes: 1, late: 0, compactAt: 1e9 })
  s.append(6)
  return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    const r = JSON.parse(l), b = JSON.parse(r.req_body)
    b.tools = [TOOL]
    b.system = [{ type: 'text', text: `x-anthropic-billing-header: cch=${i}` }, ...b.system]
    const last = b.messages.at(-1)
    last.content = last.content.map((c, j) => (j === last.content.length - 1 ? { ...c, cache_control: { type: 'ephemeral' } } : c))
    const rec = { ...r, req_body: edit(JSON.stringify(b), i), id: `${SEG}:${i + 1}` }
    if (usage && i === K) rec.resp = { ...rec.resp, body: { ...(rec.resp && rec.resp.body), usage } }
    return streamless(i) ? rec : Object.defineProperty(rec, '_stream', { value: STREAM, enumerable: false })
  })
}
function breakOfK(opts) {
  const recs = session(opts), byId = new Map(recs.map((r) => [r.id, r]))
  const store = openProjection({ home: tmpDir('trocar-prefix-'), key: KEY }), members = recs.map((r) => ({ id: r.id }))
  extractMembers({ store, members, recordsAt: (rows) => rows.map((m) => byId.get(m.id)) })
  const doc = reduce(store, members, { resolve: (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref) })
  const row = doc.rows.find((r) => r.rid === recs[K].id)
  assert.ok(row, `call ${recs[K].id} is in the document`)
  assert.ok(row.cacheBreak.idx > 2, 'the reusable prefix holds the tool, the system blocks and earlier messages')
  return row
}

// The row ships the flag through its `gt` (3.5 §会话读 row closed set): with usage that reads nothing from the cache and creates nothing, a
// byte-identical reusable prefix is a provider contradiction (reduce.mjs realGroundTruth), and no gt is claimed without the proof.
const usage = { input_tokens: 4000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const proven = (opts = {}) => breakOfK({ usage, ...opts }).cacheBreak.gt === 'provider-contradiction'

test('#12: a cache marker that moved, and a volatile block that changed, leave the prefix byte-identical', () => {
  assert.equal(proven(), true)
})

test('#12: a tools schema that differs only in whitespace or number spelling (same frame, other bytes) is not byte-identical, no gt', () => {
  for (const [name, edit] of [['whitespace', (t) => t.replace('"default":2', '"default": 2')], ['number spelling', (t) => t.replace('"default":2', '"default":2.0')]]) {
    const row = breakOfK({ usage, edit: (t, i) => (i === K ? edit(t) : t) })
    assert.equal(row.cacheBreak.gt, null, name)
    assert.equal(row.gt, null, name)
  }
})

test('#12: a block in [0, idx) with no verbatim slice, on either side, makes the flag false', () => {
  for (const at of [K, K - 1]) assert.equal(proven({ streamless: (i) => i === at }), false, `call ${at + 1} unaddressable`)
})
