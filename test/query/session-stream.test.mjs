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
import { sessionView } from '../../src/view/board.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { recordsAt } from '../../src/query/records.mjs'

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

// a note (`level`) is about the read that made it (3.5 读不全): a cold fold indexed the segment, a warm one did not
const sansNotes = (d) => { const errors = d.errors.filter((e) => !e.level); return JSON.stringify({ ...d, ok: errors.length === 0, errors }) }
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
      assert.equal(sansNotes(await session(home, p, ctx)), sansNotes(cold), 'a warm answer is the cold one, byte for byte')
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

// A resident process polled as the board follows a growing session, against a fold from scratch in a process that never saw it.
function follower(home, s) {
  const ctx = { fs: freshFs() }
  const tailPage = (n) => ({ id: s.id, after: String(Math.max(0, n - 1 - 30)), limit: '60' })
  return async (n) => {
    const grown = JSON.stringify(await session(home, tailPage(n), ctx))
    assert.equal(grown, JSON.stringify(await session(home, tailPage(n), { fs: freshFs() })), 'the grown spine answers what a fold from scratch does')
    const doc = JSON.parse(grown)
    assert.equal(doc.page.total, n)
    return doc
  }
}

// Subagents side by side whose calls end late (written after calls that started after them): each poll folds on the records it did not
// hold, whatever their place in step order, and answers byte for byte what a fold from scratch answers.
for (const wire of ['http', 'threads', 'ws', 'chat']) for (const subLanes of [4, 8]) {
  test(`a ${wire} session with ${subLanes} subagents side by side and late calls, followed as it grows, is the fold from scratch`, async () => {
    const home = path.join(tmpDir('trocar-slate-'), '.trocar')
    const s = bigSession({ home, wire, growth: 1_500, subEvery: 2, subLanes, late: 6, subLen: 12, seed: subLanes })
    const same = follower(home, s)
    const written = () => fs.readFileSync(s.file, 'utf8').trim().split('\n').length
    s.append(12)
    await same(written())
    for (const k of [1, 2, 1, 5, 1]) { s.append(k); await same(written()) }
  })
}

// A call that sorts before calls already folded IN ITS OWN LANE (its lane is folded again), and a subagent the harness names by neither
// agent id nor thread (its lane is told apart by order alone, so the session is folded again): still the fold from scratch.
test('a late call in its own lane, and one in a lane told apart by order, answer as a fold from scratch', async () => {
  const home = path.join(tmpDir('trocar-sgrow-'), '.trocar')
  const s = bigSession({ home, growth: 3_000, subEvery: 4 })
  s.append(20)
  const same = follower(home, s)
  await same(20)
  const lines = () => fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const earlier = (k) => lines()[k].ts_request.replace('.000Z', '.500Z')
  let n = 20
  const late = (rec, k, edit = (r) => r) => {
    const r = edit({ ...rec, id: `late_${n}`, ts_request: earlier(k), ts: earlier(k) })
    fs.appendFileSync(s.file, JSON.stringify(r) + '\n')
    return ++n
  }
  const main = lines().filter((r) => !r.req_headers['x-claude-code-agent-id'])
  const sub = lines().filter((r) => r.req_headers['x-claude-code-agent-id'])
  const doc = await same(late(main[main.length - 1], 5))
  assert.equal(callsOf(doc).find((c) => c.gi === 6).ts, earlier(5), 'the late call takes its place in step order')
  await same(late(sub[sub.length - 1], 2))
  s.append(3); n += 3
  await same(n)
  const legacy = (r) => {
    const { 'x-claude-code-agent-id': _, ...req_headers } = r.req_headers
    const body = JSON.parse(r.req_body)
    return { ...r, req_headers, req_body: JSON.stringify({ ...body, system: [{ type: 'text', text: 'cc_is_subagent=true' }] }) }
  }
  await same(late(sub[0], 9, legacy))
  await same(late(main[2], 3))
})

// Codex subagents side by side, each on its own WebSocket connection (one connection = one agent): a subagent's call is diffed against
// its OWN previous call (3.5 §缓存), so the prefix it keeps grows with its own conversation, byte identical — not against whichever
// subagent called just before it.
test('subagents side by side on a WebSocket each: a call\'s cache break is against its own agent\'s previous call', async () => {
  const home = path.join(tmpDir('trocar-sagent-'), '.trocar')
  const k = 3
  const s = bigSession({ home, wire: 'ws', growth: 1_500, subEvery: 2, subLanes: k, subLen: 100 })
  s.append(40)
  const doc = await session(home, { id: s.id, after: '0', limit: '60' }, { fs: freshFs() })
  const sub = doc.analyzed.lanes.find((l) => l.kind === 'subagent').calls // their turns taken in turn: call i is agent i % k's
  for (let i = k; i < sub.length; i++) {
    assert.equal(sub[i].cacheBreak.prefixByteIdentical, true, `subagent call ${i}`)
    assert.ok(sub[i].cacheBreak.idx > sub[i - k].cacheBreak.idx, `subagent call ${i} keeps more than its agent's previous call did`)
  }
})

// More lanes than their baselines fit BASELINE_BYTES (3.5 §内存有界: the most recently used held, the rest rebuilt from their record
// read back by id): forty subagents side by side, each a few calls of ~400 KB a turn. Which baselines were let go changes the cost,
// never the answer: every call's meta (cache break, prefix digest, ground truth, composition) is the batch fold's, which holds
// every record (read as the query reads them) in memory and lets no baseline go.
const metaOf = (lanes) => JSON.stringify(lanes.map(({ giLocal, ...l }) => ({ ...l, calls: l.calls.map(({ flat, nonBlockKeys, norm, rec, paged_out, ...c }) => c) })))
for (const wire of ['http', 'threads', 'ws', 'chat']) {
  test(`a ${wire} session whose lanes' baselines exceed BASELINE_BYTES answers the batch fold's meta for every call`, async () => {
    const home = path.join(tmpDir('trocar-sbase-'), '.trocar')
    const s = bigSession({ home, wire, growth: 1_600_000, subEvery: 2, subLanes: 40, subLen: 8 })
    s.append(160)
    const doc = await session(home, { id: s.id, after: '0', limit: '60' }, { fs: freshFs() })
    const rows = sessionGroups(await indexRows({ home, fs, errors: [] })).get(s.id)
    const records = [...recordsAt({ home, fs, rows, errors: [], remember: false })]
    const batch = sessionView(records, s.id)
    assert.equal(doc.page.total, 160)
    assert.equal(metaOf(doc.analyzed.lanes), metaOf(batch.analyzed.lanes))
  })
}
