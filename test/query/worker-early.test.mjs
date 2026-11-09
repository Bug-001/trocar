// test/query/worker-early.test.mjs — while the worker's boot pass re-indexes every segment (3.5 §行表先读, D78②), a session that the
// segments read so far name the way the full list will (a session key, no chain) is answered from them, the newest segment first, and says
// that capture files are still being re-indexed; once the pass ends it is the one-pass answer. A session a rule decides (a synthesized key)
// waits for the pass. The real service and the real worker fork over a temp HOME with no index on disk (what an INDEX_V change leaves); the
// older segments' raw opens are held until the test releases them (worker-early-deps.mjs, in the worker and in its index threads), so the
// pass cannot end before the early answers, at any pool size and any load, while the newest segment is quick: what comes first is asserted
// by the order of the answer and the worker's `{rows: true}`, not by a time.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQueryService } from '../../src/query/service.mjs'
import { indexDir, segmentFiles } from '../../src/query/index-build.mjs'
import { indexRows, provisionalRows, sessionGroups } from '../../src/query/rows.mjs'
import { readHead } from '../../src/query/ctx-files.mjs'
import { markOn, sinceAt } from '../../src/query/named/session.mjs'
import { validateQueryDoc } from '../../src/cli/schema.mjs'
import { workerFork, workerForkIn } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { listed } from '../helpers/head-done.mjs'

const DEPS = fileURLToPath(new URL('./worker-early-deps.mjs', import.meta.url))
const K = 'early-kkkk-4a1b-9c2d-000000000001', L = 'early-llll-4a1b-9c2d-000000000002'
const S0 = '20261020T164700Z', NEWEST = '20261020T164712Z'

const recorder = () => {
  const r = { status: null, chunks: [] }
  return Object.assign(r, { writeHead: (s) => { r.status = s }, write: (b) => { r.chunks.push(b); return true }, end: () => {}, once: () => {}, text: () => Buffer.concat(r.chunks).toString('utf8') })
}
const ask = async (svc, name, params = {}) => {
  const res = recorder()
  await within(svc.relay({ name, params, res }), 60_000, `${name} answered`)
  return { status: res.status, doc: JSON.parse(res.text()) }
}
const until = (ok, what) => { let t; return within(new Promise((d) => { t = setInterval(() => ok() && (clearInterval(t), d()), 20) }), 60_000, what, () => clearInterval(t)) }
const rowsSaid = (said) => said.some((m) => m.rows === true)

// a keyless Hermes call (3.4 合成键): its session is the synthesized-key rule's
const hermes = (n) => {
  const ts = new Date(Date.parse('2026-10-20T17:00:00Z') + n * 4_000).toISOString(), messages = [{ role: 'system', content: 'You are Hermes.' }]
  for (let i = 0; i <= n; i++) { messages.push({ role: 'user', content: `q${i}` }); if (i < n) messages.push({ role: 'assistant', content: `a${i}` }) }
  return JSON.stringify({ ts, endpoint: '/v1/chat/completions', method: 'POST', req_headers: { host: 'llm.internal.test', 'content-type': 'application/json' },
    req_body: JSON.stringify({ model: 'mock-model', messages }),
    resp: { status: 200, kind: 'json', body: { id: `c${n}`, object: 'chat.completion', model: 'mock-model', choices: [{ index: 0, message: { role: 'assistant', content: `a${n}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } } },
    id: `req-hermes-${n}`, ts_request: ts, ts_response_start: ts, ts_response_end: ts, duration_ms: 100,
    is_llm_call: true, capture: 'transparent', host: 'llm.internal.test', traffic_class: 'llm', proc: { pid: 5151, exe: '/x/hermes', agent: 'hermes' } })
}

// a Kimi Code call with its body key (3.4): its session is that key, but its lane the chain rule's (chainLane 'aux')
const KIMI = 'early-kimi-user-0001'
const kimi = (n) => {
  const ts = new Date(Date.parse('2026-10-20T17:10:00Z') + n * 4_000).toISOString(), messages = []
  for (let i = 0; i <= n; i++) { messages.push({ role: 'user', content: `k${i}` }); if (i < n) messages.push({ role: 'assistant', content: `b${i}` }) }
  return JSON.stringify({ ts, endpoint: '/coding/v1/messages', method: 'POST', req_headers: { host: 'api.kimi.com', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    req_body: JSON.stringify({ model: 'mock-model', max_tokens: 64, system: 'You are Kimi Code.', metadata: { user_id: KIMI }, messages }),
    resp: { status: 200, kind: 'json', body: { id: `m${n}`, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: `b${n}` }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 2 } } },
    id: `req-kimi-${n}`, ts_request: ts, ts_response_start: ts, ts_response_end: ts, duration_ms: 100,
    is_llm_call: true, capture: 'transparent', host: 'api.kimi.com', traffic_class: 'llm', proc: { pid: 5252, exe: '/x/kimi', agent: 'kimi-code' } })
}

/** Twelve segments: L's first calls in the oldest, ten others' between, and in the newest (live) one L's later calls, K's and a Hermes
 *  task's. No index on disk. → {home, H}: H the Hermes task's synthesized session id. */
async function world() {
  const home = path.join(tmpDir('trocar-early-'), '.trocar')
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true, mode: 0o700 })
  const l = bigSession({ home, id: L, segment: S0 })
  l.append(6); await l.seal()
  for (let i = 0; i < 10; i++) {
    const s = bigSession({ home, id: `early-f${String(i).padStart(3, '0')}-4a1b-9c2d-000000000003`, segment: `20261020T1647${String(2 + i).padStart(2, '0')}Z` })
    s.append(3); await s.seal()
  }
  while (!l.file.includes(NEWEST)) await l.seal()
  l.append(6)
  bigSession({ home, id: K, segment: NEWEST }).append(6)
  fs.appendFileSync(path.join(home, 'raw', `${NEWEST}.ndjson`), [...[0, 1, 2].map(hermes), ...[0, 1].map(kimi)].join('\n') + '\n')
  const groups = sessionGroups(await indexRows({ home }))
  const H = [...groups.keys()].find((id) => id.startsWith('synth-hermes-'))
  assert.ok(H && groups.get(L).length === 12 && groups.get(K).length === 6, 'the world is as described')
  assert.ok(groups.get(KIMI).length === 2 && groups.get(KIMI).every((r) => r.synth_hash != null), 'Kimi\'s keyed calls carry a chain')
  assert.ok(groups.get(L).some((r) => r.segment === S0) && groups.get(L).some((r) => r.segment === NEWEST), 'L spans the oldest and the newest segment')
  fs.rmSync(indexDir(home), { recursive: true, force: true })
  return { home, H }
}
const twin = (home) => {
  const other = path.join(tmpDir('trocar-early-twin-'), '.trocar')
  fs.cpSync(home, other, { recursive: true })
  return other
}
/** A service whose worker's boot pass is held (worker-early-deps.mjs): the older segments' raw opens wait until `release()`. */
function service(home, held) {
  const said = [], hold = path.join(tmpDir('trocar-early-hold-'), 'hold')
  if (held) fs.writeFileSync(hold, '')
  const fork = held ? workerForkIn({ TROCAR_TEST_RAW_FAST: NEWEST, TROCAR_TEST_RAW_HOLD: hold }) : workerFork
  const watched = (h) => { const c = held ? fork(h, DEPS) : fork(h); c.on('message', (m) => said.push(m)); return c }
  return { said, svc: createQueryService({ home, fork: watched }), release: () => fs.rmSync(hold, { force: true }) }
}
const folded = (home, id) => { const h = readHead(home, id); return !!h && h.tier === 1 && h.pending == null && listed(h) }
/** Asks for the session until its head says it is folded to its end. */
async function settle(svc, home, id) {
  for (let i = 0; i < 300 && !folded(home, id); i++) { await ask(svc, 'session', { id }); await new Promise((r) => setTimeout(r, 100)) }
  assert.ok(folded(home, id), `${id} folded`)
}
const noRef = (k, v) => (k === 'ref' ? undefined : v)
const refsOf = (doc) => { const out = []; JSON.stringify(doc, (k, v) => { if (k === 'ref' && typeof v === 'string') out.push(v); return v }); return out }
const pendingOf = (doc) => (doc.errors || []).filter((e) => e.code === 'index-pending')

test('3.5 §行表先读: a keyed session in the newest segment is answered before the pass ends, says capture files are still re-indexed, and then is the one-pass answer', async () => {
  const { home } = await world()
  const one = twin(home)
  const { said, svc, release } = service(home, true)
  const ref = service(one, false)
  try {
    const first = await ask(svc, 'session', { id: K })
    assert.equal(rowsSaid(said), false, 'answered while the pass still reads')
    assert.equal(first.status, 200)
    assert.deepEqual(pendingOf(first.doc).map((e) => e.level), ['state'], 'it says capture files are still being re-indexed')
    assert.equal(first.doc.ok, true, 'a state, not a read that failed: `trocar query` exits as for any document (src/cli/query.mjs)')
    assert.deepEqual(validateQueryDoc(first.doc), [])
    assert.equal(pendingOf(readHead(home, K)).length, 1, 'the head says it too (the board reads it there)')
    const early = await ask(svc, 'session', { id: L })
    assert.equal(rowsSaid(said), false, 'answered while the pass still reads')
    assert.equal(early.status, 200)
    assert.deepEqual(early.doc.records.map((r) => String(r.id).split(':')[0]), Array(6).fill(NEWEST), 'L as far as the newest segment holds it')
    release()
    await until(() => rowsSaid(said), 'the pass ended')
    // asked nothing since: the worker's own slices bring the head to the pass's end
    await until(() => { const h = readHead(home, K); return !!h && !pendingOf(h).length }, 'K\'s head no longer says it')
    // older members came before L's early mark: a delta from it is no delta, the whole answer (3.5 §行表先读「先答的会话」)
    assert.equal((await ask(svc, 'session', { id: L, since: early.doc.mark })).doc.base, null, 'no delta from an early mark')
    for (const id of [K, L]) {
      await settle(svc, home, id)
      await settle(ref.svc, one, id)
      const [a, b] = [await ask(svc, 'session', { id }), await ask(ref.svc, 'session', { id })]
      assert.deepEqual(pendingOf(a.doc), [], 'the note is gone once the pass ended')
      assert.deepEqual(a.doc, b.doc, `${id}: the one-pass answer`)
      const lane = a.doc.lanes[0].lane
      // a block met first in a newer record names that copy (as a call written late does, 4.3 §上下文投影): the same bytes, by its digest and its text
      const [x, y] = [(await ask(svc, 'lane', { id, lane })).doc, (await ask(ref.svc, 'lane', { id, lane })).doc], xs = refsOf(x), ys = refsOf(y)
      assert.deepEqual(JSON.parse(JSON.stringify(x, noRef)), JSON.parse(JSON.stringify(y, noRef)), `${id}: the one-pass lane`)
      assert.equal(xs.length, ys.length)
      for (let i = 0; i < xs.length; i++) assert.deepEqual(typeof (await ask(svc, 'block', { ref: xs[i] })).doc.blocks[0].bytes, 'string')
      for (let i = 0; i < xs.length; i++) assert.deepEqual((await ask(svc, 'block', { ref: xs[i] })).doc.blocks[0].bytes, (await ask(ref.svc, 'block', { ref: ys[i] })).doc.blocks[0].bytes, `${xs[i]}: the bytes of ${ys[i]}`)
      assert.deepEqual(readHead(home, id), readHead(one, id), `${id}: the one-pass head`)
    }
  } finally { svc.stop(); ref.svc.stop() }
})

test('3.5 §行表先读: a session the synthesized-key rule decides waits for the pass, even when its calls are all read', async () => {
  const { home, H } = await world()
  const { said, svc, release } = service(home, true)
  try {
    assert.equal((await ask(svc, 'session', { id: K })).status, 200, 'the newest segment is read')
    assert.equal(rowsSaid(said), false)
    release()
    const { status } = await ask(svc, 'session', { id: H })
    assert.equal(rowsSaid(said), true, 'answered only once the pass ended')
    assert.equal(status, 200)
  } finally { svc.stop() }
})

test('provisionalRows: only a keyed row with no chain has a session; the rest is the full list\'s alone', async () => {
  const { home, H } = await world()
  const full = sessionGroups(await indexRows({ home }))
  const { rows, errors } = await provisionalRows({ home, ready: new Set([NEWEST]) })
  const early = sessionGroups(rows)
  assert.deepEqual([...early.keys()].sort(), [K, L].sort())
  assert.deepEqual(early.get(K).map((r) => r.id), full.get(K).map((r) => r.id))
  assert.equal(full.has(H) && full.has(KIMI), true)
  assert.deepEqual(errors.map((e) => [e.where, e.code]), [['index', 'index-pending']])
  // every segment read, the full list not built yet: still a provisional answer, and it says so
  assert.deepEqual((await provisionalRows({ home, ready: new Set(segmentFiles(home).map(([s]) => s)) })).errors.map((e) => [e.code, e.level]), [['index-pending', 'state']])
  assert.equal(await provisionalRows({ home: twin(home), ready: new Set([NEWEST]) }), null, 'a ready segment not usable now: no list, never one short of it')
})

test('3.5 id: an early plan\'s mark names it, so no other plan takes a delta from it; a cut and an early plan both say so', () => {
  const plan = (o) => ({ start: 0, read: [], first: 'S:1', early: false, ...o })
  const early = plan({ early: true }), full = plan(), cut = plan({ start: 4, read: [{ id: 'S:9' }] }), both = plan({ start: 4, read: [{ id: 'S:9' }], early: true })
  assert.equal(markOn(full, 'S:20'), 'S:20')
  assert.equal(sinceAt(early, markOn(early, 'S:20')), 'S:20', 'the early plan takes its own mark')
  assert.equal(sinceAt(full, markOn(early, 'S:20')), null, 'the full list does not')
  assert.equal(sinceAt(early, markOn(full, 'S:20')), null)
  assert.equal(sinceAt(cut, markOn(both, 'S:20')), null, 'a cut early plan is not the cut full one')
  assert.equal(sinceAt(both, markOn(both, 'S:20')), 'S:20')
})
