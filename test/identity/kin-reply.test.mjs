// Kinship by reply (3.4 按内容认亲): a keyless compaction request carries earlier replies whole; the reply's session takes it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSynthAssigner, synthFactsOf, SYNTH_TTL_MS, REPLY_CAP } from '../../src/dissect/synth-key.mjs'
import { indexRows } from '../../src/query/rows.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'

const T0 = Date.parse('2026-10-18T10:00:00.000Z'), MIN = 60_000, HOUR = 60 * MIN
const UA = { 'user-agent': 'pi/1.4.0 (darwin; node/v22.23.3; arm64)' }
const PI = 'You are pi, an expert coding assistant.'
const SUMMARY = 'You are a context summarization assistant. Produce a structured summary.'
let n = 0
// one pi call as the collector writes it; the reply in the shape its wire stores it
const rec = ({ wire, system, input, sid, reply, ms }) => {
  const responses = wire === 'responses'
  const body = responses
    ? { model: 'gpt-5', ...(sid ? { prompt_cache_key: sid } : {}), input: [{ role: 'developer', content: system }, ...input.map((t) => ({ role: 'user', content: [{ type: 'input_text', text: t }] }))] }
    : { model: 'claude-sonnet-4-5', max_tokens: 4096, system, messages: input.map((t) => ({ role: 'user', content: [{ type: 'text', text: t }] })) }
  return {
    id: `req_${++n}`, ts: new Date(ms).toISOString(), ts_request: new Date(ms).toISOString(), method: 'POST',
    host: responses ? 'api.openai.com' : 'api.anthropic.com', endpoint: responses ? '/v1/responses' : '/v1/messages',
    req_headers: { 'content-type': 'application/json', ...UA, ...(sid ? { session_id: sid } : {}) }, req_body: JSON.stringify(body),
    resp: responses ? { status: 200, kind: 'sse', raw_sse: reply ? [{ type: 'response.output_text.delta', delta: reply }] : [] }
      : { status: 200, kind: 'json', body: { content: reply ? [{ type: 'text', text: reply }] : [] } },
    is_llm_call: true, capture: 'transparent', traffic_class: 'llm', proc: { pid: 7, exe: '/x', agent: 'pi' },
  }
}
const WORDS = 'the parser keeps every token offset while the lexer module reports each failing test before release and after review'.split(' ')
const prose = (seed, len) => { // seeded words up to `len` chars
  let s = '', x = seed
  while (s.length < len) { x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s += WORDS[x % WORDS.length] + ' ' }
  return s.slice(0, len).trim()
}
// a session's turn: its user texts so far (which no summary below carries) and a reply
const turn = (wire, s, t, reply, ms) => rec({ wire, system: `${PI}\n<cwd>\n/work/${s}\n</cwd>`, sid: wire === 'responses' ? `sid-${s}` : null, input: Array.from({ length: t + 1 }, (_, i) => `user ${s} turn ${i} ${prose(9000 + s * 10 + i, 60)}`), reply, ms })
// a summary request carrying `parts` (replies or quotes) and nothing else, its own reply `out`
const summary = (wire, parts, ms, out = null) => rec({ wire, system: SUMMARY, input: ['<conversation>\n' + parts.map((p) => `[Assistant]: ${p}`).join('\n\n') + '\n</conversation>'], reply: out, ms })

// the rule over the calls in order → each call's session (a keyed call's is its key)
const run = (recs) => {
  const assign = createSynthAssigner()
  return recs.map((r) => { const f = synthFactsOf(r), got = assign(f); return { key: f.key ?? got?.key ?? null, kin: !!got?.kin } })
}

for (const wire of ['responses', 'messages']) {
  test(`kinship by reply (${wire}): a keyless summary carrying an earlier long reply joins that reply's session, keyed or synthesized`, () => {
    const r0 = prose(1, 900), r1 = prose(2, 900)
    const recs = [turn(wire, 0, 0, r0, T0), turn(wire, 1, 0, r1, T0 + MIN), summary(wire, [r0], T0 + 2 * MIN), summary(wire, [r1], T0 + 3 * MIN)]
    const k = run(recs)
    if (wire === 'responses') assert.equal(k[0].key, 'sid-0', 'the keyed session')
    assert.notEqual(k[0].key, k[1].key)
    assert.deepEqual([k[2], k[3]], [{ key: k[0].key, kin: true }, { key: k[1].key, kin: true }])
  })
}

test('kinship by reply: a summary\'s own reply is kept under the session it joined, so the next summary that quotes it joins too', () => {
  const r0 = prose(3, 600), s0 = prose(4, 700)
  const recs = [turn('responses', 0, 0, r0, T0), summary('responses', [r0], T0 + MIN, s0), summary('responses', [s0], T0 + 2 * MIN)]
  assert.equal(run(recs)[2].key, 'sid-0')
})

test('kinship by reply: a reply kept under two sessions decides nothing alone: the count of replies, else the fingerprint rule', () => {
  const shared = prose(5, 600), own0 = prose(6, 600), own1 = prose(7, 600)
  const base = [turn('responses', 0, 0, own0, T0), turn('responses', 0, 1, shared, T0 + MIN), turn('responses', 1, 0, own1, T0 + 2 * MIN), turn('responses', 1, 1, shared, T0 + 3 * MIN)]
  const at = T0 + 4 * MIN
  // the newest reply it holds is both sessions'; an older one is session 0's alone → 0
  assert.equal(run([...base, summary('responses', [own0, shared], at)]).at(-1).key, 'sid-0')
  assert.equal(run([...base, summary('responses', [own1, shared], at)]).at(-1).key, 'sid-1')
  // only the shared one: a tie, and no user text in common → no session
  const alone = run([...base, summary('responses', [shared], at)]).at(-1)
  assert.equal(alone.kin, false)
  assert.ok(!['sid-0', 'sid-1'].includes(alone.key))
  // the shared one and session 1's user text → the fingerprint rule decides
  const withUser = rec({ wire: 'responses', system: SUMMARY, input: [`[Assistant]: ${shared}`, base[2].req_body.match(/user 1 turn 0 [a-z ]+/)[0]], ms: at })
  assert.deepEqual(run([...base, withUser]).at(-1), { key: 'sid-1', kin: true })
})

test('kinship by reply: a reply under 256 collapsed chars, or a request quoting only the start of a long one, never joins', () => {
  const short = prose(8, 240) + '   \n\n  ' + prose(9, 10), long = prose(10, 1200)
  for (const [reply, quote, why] of [[short, short, 'short'], [long, long.slice(0, 900), 'the start only'], [long, long.slice(300), 'the end only']]) {
    const k = run([turn('responses', 0, 0, reply, T0), summary('responses', [quote], T0 + MIN)])
    assert.equal(k[1].kin, false, why)
    assert.notEqual(k[1].key, 'sid-0', why)
  }
})

test('kinship by reply: the latest reply at the end of a long request is still seen', () => {
  const r = prose(12, 600), filler = prose(13, 200_000)
  assert.equal(run([turn('responses', 0, 0, r, T0), summary('responses', [filler, r], T0 + MIN)])[1].key, 'sid-0')
})

test('kinship by reply: a reply among the last windows is seen however much whitespace follows it', () => {
  // 40 K collapsed chars after the reply, spread over 400 K raw ones: the windows are the collapsed text's
  const r = prose(14, 600), loose = prose(15, 40_000).split(' ').join(' \n'.repeat(5))
  assert.equal(run([turn('responses', 0, 0, r, T0), summary('responses', [prose(16, 100_000), r, loose], T0 + MIN)])[1].key, 'sid-0')
})

test('kinship by reply: a request is read over a bounded tail: a reply before 2 M chars that keep no window is not seen', () => {
  const r = prose(40, 600), filler = 'abc'.repeat(700_000) // the sample keeps none of its windows
  assert.equal(run([turn('responses', 0, 0, r, T0), summary('responses', [r, filler], T0 + MIN)])[1].kin, false)
})

test('kinship by reply: edited copies of a reply before it, ends the same, do not hide the whole copy', () => {
  // one char changed in the middle: the same length, so a copy that keeps the window count matches the reply's ends and misses its digest
  const r = prose(41, 900), edited = (i) => r.slice(0, 400 + 20 * i) + '#' + r.slice(401 + 20 * i)
  assert.equal(run([turn('responses', 0, 0, r, T0), summary('responses', [1, 2, 3, 4, 5, 6].map(edited).concat(r), T0 + MIN)])[1].key, 'sid-0')
})

test('kinship by reply: a reply past SYNTH_TTL_MS names no session; within it, past the fingerprint window, it does', () => {
  const r = prose(11, 800)
  assert.equal(run([turn('responses', 0, 0, r, T0), summary('responses', [r], T0 + SYNTH_TTL_MS - MIN)])[1].key, 'sid-0', 'within the TTL')
  assert.equal(run([turn('responses', 0, 0, r, T0), summary('responses', [r], T0 + SYNTH_TTL_MS + MIN)])[1].kin, false, 'past it')
})

test('kinship by reply: at the reply cap, a reply expiring at a segment\'s first record leaves live and cold the same', () => {
  const r0 = prose(30, 600), item = synthFactsOf(turn('responses', 0, 0, r0, T0)).reply
  const facts = [turn('responses', 1, 0, prose(31, 600), T0 + MIN), turn('responses', 2, 0, prose(32, 600), T0 + 2 * MIN), summary('responses', [r0], T0 + 3 * MIN)].map((r) => synthFactsOf(r))
  // the store at the cap, oldest first: a reply past SYNTH_TTL_MS, session 0's reply, filler
  const full = () => new Map([['\u0003pi\0old', { lastMs: T0 - SYNTH_TTL_MS - HOUR, owners: ['sid-9'] }], [`\u0003pi\0${item}`, { lastMs: T0, owners: ['sid-0'] }],
    ...Array.from({ length: REPLY_CAP - 2 }, (_, i) => [`\u0003pi\0f${i}`, { lastMs: T0, owners: ['sid-9'] }])])
  const cold = full(), live = full(), one = createSynthAssigner({ open: cold })
  // cold: one assigner for the segment; live: one per growth step, over the same state
  assert.deepEqual(facts.map((f) => createSynthAssigner({ open: live })(f)), facts.map((f) => one(f)))
  assert.equal(cold.size, live.size)
})

test('kinship by reply: a compaction request with no fingerprints picks as the fingerprint rule did, the stale chain\'s items still counted', () => {
  const GAP = 30 * MIN, at = (ms, chain, items, more = {}) => ({ harness: 'pi', ms, hash: 'h', fp: [], probe: null, reply: null, heads: null, late: 0, chain, items, mark: false, ...more })
  const assign = createSynthAssigner({ gapMs: GAP })
  const s = assign(at(T0, ['c1'], ['x', 'y'])), l = assign(at(T0 + 1, ['c2'], ['p']))
  // l extends past 2 × the gap and now holds s's items too; s is stale with its items
  assert.equal(assign(at(T0 + 2 * GAP + 2 * MIN, ['c2', 'c3'], ['x', 'y'])).key, l.key)
  // x and y are held by two chains: they say nothing, so the probe-less request opens a new chain
  const got = assign(at(T0 + 2 * GAP + 3 * MIN, ['c9'], ['x', 'y'], { probe: [] }))
  assert.equal(got.kin, false)
  assert.ok(![s.key, l.key].includes(got.key))
})

// the same membership, read cold in one pass, cut into two segments anywhere, and as the live segment grows record by record,
// for three arrival orders of two sessions' turns and summaries
const membership = async (home) => {
  const errors = [], rows = await indexRows({ home, errors })
  assert.deepEqual(errors, [])
  const ids = new Map()
  for (const seg of fs.readdirSync(path.join(home, 'raw')).sort()) {
    fs.readFileSync(path.join(home, 'raw', seg), 'utf8').split('\n').forEach((l, i) => { if (l) ids.set(`${seg.replace(/\.ndjson$/, '')}:${i + 1}`, JSON.parse(l).id) })
  }
  return new Map([...rows].map((r) => [ids.get(r.id), r.session_id]))
}
const SEG = ['20261018T100000Z', '20261018T110000Z']
const homeOf = (parts) => { const h = rawHome('trocar-kin-reply-'); parts.forEach((recs, i) => writeSegment(h, SEG[i], recs.map((r) => JSON.stringify(r)))); return h }
test('kinship by reply: live = cold in three arrival orders, cut into two segments, and as the live segment grows', async () => {
  for (const wire of ['responses', 'messages']) {
    const a = [prose(20, 500), prose(21, 500)], b = [prose(22, 500), prose(23, 500)]
    const A = [turn(wire, 0, 0, a[0], 0), turn(wire, 0, 1, a[1], 0), summary(wire, a, 0, prose(24, 400))]
    const B = [turn(wire, 1, 0, b[0], 0), turn(wire, 1, 1, b[1], 0), summary(wire, b, 0, prose(25, 400))]
    const orders = [[...A, ...B], [A[0], B[0], A[1], B[1], A[2], B[2]], [B[0], A[0], B[1], B[2], A[1], A[2]]]
    for (const [o, order] of orders.entries()) {
      const recs = order.map((r, i) => ({ ...r, ts: new Date(T0 + i * MIN).toISOString(), ts_request: new Date(T0 + i * MIN).toISOString() }))
      const whole = await membership(homeOf([recs]))
      const at = `${wire}/order ${o}`
      assert.equal(whole.get(recs[order.indexOf(A[2])].id), whole.get(recs[order.indexOf(A[0])].id), `${at}: A's summary in A`)
      assert.equal(whole.get(recs[order.indexOf(B[2])].id), whole.get(recs[order.indexOf(B[0])].id), `${at}: B's summary in B`)
      assert.notEqual(whole.get(recs[order.indexOf(A[0])].id), whole.get(recs[order.indexOf(B[0])].id), at)
      for (let cut = 1; cut < recs.length; cut++) assert.deepEqual(await membership(homeOf([recs.slice(0, cut), recs.slice(cut)])), whole, `${at}: cut at ${cut}`)
      const live = homeOf([recs.slice(0, 1)])
      for (let i = 1; i <= recs.length; i++) {
        if (i > 1) writeSegment(live, SEG[0], [JSON.stringify(recs[i - 1])])
        const m = await membership(live)
        for (const r of recs.slice(0, i)) assert.equal(m.get(r.id), whole.get(r.id), `${at}: grown to ${i}`)
      }
    }
  }
})

test('kinship by reply: a reply no reader can read is no reply, and its segment is read whole', async () => {
  const r = prose(51, 900)
  const odd = [{ status: 200, kind: 'json', body: { content: [null] } }, { status: 200, kind: 'json', body: { text: ['not', 'text'] } }]
  const recs = [turn('messages', 0, 0, r, T0), ...odd.map((resp, i) => ({ ...turn('messages', 1 + i, 0, null, T0 + (1 + i) * MIN), resp })), summary('messages', [r], T0 + 3 * MIN)]
  const m = await membership(homeOf([recs])) // no errors: the segment is not unreadable
  assert.equal(m.size, recs.length, 'every call has its session')
  assert.equal(m.get(recs[3].id), m.get(recs[0].id), 'the summary still joins by the reply it carries')
})

test('kinship by reply: a compaction request whose record cannot be read back decides nothing by its replies and says so on every read; a minute on, it is read again', async () => {
  const r = prose(61, 900), recs = [turn('messages', 0, 0, r, T0), summary('messages', [r], T0 + MIN)]
  const home = homeOf([recs]), at = Buffer.byteLength(JSON.stringify(recs[0])) // a seek to the summary's line reads from the newline before it (records.mjs plainReader)
  const disk = { failing: true, reads: 0 } // a read of the summary's own bytes fails while `failing`; the index scan reads from the start
  const f = { ...fs, readSync: (fd, b, o, n, pos, ...a) => { if (pos === at) { disk.reads++; if (disk.failing) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }) } return fs.readSync(fd, b, o, n, pos, ...a) } }
  let clock = 0
  const read = async () => { const errors = [], rows = [...await indexRows({ home, fs: f, errors, now: () => clock })]; return { errors, rows } }
  for (const turn of [1, 2]) {
    const { errors, rows } = await read()
    assert.deepEqual(errors.map((e) => [e.where, e.code]), [[`segments/${SEG[0]}`, 'record-unreadable']], `read ${turn}: said`)
    assert.match(errors[0].reason, new RegExp(`${rows[1].id}: a compaction request could not be read back`))
    assert.notEqual(rows[1].session_id, rows[0].session_id, 'not joined by a reply it could not be read for')
  }
  assert.equal(disk.reads, 1, 'the list it gave is kept: one record that stays unreadable is not read again on every read')
  disk.failing = false
  clock += 60_000 // the first read a minute on says it and lets that list go; the next builds and reads again
  assert.equal((await read()).errors.length, 1)
  const { errors, rows } = await read()
  assert.deepEqual(errors, [])
  assert.equal(rows[1].session_id, rows[0].session_id, 'read back once the disk answers, it joins, as a cold build does')
})

// past KEEP segments a build hands the rule's state from part to part (src/query/rows.mjs): the parts it keeps are copied, so a
// later build that starts from one, after a middle segment is rewritten or a new one comes, reads what that part ended with
test('kinship by reply: live = cold over 24 segments with replies, a middle segment rewritten, then a new one', async () => {
  const name = (k) => `20261018T${String(k).padStart(2, '0')}0000Z`, at = (k, i) => Date.parse('2026-10-18T00:00:00.000Z') + k * HOUR + i * MIN
  const wire = (s) => (s === 1 ? 'responses' : 'messages'), said = [[], [], []], segs = []
  for (let k = 0; k < 25; k++) {
    const recs = []
    for (let s = 0; s < 3; s++) { said[s].push(prose(100 + 3 * k + s, 400)); recs.push(turn(wire(s), s, k, said[s].at(-1), at(k, recs.length))) }
    if (k % 3 === 2) { const s = Math.floor(k / 3) % 3; recs.push(summary(wire(s), said[s].slice(-3), at(k, recs.length), prose(500 + k, 400))) }
    segs.push(recs)
  }
  const lines = (recs) => recs.map((r) => JSON.stringify(r))
  const homeOf = (n) => { const h = rawHome('trocar-kin-reply-'); segs.slice(0, n).forEach((recs, k) => writeSegment(h, name(k), lines(recs))); return h }
  const live = homeOf(24), whole = await membership(live)
  for (let k = 2; k < 24; k += 3) assert.equal(whole.get(segs[k][3].id), whole.get(segs[k][Math.floor(k / 3) % 3].id), `segment ${k}: the summary in its session`)
  assert.deepEqual(whole, await membership(homeOf(24)), 'one build')
  // segment 16 rewritten with one more call: the build starts there, from the state part 15 kept
  segs[16].push(turn('messages', 0, 17, prose(900, 400), at(16, segs[16].length)))
  fs.unlinkSync(path.join(live, 'raw', `${name(16)}.ndjson`)); writeSegment(live, name(16), lines(segs[16]))
  assert.deepEqual(await membership(live), await membership(homeOf(24)), 'a middle segment rewritten')
  // segment 20 rewritten with a summary that carries only summary 17's own reply: the build replays parts 16 to 19 from part 15's state,
  // summary 17 among them, whose windows are read back from its record (rows.mjs headsAt); read wrong, it keeps its reply under no session
  const s17 = Math.floor(17 / 3) % 3, quote = summary(wire(s17), [prose(500 + 17, 400)], at(20, segs[20].length))
  segs[20].push(quote)
  fs.unlinkSync(path.join(live, 'raw', `${name(20)}.ndjson`)); writeSegment(live, name(20), lines(segs[20]))
  const replayed = await membership(live)
  assert.deepEqual(replayed, await membership(homeOf(24)), 'a replay over a compaction request')
  assert.equal(replayed.get(quote.id), replayed.get(segs[17][s17].id), 'the summary quoting summary 17 joins its session')
  writeSegment(live, name(24), lines(segs[24]))
  assert.deepEqual(await membership(live), await membership(homeOf(25)), 'a new segment')
})
