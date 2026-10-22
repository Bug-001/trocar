// test/query/session-stream.test.mjs — a session followed as it grows is answered as a process that never saw it answers it
// (RFC 3.5 §缓存按依赖失效 · 验收 15), also when a late record sorts before ones already reduced; and a subagent's cache break is
// taken against its own agent's previous call (3.5 §缓存按依赖失效: 车道按 agent 分).
//
// Generated sessions (test/query/big-session.mjs) on the wire axis (a whole context per request, Message Threads, Codex over
// WebSocket, Chat Completions whose subagents are told apart by order only) with subagents side by side whose calls end late.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { runQuery } from '../../src/query/named/index.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

// a context of another process: its own fs object is its own cache key (src/query/warm.mjs fsTag), so nothing it reduced is shared
const freshFs = () => ({ ...fs })
const session = (home, p, ctx = {}) => runQuery('session', p, { home, ...ctx })
// a note (`level`) is about the read that made it (3.5 读不全): a cold read indexed the segment, a warm one did not
const sansNotes = (d) => { const errors = d.errors.filter((e) => !e.level); return JSON.stringify({ ...d, ok: errors.length === 0, errors }) }

// A resident process polled as the board follows a growing session, against a reduction from scratch in a process that never saw it.
function follower(home, s) {
  const ctx = { fs: freshFs() }
  return async (n) => {
    const grown = await session(home, { id: s.id }, ctx)
    assert.equal(sansNotes(grown), sansNotes(await session(home, { id: s.id }, { fs: freshFs() })), 'the grown state answers what a reduction from scratch does')
    assert.equal(grown.records.length, n)
    return grown
  }
}

for (const wire of ['http', 'threads', 'ws', 'chat']) for (const subLanes of [4, 8]) {
  test(`a ${wire} session with ${subLanes} subagents side by side and late calls, followed as it grows, is the reduction from scratch`, async () => {
    const home = path.join(tmpDir('trocar-slate-'), '.trocar')
    const s = bigSession({ home, wire, growth: 1_500, subEvery: 2, subLanes, late: 6, subLen: 12, seed: subLanes })
    const same = follower(home, s)
    const written = () => fs.readFileSync(s.file, 'utf8').trim().split('\n').length
    s.append(12)
    await same(written())
    for (const k of [1, 2, 1, 5, 1]) { s.append(k); await same(written()) }
  })
}

// A call that sorts before calls already reduced IN ITS OWN LANE, and a subagent the harness names by neither agent id nor thread
// (its lane is told apart by order alone, so the session is reduced again): still the reduction from scratch.
test('a late call in its own lane, and one in a lane told apart by order, answer as a reduction from scratch', async () => {
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
  assert.equal(doc.calls[6].ts, earlier(5), 'the late call takes its place in step order')
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

// Codex subagents side by side, each on its own WebSocket connection (one connection = one agent): a subagent's call is compared with
// its OWN previous call (3.5 §缓存按依赖失效), so the prefix it keeps grows with its own conversation — not with whichever subagent
// called last. A flat wire's subagents show as one lane (3.5), their turns taken in turn: call i is agent i % k's.
test('subagents side by side on a WebSocket each: a call\'s cache break is against its own agent\'s previous call', async () => {
  const home = path.join(tmpDir('trocar-sagent-'), '.trocar')
  const k = 3
  const s = bigSession({ home, wire: 'ws', growth: 1_500, subEvery: 2, subLanes: k, subLen: 100 })
  s.append(40)
  const doc = await session(home, { id: s.id }, { fs: freshFs() })
  const lane = doc.lanes.find((l) => l.kind === 'subagent').lane
  const sub = doc.calls.filter((r) => r.lane === lane)
  for (let i = k; i < sub.length; i++) {
    assert.equal(sub[i].cacheBreak.refRid, sub[i - k].rid, `subagent call ${i}: compared with its own agent's previous call`)
    assert.ok(sub[i].cacheBreak.idx > sub[i - k].cacheBreak.idx, `subagent call ${i} keeps more than its agent's previous call did`)
  }
})
