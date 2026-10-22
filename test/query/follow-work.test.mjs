// test/query/follow-work.test.mjs — following a growing session costs work by its new members, not by its members (RFC 3.5 后台抽取与
// 归约 「一片的固定开销与一次回答的功夫不随成员数涨」「回答只读变了的那些的行」, D11; 内存有界 the kept lane ledger).
//
// The same generated session (calls, then half as many members that are no call) at N and at 4N calls, large enough that its fold
// log and its main lane's lists outgrow their caches, fully folded by the worker, which answers it and its main lane once; one new
// member that is no call is appended, then one new call. Each case runs over the segment index's real rows wrapped in Proxies that note
// which member rows had a property read, and over an fs that counts the bytes read from index/ctx/*.ndjson (the projection and the
// fold log). At 4N a case touches at most the rows it touches at N plus the new members, and reads at most the bytes it reads at N
// plus the new members' own lines (what the slices appended to those files): neither grows with the members.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { extendSession, version } from '../../src/query/named/session.mjs'

const OPTS = { growth: 2_000, compactAt: 20_000, subEvery: 4, subLanes: 3, late: 2, paths: 4 }
const CTX = /[\\/]index[\\/]ctx[\\/][^\\/]+\.ndjson$/
const ctxBytes = (home) => { const d = path.join(home, 'index', 'ctx'); return fs.readdirSync(d).filter((f) => f.endsWith('.ndjson')).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0) }
// k members that are no call, written after the calls and stamped within a second of the last record: requests of no LLM on the
// session's own headers (the last record's)
function nonCalls(file, k, from) {
  const last = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)).reverse().find((r) => r.req_headers)
  const out = []
  for (let n = from; n < from + k; n++) {
    const ts = new Date(Date.parse(last.ts_request) + n - from + 1).toISOString()
    out.push(JSON.stringify({ ...last, ts, ts_request: ts, ts_response_start: ts, ts_response_end: ts, id: `noncall-${n}`, endpoint: `/api/other/${n}`,
      method: 'GET', req_body: '', resp: { status: 200, kind: 'json', body: { ok: true } }, is_llm_call: false, traffic_class: 'other' }))
  }
  fs.appendFileSync(file, out.join('\n') + '\n')
}

async function workAt(calls) {
  const home = path.join(tmpDir('trocar-follow-'), '.trocar')
  const s = bigSession({ home, ...OPTS })
  s.append(calls)
  nonCalls(s.file, calls / 2, 0)
  // a worker of its own (nothing warm shared with another size: src/query/warm.mjs fsTag), over an fs that counts what it reads of
  // the projection and the fold log
  const fds = new Set(), touched = new Set()
  let counting = false, bytes = 0
  const own = { ...fs,
    openSync(p, ...a) { const fd = fs.openSync(p, ...a); if (CTX.test(String(p))) fds.add(fd); else fds.delete(fd); return fd },
    closeSync(fd) { fds.delete(fd); return fs.closeSync(fd) },
    readSync(fd, ...a) { const n = fs.readSync(fd, ...a); if (counting && fds.has(fd)) bytes += n; return n },
    readFileSync(p, ...a) { const b = fs.readFileSync(p, ...a); if (counting && CTX.test(String(p))) bytes += b.length; return b },
  }
  // the index's rows of now, each a Proxy noting a read of a member of the session; the session's groups made before counting
  const index = async () => {
    const rows = (await indexRows({ home, fs: own })).map((r) => new Proxy(r, {
      get(t, k) { if (counting && t.session_id === s.id) touched.add(String(t.id)); return t[k] },
      has(t, k) { if (counting && t.session_id === s.id) touched.add(String(t.id)); return k in t },
      ownKeys(t) { if (counting && t.session_id === s.id) touched.add(String(t.id)); return Reflect.ownKeys(t) },
    }))
    sessionGroups(rows)
    return { rows, members: sessionGroups(rows).get(s.id).length }
  }
  const ctxOf = (rows) => ({ home, fs: own, writer: true, once: { index: { rows, errors: [] } } })
  const count = async (work) => { touched.clear(); bytes = 0; counting = true; try { await work() } finally { counting = false } return { rows: touched.size, bytes } }
  const slices = (at) => count(async () => { while (await extendSession(ctxOf(at.rows), s.id, 50)); })

  let at = await index()
  while (await extendSession(ctxOf(at.rows), s.id, Infinity));
  const doc = await runQuery('session', { id: s.id }, ctxOf(at.rows))
  assert.equal(doc.pending, undefined, 'the session was folded whole')
  const main = doc.lanes.find((l) => l.kind === 'main').lane
  const lane = await runQuery('lane', { id: s.id, lane: main }, ctxOf(at.rows))
  const tip = lane.steps.at(-1).rid

  // one new member that is no call
  nonCalls(s.file, 1, calls / 2)
  at = await index()
  let was = ctxBytes(home)
  await slices(at)
  const itemLines = ctxBytes(home) - was
  let mark
  const item = await count(async () => {
    const d = await runQuery('session', { id: s.id, since: doc.mark }, ctxOf(at.rows))
    assert.equal(d.base, doc.mark, 'answered as a delta')
    assert.equal(d.pending, undefined)
    mark = d.mark
  })
  // one new call
  const before = at.members
  s.append(1)
  at = await index()
  const fresh = at.members - before
  assert.ok(fresh >= 1, 'the append added members')
  was = ctxBytes(home)
  const sliced = await slices(at)
  const callLines = ctxBytes(home) - was
  const since = await count(async () => {
    await version({ ...ctxOf(at.rows), params: { id: s.id } })
    const d = await runQuery('session', { id: s.id, since: mark }, ctxOf(at.rows))
    assert.equal(d.base, mark, 'answered as a delta')
    assert.equal(d.pending, undefined)
  })
  const from = await count(async () => {
    const d = await runQuery('lane', { id: s.id, lane: main, from: tip }, ctxOf(at.rows))
    assert.equal(d.base, tip, 'answered from the tip')
  })
  return { members: at.members, fresh, callLines, itemLines, slices: sliced, since, from, item }
}

let runs = null
const both = () => (runs ??= (async () => { const N = 300; return { a: await workAt(N), b: await workAt(4 * N) } })())

test('rows touched by background slices, `session --since` and `lane --from` after one new call do not grow with the members (3.5:42, D11)', { timeout: 300_000 }, async (t) => {
  const { a, b } = await both()
  t.diagnostic(JSON.stringify({ a, b }))
  assert.ok(b.members > 3 * a.members, 'the larger session has about four times the members')
  const over = ['slices', 'since', 'from'].filter((k) => b[k].rows > a[k].rows + b.fresh)
  assert.deepEqual(over, [], `member rows touched at ${a.members} / ${b.members} members (+${b.fresh} new): ${JSON.stringify({ a, b })}`)
})

test('bytes `session --since` (a new call, a new member that is no call) and `lane --from <tip>` read of the projection and the fold log do not grow with the members (3.5:42, 3.5:48, D12)', { timeout: 300_000 }, async () => {
  const { a, b } = await both()
  const own = { since: b.callLines, from: b.callLines, item: b.itemLines }
  const over = Object.keys(own).filter((k) => b[k].bytes > a[k].bytes + own[k])
  assert.deepEqual(over, [], `bytes read at ${a.members} / ${b.members} members: ${JSON.stringify({ a, b })}`)
})
