// test/query/session-read.test.mjs — `session` over the context projection (RFC 3.5 §会话读; 1.6 §4.1 / C.5): its pages (#5), its
// `--since` delta against the document at a mark (#19), its answer at the extraction frontier (#25), and the byte-identity flag of a
// cache break served on a row (3.3:75, 3.3 #12).
//
// Sessions are generated (test/query/big-session.mjs) into temp homes and read through runQuery as every path reads them. A second
// "process" is the same code with its own fs object (src/query/warm.mjs fsTag: nothing warm is shared), so a delta made from the
// marks a state kept and one reduced afresh are compared.
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

const homeOf = (p) => path.join(tmpDir(p), '.trocar')
const session = (home, params, ctx = {}) => runQuery('session', params, { home, fs, ...ctx })
const KEYS = ['base', 'mark', 'pending', 'truncated', 'more', 'meta', 'stats', 'logged', 'probes', 'lanes', 'calls', 'events', 'records']
const canon = (d) => JSON.stringify(Object.fromEntries(KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])))
const byStep = (a, b) => compareStep(a.ts, a.rid, b.ts, b.rid)

// apply(full(M), since(M)) as a client does it (3.5 §会话读): rows replaced by rid, `gone` dropped, inserted in step order; lane
// headers replaced by key, `lanes_gone` dropped, a lane placed by its first row; a delta row's events and record replace the held ones.
function apply(full, d) {
  const touched = new Set([...d.calls.map((r) => r.rid), ...d.gone])
  const rows = new Map(full.calls.map((r) => [r.rid, r]))
  for (const rid of d.gone) rows.delete(rid)
  for (const r of d.calls) rows.set(r.rid, r)
  const calls = [...rows.values()].sort(byStep), at = new Map(calls.map((r, i) => [r.rid, i]))
  const place = (rid) => at.get(rid) ?? Infinity
  const lanes = new Map(full.lanes.map((l) => [l.lane, l]))
  for (const k of d.lanes_gone) lanes.delete(k)
  for (const l of d.lanes) lanes.set(l.lane, l)
  const events = [...full.events.filter((e) => !touched.has(e.rid)), ...d.events].map((e, i) => [e, i])
    .sort((a, b) => place(a[0].rid) - place(b[0].rid) || a[1] - b[1]).map(([e]) => e)
  const records = [...full.records.filter((r) => !touched.has(r.id)), ...d.records].sort((a, b) => compareStep(a.ts_request, a.id, b.ts_request, b.id))
  const { base, more } = full, { mark, pending, truncated, meta, stats, logged, probes } = d
  return { base, mark, pending, truncated, more, meta, stats, logged, probes,
    lanes: [...lanes.values()].sort((a, b) => place(a.first) - place(b.first)), calls, events, records }
}

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
      assert.equal(canon(afresh), canon(d), 'the document at M reduced afresh in another process gives the same delta')
      full = now
    }
    for (const unknown of ['20990101T000000Z:1', 'not-a-rid']) {
      const d = await session(home, { id: s.id, since: unknown })
      assert.equal(d.base, null)
      assert.equal(canon(d), canon(full), `an unknown mark (${unknown}) answers the full document`)
    }
  })
}

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
