// test/query/session-read.test.mjs — `session` over the context projection and its fold log (RFC 3.5 §会话读; 1.6 §4.1 / C.5): its
// pages and their records (#5), its `--since` delta against the document at a mark (#19), its answer at the reduction frontier
// (#25), `unknown` (C1), the local path over a fold log the worker wrote (3.5:42), and the byte-identity flag of a cache break
// served on a row (3.3:75, 3.3 #12).
//
// Sessions are generated (test/query/big-session.mjs) into temp homes and read through runQuery as every path reads them. A second
// "process" is the same code with its own fs object (src/query/warm.mjs fsTag: nothing warm is shared).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery, QueryArgError } from '../../src/query/named/index.mjs'
import { compareStep } from '../../src/view/step-order.mjs'
import { run as runQueryCli } from '../../src/cli/query.mjs'
import { EXIT } from '../../src/cli/schema.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { extendSession, markOn, sinceAt } from '../../src/query/named/session.mjs'
import { foldLogFile } from '../../src/query/fold-log.mjs'
import { apply, canon, byStep } from '../helpers/session-apply.mjs'
import { BLOCK_PROBLEMS, SESSION_PROBLEMS } from '../../src/health/codes.mjs'

const homeOf = (p) => path.join(tmpDir(p), '.trocar')
const session = (home, params, ctx = {}) => runQuery('session', params, { home, fs, ...ctx })

/** `trocar query session …` as the command line runs it → its exit code. */
async function cliExit(home, flags) {
  const io = { out: () => {}, err: () => {}, stdout: { isTTY: false }, stderr: {}, stdin: { isTTY: false } }
  return runQueryCli([], { io, json: false, args: { positionals: ['session'], flags }, home: path.dirname(home), env: {}, platform: process.platform, deps: {} })
}

test('3.5 #5: the newest page without --before; --before pages walk every row once, each ≤ 1 MB and ≥ 1 row; bad windows are refused', async () => {
  const home = homeOf('trocar-sread-')
  const s = bigSession({ home, growth: 300, subEvery: 3, compactAt: 3_000 })
  s.append(40)
  const all = await session(home, { id: s.id })
  assert.equal(all.base, null)
  assert.equal(all.more, false)
  assert.deepEqual([...all.calls].sort(byStep), all.calls, 'rows in step order')
  for (const limit of [1, 7, 40]) {
    const seen = []
    let page = await session(home, { id: s.id, limit: String(limit) })
    assert.deepEqual(page.calls.map((r) => r.rid), all.calls.slice(-page.calls.length).map((r) => r.rid), 'no --before: the newest page')
    for (;;) {
      assert.ok(page.calls.length >= 1 && page.calls.length <= limit, `limit ${limit}: a page holds 1..limit rows`)
      assert.ok(page.calls.length === 1 || Buffer.byteLength(JSON.stringify(page.calls)) <= 1048576, 'a page is ≤ 1 MB of rows')
      seen.unshift(...page.calls.map((r) => r.rid))
      if (!page.more) break
      page = await session(home, { id: s.id, limit: String(limit), before: page.calls[0].rid })
    }
    assert.deepEqual(seen, all.calls.map((r) => r.rid), `limit ${limit}: every row exactly once, \`more\` false only on the oldest page`)
  }
  for (const bad of [{ limit: '1001' }, { limit: '0' }, { since: all.mark, before: all.calls[0].rid }, { before: 'not-a-row:1' }]) {
    await assert.rejects(session(home, { id: s.id, ...bad }), QueryArgError, JSON.stringify(bad))
    assert.equal(await cliExit(home, { id: s.id, ...bad }), EXIT.usage, `${JSON.stringify(bad)}: exit 2 on the command line`)
  }
})

// The late axis (big-session `late` / `subLanes`): a subagent's call written after calls that started after it, in its own lane
// (one subagent at a time) or among other lanes (several side by side); 'chat' tells its subagents apart by order only.
const LATE = [{ late: 0, subLanes: 1 }, { late: 8, subLanes: 1 }, { late: 8, subLanes: 4 }]
for (const wire of ['http', 'chat', 'ws']) for (const arrival of LATE) {
  test(`3.5 #19: ${wire} late ${arrival.late} × ${arrival.subLanes} lanes — apply(full(M), since(M)) is full(now), byte for byte`, async () => {
    const home = homeOf('trocar-sread-')
    const s = bigSession({ home, wire, growth: 200, subEvery: 2, compactAt: 1_500, ...arrival })
    s.append(6)
    let full = await session(home, { id: s.id })
    const same = await session(home, { id: s.id, since: full.mark })
    assert.deepEqual([same.base, same.calls, same.gone, same.lanes, same.lanes_gone], [full.mark, [], [], [], []], 'nothing new since the mark: an empty delta')
    for (const more of [1, 2, 5, 3, 4, 6]) {
      s.append(more)
      const M = full.mark
      const d = await session(home, { id: s.id, since: M })
      const now = await session(home, { id: s.id })
      assert.equal(d.base, M)
      assert.equal(canon(apply(full, d)), canon(now), `after ${more} more`)
      const afresh = await session(home, { id: s.id, since: M }, { fs: { ...fs } })
      assert.equal(JSON.stringify(afresh), JSON.stringify(d), 'a process with no warm state (the fallback) gives the same delta, byte for byte')
      full = now
    }
    for (const unknown of ['20990101T000000Z:1', 'not-a-rid', `${full.mark}@${full.calls[0].rid}`]) { // the last: a cut this uncut session is not under
      const d = await session(home, { id: s.id, since: unknown })
      assert.equal(d.base, null)
      assert.equal(canon(d), canon(full), `an unknown mark (${unknown}) answers the full document`)
    }
  })
}

// 3.5:58 / #19 when the cut moves: members at or before M enter or leave the cut and no delta carries them, so a mark names the cut
// its document was answered under and a --since M under another cut is not known (the full document). Growing a session past a
// small heap's room until its cut moves is minutes of work (test/query/past-room.mjs), so the rule is held at the seam that decides.
test('3.5 #19 moved cut: a mark names its cut; --since a mark of another cut (or none) is not known, of the same cut is its rid', () => {
  const plans = [{ start: 0, read: [{ id: 'seg:1' }] }, { start: 3, read: [{ id: 'seg:4' }] }, { start: 3, read: [{ id: 'seg:2' }] }, { start: 6, read: [{ id: 'seg:7' }] }]
  for (const [a, then] of plans.entries()) for (const [b, now] of plans.entries()) {
    const M = markOn(then, 'seg:9')
    assert.equal(markOn(then, null), null, 'an empty session has no mark')
    assert.equal(sinceAt(now, M), a === b || (!then.start && !now.start) ? 'seg:9' : null, `${M} under plan ${b}`)
  }
  assert.equal(markOn(plans[0], 'seg:9'), 'seg:9', 'an uncut session\'s mark is the bare rid')
})

// A Claude Code session whose calls are interleaved with members that are no call: requests of no LLM, and (`unknown`) LLM
// requests to an endpoint no dissector reads as a call (C1): after each of the first `unknown` calls, and `lead` of them before the
// first call; `late`: some members that are no call carry a ts_request before the call written before them (step order ≠ file
// order). Seeded: how many follow each call, which are late. → {id, endpoints, lines, file (the whole file written), back (how many late)}.
function mixed(home, { calls, unknown = 0, lead = 0, late = false, seed = 7 }) {
  const id = `mix${seed}000-0000-4a1b-9c2d-000000000001`, lines = []
  const hdr = { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': id }
  let r = seed, t = Date.parse('2026-10-22T10:00:00.000Z'), call = null, back = 0
  const rand = (n) => { r = (r * 1103515245 + 12345) % 2147483648; return r % n }
  const rec = (endpoint, method, llm, body, resp) => {
    const ts = new Date(t += 1000).toISOString(), early = !llm && late && call != null && rand(2) === 0
    if (llm) call = t
    if (early) back++
    lines.push(JSON.stringify({ ts, endpoint, method, req_headers: hdr, req_body: body, resp: { status: 200, kind: 'json', body: resp }, id: `r_${lines.length}`, ts_request: early ? new Date(call - 500).toISOString() : ts,
      is_llm_call: llm, capture: 'transparent', host: 'api.anthropic.com', traffic_class: llm ? 'llm' : 'other', proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' } }))
  }
  const ends = []
  const unk = (n) => { const e = `/v1/mystery/${n % 2}`; ends.push(e); rec(e, 'POST', true, JSON.stringify({ model: 'mystery-1', input: 'x' }), { ok: true }) }
  for (let n = 0; n < lead; n++) { unk(n); rec('/api/other/1', 'GET', false, '', { ok: true }) }
  for (let n = 0; n < calls; n++) {
    rec('/v1/messages', 'POST', true, JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 9, messages: [{ role: 'user', content: [{ type: 'text', text: `turn ${n}` }] }] }),
      { id: `msg_${n}`, model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } })
    for (let k = rand(3); k > 0; k--) rec(`/api/other/${rand(5)}`, 'GET', false, '', { ok: true })
    if (n < unknown) unk(n)
  }
  const file = path.join(home, 'raw', '20261022T100000Z.ndjson')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return { id, endpoints: [...new Set(ends)], lines, file, back }
}
const stepRec = (a, b) => compareStep(a.ts_request, a.id, b.ts_request, b.id)

test('3.5 #5: --before a member that is no call row is refused; walking --before pages, each page\'s records are the members in its span, every member once', async () => {
  for (const seed of [3, 11]) {
    const home = homeOf('trocar-sread-mix-'), m = mixed(home, { calls: 30, unknown: 3, seed })
    const members = sessionGroups(await indexRows({ home, fs, errors: [] })).get(m.id)
    const all = await session(home, { id: m.id })
    const rows = new Set(all.calls.map((r) => r.rid)), item = members.find((r) => !rows.has(String(r.id)))
    assert.ok(item, 'the session has a member that is no call row')
    await assert.rejects(session(home, { id: m.id, before: String(item.id) }), QueryArgError)
    assert.equal(await cliExit(home, { id: m.id, before: String(item.id) }), EXIT.usage, '--before a member that is no call row: exit 2')
    for (const limit of [1, 4]) {
      const seen = []
      let page = await session(home, { id: m.id, limit: String(limit) })
      for (;;) {
        // its span: after the row before it (the last row of the next older page), up to its last row (the newest page: no end)
        const last = page.calls.at(-1), older = page.more ? await session(home, { id: m.id, limit: String(limit), before: page.calls[0].rid }) : null
        const lo = older && older.calls.at(-1), newest = seen.length === 0
        for (const rec of page.records) {
          if (!newest) assert.ok(stepRec(rec, { ts_request: last.ts, id: last.rid }) <= 0, `limit ${limit}: a page's record is not after its last row`)
          if (lo) assert.ok(stepRec(rec, { ts_request: lo.ts, id: lo.rid }) > 0, `limit ${limit}: a page's record is after the row before it`)
        }
        seen.unshift(...page.records.map((r) => r.id))
        if (!older) break
        page = older
      }
      assert.deepEqual(seen, members.map((r) => ({ id: String(r.id), ts_request: r.ts })).sort(stepRec).map((r) => r.id), `limit ${limit}: every member exactly once, in step order`)
    }
  }
})

test('C1: records no dissector reads as a call are counted with their endpoints in `unknown`; a session with none has no `unknown`', async () => {
  for (const unknown of [0, 1, 4]) {
    const home = homeOf('trocar-sread-unk-'), m = mixed(home, { calls: 6, unknown })
    const doc = await session(home, { id: m.id })
    if (!unknown) { assert.equal('unknown' in doc, false); continue }
    assert.equal(doc.unknown.records, unknown)
    assert.deepEqual([...doc.unknown.endpoints].sort(), m.endpoints.sort())
  }
})

test('3.5 #19 unknown: over sessions whose `unknown` records come before, among and after the first rows, and members that are no call written after a call they step before, apply(full(M), since(M)) is full(now) with `unknown`, on the local path and the worker\'s shared log', async () => {
  for (const writer of [false, true]) for (const seed of [1, 5]) for (const by of [1, 4]) for (const lead of [0, 3]) for (const unknown of [0, 4]) for (const late of [false, true]) {
    const home = homeOf('trocar-sread-unkd-'), m = mixed(home, { calls: 12, unknown, lead, late, seed }), ctx = { fs: { ...fs }, writer }
    const q = async (params) => { if (writer) while (await extendSession({ home, ...ctx }, m.id, Infinity)); return session(home, { id: m.id, ...params }, ctx) }
    assert.equal(m.back > 0, late, 'late: some members that are no call step before the call written before them')
    let upTo = 1, step = seed
    fs.writeFileSync(m.file, m.lines.slice(0, upTo).join('\n') + '\n')
    let full = await q({})
    while (upTo < m.lines.length) {
      const more = 1 + (step++ % by) // one member at a time: a first row arrives with no record past M that no dissector read
      fs.appendFileSync(m.file, m.lines.slice(upTo, upTo + more).join('\n') + '\n')
      upTo += more
      const d = await q({ since: full.mark }), now = await q({})
      assert.equal(canon(apply(full, d)), canon(now), `writer ${writer} seed ${seed} by ${by} lead ${lead} unknown ${unknown} late ${late}: ${upTo} lines`)
      full = now
    }
    if (lead + unknown) assert.ok(full.unknown, 'the session ends with `unknown`')
  }
})

// An fs that fails the read-back of one record (at its own offset), as a record that cannot be read again would.
function failingAt(row) {
  return { ...fs, readSync: (fd, buf, off, len, pos) => { if (pos === row.offset - 1 && len === row.stored_bytes + 2) throw new Error('EIO'); return fs.readSync(fd, buf, off, len, pos) } }
}
test('3.5 #25: with members above the frontier the answer is the document at the mark and carries pending; none once all are extracted, a failed member included', async () => {
  const home = homeOf('trocar-sread-')
  const s = bigSession({ home, growth: 4_000, subEvery: 3, compactAt: 40_000, subLanes: 3, late: 2 })
  s.append(160)
  const members = sessionGroups(await indexRows({ home, fs, errors: [] })).get(s.id)
  const lost = members[Math.floor(members.length / 3)]
  const rfs = failingAt(lost)
  let doc, partial = 0
  for (let i = 0; i < 400; i++) {
    doc = await session(home, { id: s.id }, { fs: rfs, writer: true })
    if (!doc.pending) break
    partial++
    assert.ok(doc.pending.done < doc.pending.total, 'pending: members above the mark')
    // the document at the mark: the same raw cut after the mark, read in a home of its own (meta counts every member: left out)
    const at = homeOf('trocar-sread-at-')
    fs.mkdirSync(path.join(at, 'raw'), { recursive: true })
    const lines = fs.readFileSync(s.file, 'utf8').split('\n'), upTo = Number(doc.mark.split(':')[1])
    fs.writeFileSync(path.join(at, 'raw', path.basename(s.file)), lines.slice(0, upTo).join('\n') + '\n')
    const want = await session(at, { id: s.id }, { fs: failingAt(lost) })
    const strip = (d) => canon({ ...d, meta: null, pending: undefined })
    assert.equal(strip(doc), strip(want), `answer ${i}: the reduction over the members ≤ ${doc.mark}`)
  }
  assert.ok(partial > 0, 'the worker\'s 50 ms slices left members above the frontier at least once')
  assert.equal(doc.pending, undefined, 'no pending once every member is extracted, though one failed')
  assert.ok(!doc.calls.some((r) => r.rid === String(lost.id)), 'the failed member is not a row')
  assert.ok(doc.records.some((r) => r.id === String(lost.id)), 'it is among the records')
  assert.deepEqual(doc.errors.filter((e) => e.where === String(lost.id)).map((e) => e.code), ['record-unreadable'])
})

// An fs over which the first record read a second time (a block's text read back for a cache-break detail: extraction reads each
// record once) cannot be read from then on, as a record that went away after it was extracted.
function lostOnReread(rows) {
  const at = new Map(rows.map((r) => [`${r.offset - 1}:${r.stored_bytes + 2}`, String(r.id)])), seen = new Set(), lost = { rid: null }
  const rfs = { ...fs, readSync: (fd, buf, off, len, pos) => {
    const rid = at.get(`${pos}:${len}`)
    if (rid != null && lost.rid == null && seen.has(rid)) lost.rid = rid
    if (rid != null && rid === lost.rid) throw new Error('EIO')
    if (rid != null) seen.add(rid)
    return fs.readSync(fd, buf, off, len, pos)
  } }
  return { rfs, lost }
}
test('3.5 #4: a block the reduction cannot read back fails its member with a closed-set code; the fold goes on and nothing crashes', async () => {
  const home = homeOf('trocar-sread-block-')
  const s = bigSession({ home, growth: 300, subEvery: 3, compactAt: 3_000 })
  s.append(40)
  const clean = homeOf('trocar-sread-block-clean-')
  fs.cpSync(path.join(home, 'raw'), path.join(clean, 'raw'), { recursive: true })
  const members = sessionGroups(await indexRows({ home, fs, errors: [] })).get(s.id)
  const { rfs, lost } = lostOnReread(members)
  const worker = { fs: rfs, writer: true }
  while (await extendSession({ home, ...worker }, s.id, Infinity));
  assert.ok(lost.rid != null, 'the fold read a block\'s text back')
  const full = await session(home, { id: s.id }, worker)
  const failed = full.errors.filter((e) => BLOCK_PROBLEMS.includes(e.code) && members.some((r) => String(r.id) === e.where)).map((e) => e.where)
  assert.ok(failed.length > 0, 'the member whose block did not read back is in errors')
  const since = await session(home, { id: s.id, since: String(members[1].id) }, worker)
  for (const doc of [full, since]) {
    assert.equal(doc.ok, false)
    for (const rid of failed) {
      const e = doc.errors.find((x) => x.where === rid)
      assert.ok(e && SESSION_PROBLEMS.includes(e.code) && BLOCK_PROBLEMS.includes(e.code), `${rid}: a closed-set code`)
    }
  }
  const want = (await session(clean, { id: s.id })).calls.map((r) => r.rid).filter((rid) => !failed.includes(rid))
  assert.deepEqual(full.calls.map((r) => r.rid), want, 'the failed members are no rows; every other call is')
  for (const h of full.lanes) assert.equal((await runQuery('lane', { id: s.id, lane: h.lane }, { home, ...worker })).command, 'lane')
  // a call appended later is folded and answered; another process answers from the fold log with the same bytes
  s.append(1)
  while (await extendSession({ home, ...worker }, s.id, Infinity));
  const after = await session(home, { id: s.id }, worker)
  const last = sessionGroups(await indexRows({ home, fs, errors: [] })).get(s.id).at(-1)
  assert.ok(after.calls.some((r) => r.rid === String(last.id)), 'the call appended later is a row')
  assert.equal(JSON.stringify(await session(home, { id: s.id }, { fs: { ...rfs }, writer: true })), JSON.stringify(after))
  // a member that failed stays failed until the fold log is rebuilt (3.5 §读不全不静默): a process whose block reads back rebuilds up
  // to the log's frontier for a call past it, and its answer still has the failed members out of every row and every lane count
  s.append(1)
  const healed = { fs: { ...fs }, writer: true }
  while (await extendSession({ home, ...healed }, s.id, Infinity));
  const later = await session(home, { id: s.id, limit: '1000' }, healed)
  assert.equal(later.lanes.reduce((a, h) => a + h.count, 0), later.calls.length, 'the lanes count the rows')
  assert.equal(later.stats.calls, later.calls.length, 'the stats count the rows')
  for (const rid of failed) {
    assert.ok(later.errors.some((e) => e.where === rid), `${rid} is still in errors`)
    assert.ok(!later.calls.some((r) => r.rid === rid), `${rid} is still no row`)
  }
})

test('3.5:42 local: over a fold log the worker finished, the local path answers the worker\'s bytes and leaves the log\'s bytes as they were', async () => {
  const home = homeOf('trocar-sread-local-')
  const s = bigSession({ home, growth: 2_000, subEvery: 3, compactAt: 20_000, subLanes: 2, late: 2 })
  s.append(40)
  const worker = { writer: true }
  await session(home, { id: s.id }, worker)
  while (await extendSession({ home, fs, ...worker }, s.id, Infinity));
  const w = await session(home, { id: s.id }, worker)
  assert.equal(w.pending, undefined)
  const file = foldLogFile(home, s.id), bytes = fs.readFileSync(file)
  const local = await session(home, { id: s.id }, { fs: { ...fs } })
  assert.equal(JSON.stringify(local), JSON.stringify(w), 'the local answer is the worker\'s, byte for byte')
  assert.ok(fs.readFileSync(file).equals(bytes), 'the fold log is as the worker left it')
})

// 3.3:75: the byte-identity of a reusable prefix compares each block's verbatim slice with its cache_control member cut out.
function twoCalls(home, id, second) {
  const sys = [{ type: 'text', text: 'You are a coding assistant.' }]
  const tools = [{ name: 'Read', description: 'Reads a file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }]
  const m1 = [{ role: 'user', content: [{ type: 'text', text: 'read a.mjs', cache_control: { type: 'ephemeral' } }] }]
  const m2 = [{ role: 'user', content: [{ type: 'text', text: 'read a.mjs' }] }, { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: 'now b.mjs', cache_control: { type: 'ephemeral' } }] }]
  const line = (n, body, usage) => JSON.stringify({
    ts: `2026-10-22T10:00:0${n}.000Z`, endpoint: '/v1/messages', method: 'POST',
    req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': id },
    req_body: body, resp: { status: 200, kind: 'json', body: { id: `msg_${n}`, model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage } },
    id: `req_${n}`, ts_request: `2026-10-22T10:00:0${n}.000Z`, is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm',
    proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' },
  })
  const body = (messages) => JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 1024, tools, system: sys, messages })
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(home, 'raw', '20261022T100000Z.ndjson'), [
    line(1, body(m1), { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 }),
    line(2, second(body(m2)), { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 950 }),
  ].join('\n') + '\n')
}
test('3.3 #12 served: only cache_control moved → the second row keeps gt; a tools schema differing only in whitespace → none', async () => {
  const cases = { moved: (b) => b, whitespace: (b) => b.replace('"input_schema":{"type":"object"', '"input_schema": {"type": "object"') }
  for (const [name, second] of Object.entries(cases)) {
    const home = homeOf('trocar-sread-gt-'), id = `gt-${name}-0000-4a1b-9c2d-000000000001`
    twoCalls(home, id, second)
    const doc = await session(home, { id })
    assert.equal(doc.calls.length, 2, name)
    const row = doc.calls[1]
    assert.ok(row.cacheBreak.idx > 0, `${name}: the second call reuses a prefix of the first`)
    if (name === 'moved') {
      assert.equal(row.gt, 'ttl-rebuild', 'a byte-identical prefix that read nothing from the cache: the ground truth says a rebuild')
      assert.equal(row.cacheBreak.gt, 'ttl-rebuild')
    } else {
      assert.equal(row.gt ?? null, null, 'whitespace differs: no byte-identity claim')
      assert.equal(row.cacheBreak.gt ?? null, null)
    }
  }
})
