// test/query/session-read-contract.test.mjs — the frozen session-read answers (RFC 3.5 §会话读) keep the contract's invariants.
// The fixture is the shape every lane builds against; this checks it against the spec's list and the contract, not against src/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
const doc = JSON.parse(read('../fixtures/session-read-contract.json'))
const BID = /^[A-Za-z0-9_-]{22}$/
const LANES = ['lane_keyframe', 'lane_ops', 'lane_reset']

test('the fixture holds exactly the answers 3.5 §会话读 lists', () => {
  const spec = read('../../spec/01-trocar-rfc/3.5-query-layer.md')
  const line = spec.split('\n').find((l) => l.includes('契约样例'))
  assert.ok(line, '3.5 names the fixture')
  const names = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((n) => !n.includes('/'))
  assert.deepEqual(Object.keys(doc).sort(), names.sort())
})

test('every answer carries the common keys (an NDJSON answer: on its first line, the doc head)', () => {
  for (const [k, v] of Object.entries(doc)) {
    const a = Array.isArray(v) ? v[0] : v
    assert.equal(a.schema, 2, k)
    assert.equal(typeof a.command, 'string', k)
    assert.equal(typeof a.ok, 'boolean', k)
    assert.ok(Array.isArray(a.errors), k)
  }
})

test('session: a delta is based on a full answer\'s mark; pending is {done, total, work, calls}, on a lane too', () => {
  assert.equal(doc.session_full.base, null)
  assert.equal(doc.session_since.base, doc.session_full.mark)
  for (const { pending } of [doc.session_pending, doc.lane_ops]) {
    assert.ok(Number.isInteger(pending.done) && Number.isInteger(pending.total) && pending.done < pending.total)
    assert.ok(Number.isInteger(pending.work) && pending.work >= 0)
    assert.ok(Number.isInteger(pending.calls) && pending.calls >= 0)
  }
})

// A page's steps rebuilt from their ops: every bid is defined, copies stay in the parent's list.
// A page with no base starts with a keyframe; a --from page's first step copies from the base list the client holds.
function lists(page, known, held = new Map()) {
  page.steps.forEach((s, i) => {
    if (i === 0 && page.base === null) assert.ok(s.ops.length === 1 && s.ops[0][0] === 1, `${s.rid}: a page with no base starts with one add op`)
    if (i === 0 && page.base !== null) assert.equal(s.parent, page.base, `${s.rid}: the first step extends the base`)
    const parent = held.get(s.parent) || []
    const out = []
    for (const [op, ...args] of s.ops) {
      if (op === 0) {
        const [from, len] = args
        assert.ok(from >= 0 && len > 0 && from + len <= parent.length, `${s.rid}: copy [${from}, ${len}] within the parent's ${parent.length}`)
        out.push(...parent.slice(from, from + len))
      } else {
        assert.equal(op, 1, `${s.rid}: op code`)
        out.push(...args)
      }
    }
    for (const bid of [...out, ...s.reply]) assert.ok(known.has(bid), `${s.rid}: ${bid} is defined`)
    held.set(s.rid, out)
  })
  return held
}

test('lane pages: ids defined, keyframe only without a base, copies within the parent, base names the page they extend', () => {
  for (const k of LANES) for (const d of doc[k].defs) { assert.match(d.bid, BID, `${k}: bid`); assert.match(d.fh, BID, `${k}: fh`) }
  for (const k of LANES) {
    const ks = doc[k].events.filter((e) => e.type === 'user').map((e) => e.k)
    for (const [i, n] of ks.entries()) assert.ok(Number.isInteger(n) && n >= 1 && (i === 0 || n > ks[i - 1]), `${k}: user event k ${n} is an ordinal ≥ 1, rising along the page`)
  }
  const key = new Set(doc.lane_keyframe.defs.map((d) => d.bid))
  const held = lists(doc.lane_keyframe, key)
  lists(doc.lane_reset, new Set(doc.lane_reset.defs.map((d) => d.bid)))
  const ops = new Set(doc.lane_ops.defs.map((d) => d.bid))
  for (const b of ops) assert.ok(!key.has(b), `lane_ops re-sends ${b}`)
  assert.equal(doc.lane_ops.base, doc.lane_keyframe.steps.at(-1).rid)
  lists(doc.lane_ops, new Set([...key, ...ops]), held)
  assert.equal(doc.lane_reset.base, null)
})

test('block: one entry per ref; an unreadable ref has null bytes and its own errors entry', () => {
  const { blocks, errors } = doc.block_multi
  assert.equal(new Set(blocks.map((b) => b.ref)).size, blocks.length)
  for (const b of blocks) assert.equal(b.bytes === null, errors.some((e) => e.where === b.ref), b.ref)
})
