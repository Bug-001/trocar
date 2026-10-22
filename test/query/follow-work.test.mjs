// test/query/follow-work.test.mjs — following a growing session costs work by its new members, not by its members (RFC 3.5 后台抽取与
// 归约 「一片的固定开销与一次回答的功夫不随成员数涨」, D11).
//
// The same generated session at N and at 4N calls, fully folded by the worker; one new call is appended and then the worker's
// background slices, `session --since <mark>` and `lane --from <main lane tip>` each run over the segment index's real rows wrapped in
// Proxies that note which member rows had a property read. The rows each case touches at 4N are at most what it touches at N plus the
// new members: they do not grow with the members.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { extendSession, version } from '../../src/query/named/session.mjs'

const OPTS = { growth: 2_000, compactAt: 20_000, subEvery: 4, subLanes: 3, late: 2 }

async function touchedAt(calls) {
  const home = path.join(tmpDir('trocar-follow-'), '.trocar')
  const s = bigSession({ home, ...OPTS })
  s.append(calls)
  const own = { ...fs } // a worker of its own: nothing warm shared with another size (src/query/warm.mjs fsTag)
  const touched = new Set()
  let counting = false
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
  const count = async (work) => { touched.clear(); counting = true; try { await work() } finally { counting = false } return touched.size }

  let at = await index()
  while (await extendSession(ctxOf(at.rows), s.id, Infinity));
  const doc = await runQuery('session', { id: s.id }, ctxOf(at.rows))
  assert.equal(doc.pending, undefined, 'the session was folded whole')
  const main = doc.lanes.find((l) => l.kind === 'main').lane
  const lane = await runQuery('lane', { id: s.id, lane: main }, ctxOf(at.rows))
  const tip = lane.steps.at(-1).rid
  const before = at.members

  s.append(1)
  at = await index()
  const fresh = at.members - before
  assert.ok(fresh >= 1, 'the append added members')
  const slices = await count(async () => { while (await extendSession(ctxOf(at.rows), s.id, 50)); })
  const since = await count(async () => {
    await version({ ...ctxOf(at.rows), params: { id: s.id } })
    const d = await runQuery('session', { id: s.id, since: doc.mark }, ctxOf(at.rows))
    assert.equal(d.base, doc.mark, 'answered as a delta')
    assert.equal(d.pending, undefined)
  })
  const from = await count(async () => {
    const d = await runQuery('lane', { id: s.id, lane: main, from: tip }, ctxOf(at.rows))
    assert.equal(d.base, tip, 'answered from the tip')
  })
  return { members: at.members, fresh, slices, since, from }
}

test('rows touched by background slices, `session --since` and `lane --from` after one new call do not grow with the members (3.5:42, D11)', { timeout: 300_000 }, async (t) => {
  const N = 40
  const a = await touchedAt(N), b = await touchedAt(4 * N)
  t.diagnostic(JSON.stringify({ a, b }))
  assert.ok(b.members > 3 * a.members, 'the larger session has about four times the members')
  const over = ['slices', 'since', 'from'].filter((k) => b[k] > a[k] + b.fresh)
  assert.deepEqual(over, [], `member rows touched at ${a.members} / ${b.members} members (+${b.fresh} new): ${JSON.stringify({ a, b })}`)
})
