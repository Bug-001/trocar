// test/query/session-stream.test.mjs — `session` folds a session record by record and ships a page's bodies under a byte budget
// (RFC 3.5 §内存有界 · §分页 正文预算 · 验收 15; 1.6 §4.1 分页).
//
// Generated sessions (test/query/big-session.mjs) on three axes — the wire (a whole context per request, Message Threads, Codex
// over WebSocket: the last two stitched across records), how fast a context grows per turn, and how often a subagent turn is
// interleaved — paged at windows across the session. The contract, whatever the axes: every call is counted and carries its meta;
// the calls that carry bodies lie in the window (plus its baseline), include the window's middle, sit nearest it, and ship contexts
// (their blocks' bytes, `comp`) that sum to at most PAGE_BODY_BYTES (or are exactly one); `page.returned` counts them. A session
// that grew is answered byte for byte as a fold from scratch answers it, also when a late record sorts before ones already folded.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { runQuery, PAGE_BODY_BYTES } from '../../src/query/named/index.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

// a context of another process: its own fs object is its own cache key (src/query/warm.mjs fsTag), so nothing it folds is shared
const freshFs = () => ({ ...fs })
const session = (home, p, ctx = {}) => runQuery('session', p, { home, ...ctx })
const callsOf = (doc) => [...new Set(doc.analyzed.lanes.flatMap((l) => l.calls))]
const bytes = (c) => Object.values(c.comp).reduce((n, v) => n + v, 0)

function checkPage(doc, { cursor, limit }, total) {
  assert.equal(doc.truncated, null)
  assert.equal(doc.page.total, total)
  const calls = callsOf(doc)
  assert.deepEqual(calls.map((c) => c.gi).sort((a, b) => a - b), [...Array(total).keys()], 'every call is there, bodies or not')
  const kept = calls.filter((c) => !c.paged_out)
  assert.equal(doc.page.returned, kept.length)
  // every predecessor is in the capture: no context is partial, and a body put back is the context its meta was counted from
  for (const c of calls) assert.notEqual(c.wire.contextState, 'partial', `gi ${c.gi}`)
  for (const c of kept) assert.equal(c.flat.reduce((n, b) => n + b.bytes, 0), bytes(c), `gi ${c.gi}: its body is the context it was folded with`)
  for (const c of calls) if (c.paged_out) assert.deepEqual([c.flat, c.nonBlockKeys, Object.keys(c.norm)], [[], [], ['usage']])
  for (const c of kept) assert.ok(c.gi >= cursor - 1 && c.gi < cursor + limit, `gi ${c.gi} is in the window`)
  const sum = kept.reduce((n, c) => n + bytes(c), 0)
  assert.ok(sum <= PAGE_BODY_BYTES || kept.length === 1, `${kept.length} bodies, ${sum} request bytes`)
  const mid = cursor + Math.floor(limit / 2)
  if (mid < total) assert.ok(kept.some((c) => c.gi === mid), 'the window\'s middle call rides with its body')
  const far = Math.max(...kept.map((c) => Math.abs(c.gi - mid)))
  for (const c of calls) if (c.paged_out && c.gi >= cursor - 1 && c.gi < cursor + limit) assert.ok(Math.abs(c.gi - mid) >= far, 'nearest the middle first')
}

for (const wire of ['http', 'threads', 'ws']) for (const growth of [800, 12_000, 60_000]) for (const subEvery of [0, 3]) {
  test(`a page of a ${wire} session (context +${growth} B a turn, subagent every ${subEvery || 'never'}): the body budget and the meta of every call`, async () => {
    const home = path.join(tmpDir('trocar-sstream-'), '.trocar')
    const s = bigSession({ home, wire, growth, subEvery, seed: growth + subEvery })
    s.append(70)
    for (const spec of [{ cursor: 0, limit: 60 }, { cursor: 25, limit: 7 }, { cursor: 69 - 30, limit: 60 }, { cursor: 69, limit: 1 }]) {
      const p = { id: s.id, after: String(spec.cursor), limit: String(spec.limit) }
      const cold = await session(home, p, { fs: freshFs() })
      checkPage(cold, spec, 70)
      const ctx = { fs: freshFs() }
      await session(home, p, ctx)
      assert.equal(JSON.stringify(await session(home, p, ctx)), JSON.stringify(cold), 'a warm answer is the cold one, byte for byte')
    }
  })
}

// More chains than the fold keeps in hand (a short-lived subagent every other subagent turn, each its own thread or connection):
// the pages over the oldest ones are put back from records read again, and answer what the meta was counted from.
for (const wire of ['threads', 'ws']) {
  test(`a ${wire} session with many chains: every page, old chains included, ships the contexts its calls were folded with`, async () => {
    const home = path.join(tmpDir('trocar-schains-'), '.trocar')
    const s = bigSession({ home, wire, growth: 2_000, subEvery: 2, subLen: 4 })
    s.append(60)
    for (const spec of [{ cursor: 0, limit: 60 }, { cursor: 0, limit: 9 }, { cursor: 20, limit: 9 }, { cursor: 59, limit: 1 }]) {
      const p = { id: s.id, after: String(spec.cursor), limit: String(spec.limit) }
      const cold = await session(home, p, { fs: freshFs() })
      checkPage(cold, spec, 60)
      assert.ok(callsOf(cold).filter((c) => c.wire.contextState === 'complete').length > 8, 'more chains than are held')
    }
  })
}

test('a session that grew is answered as a fold from scratch answers it, also after a late call that sorts before folded ones', async () => {
  const home = path.join(tmpDir('trocar-sgrow-'), '.trocar')
  const s = bigSession({ home, growth: 3_000, subEvery: 4 })
  s.append(20)
  const ctx = { fs: freshFs() } // one resident process, polled as the board follows
  const tailPage = (n) => ({ id: s.id, after: String(Math.max(0, n - 1 - 30)), limit: '60' })
  const same = async (n) => {
    const grown = JSON.stringify(await session(home, tailPage(n), ctx))
    assert.equal(grown, JSON.stringify(await session(home, tailPage(n), { fs: freshFs() })))
    return JSON.parse(grown)
  }
  await same(20)
  s.append(7)
  assert.equal((await same(27)).page.total, 27)
  // a call that started before the last ones and finished after them: its line is appended last, its ts_request sorts earlier
  const lines = fs.readFileSync(s.file, 'utf8').trim().split('\n')
  const late = JSON.parse(lines[lines.length - 1])
  late.ts_request = late.ts = JSON.parse(lines[5]).ts_request.replace('.000Z', '.500Z')
  fs.appendFileSync(s.file, JSON.stringify(late) + '\n')
  const doc = await same(28)
  assert.equal(doc.page.total, 28)
  assert.equal(callsOf(doc).find((c) => c.gi === 6).ts, late.ts_request, 'the late call takes its place in step order')
})
