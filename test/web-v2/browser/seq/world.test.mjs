// world.test.mjs — the sequence harness's world as the real face reads it (no browser): every generated session is listed with its
// harness (W1), the Claude Code session carries the shapes the sequences poke at (1.5 K-08 subagents, K-12 failures, K-13
// compaction, an image block, a block past the display clip; W2), and grow() moves the server's main-lane count by exactly what the
// generator appended (W3); the http session opens on sealed packs and chapters and its tail seals as it grows (W4).
import test from 'node:test'
import assert from 'node:assert/strict'
import { HARNESSES } from '../../../../src/dissect/harnesses.mjs'
import { serveBoard } from '../../real-face.mjs'
import { makeWorld, mainCount, settled, HTTP_CALLS } from './world.mjs'
import { PACK_MEMBERS } from '../../../../src/query/ctx-files.mjs'
import { deskFrom } from '../../desk-world.mjs'

// the header each wire's generator keys its session by (test/query/big-session.mjs)
const KEY_HEADER = { http: 'x-claude-code-session-id', threads: 'x-claude-code-session-id', ws: 'session-id', chat: 'x-deepseek-harness-session-id' }
const harnessesKeyedBy = (h) => HARNESSES.filter((row) => row.sessionKeys.some((k) => k.from === 'header' && k.name.toLowerCase() === h)).map((row) => row.id)

async function allSessions(get) {
  const out = []
  let after = null
  for (let i = 0; i < 1000; i++) {
    const { status, doc } = await get('sessions', after != null ? { after } : {})
    assert.equal(status, 200)
    out.push(...doc.sessions)
    if (!doc.has_more) return out
    after = doc.next
  }
  throw new Error('sessions paging did not end')
}

test('W1 every generated session is listed with the harness its session-key header names', async () => {
  const world = makeWorld({ seed: 1 })
  const face = await serveBoard(world)
  try {
    const rows = new Map((await allSessions(face.get)).map((s) => [s.session_id, s]))
    for (const { id, wire } of world.sessions) {
      const row = rows.get(id)
      assert.ok(row, `${wire} session ${id} is listed`)
      assert.notEqual(row.harness, null, `${wire} has a harness`)
      assert.ok(harnessesKeyedBy(KEY_HEADER[wire]).includes(row.harness), `${wire}: ${row.harness}`)
    }
  } finally { await face.close() }
})

test('W2 the http session carries subagent lanes, a failed call, a compaction, an image block and a block past hugeBytes', async () => {
  const world = makeWorld({ seed: 2 })
  const face = await serveBoard(world)
  try {
    const id = world.sessions.find((s) => s.wire === 'http').id
    // the desk as the board reads it once the reduction has caught up: every row of `session`, every lane's pages (3.5 §会话读)
    await settled(face.get, id)
    const desk = await deskFrom(async (name, p) => (await face.get(name, p)).doc, id)
    const lanes = [...desk.lanes.values()], calls = [...desk.rows.values()], blocks = [...desk.defs.values()]
    assert.ok(lanes.some((l) => l.kind === 'subagent'), 'K-08 a subagent lane')
    assert.ok(calls.some((c) => c.error === true || (c.status != null && c.status !== 200)), 'K-12 a failed call')
    assert.ok(calls.some((c) => c.compaction === true || c.cacheBreak?.cause === 'compaction'), 'K-13 a compaction')
    assert.ok(blocks.some((b) => b.kind === 'image'), 'an image block')
    assert.ok(blocks.some((b) => b.chars >= world.hugeBytes), 'a block of at least hugeBytes characters')
  } finally { await face.close() }
})

test('W3 after grow(k) the server\'s main-lane count rises by exactly the main calls grow appended', async () => {
  const world = makeWorld({ seed: 3 })
  const face = await serveBoard(world)
  try {
    const before = {}
    for (const id of world.live) before[id] = await mainCount(face.get, id)
    const g = world.grow(5)
    assert.ok(g.main > 0)
    for (const id of world.live) {
      const want = before[id] + g.by[id].main
      let got
      for (const t0 = Date.now(); Date.now() - t0 < 5_000; await new Promise((r) => setTimeout(r, 200))) {
        got = await mainCount(face.get, id)
        if (got === want) break
      }
      assert.equal(got, want, id)
    }
  } finally { await face.close() }
})

test('W4 the http session opens on ≥ 3 sealed packs and ≥ 3 chapters, and growth seals its open tail into the next pack', async () => {
  const world = makeWorld({ seed: 4 })
  const face = await serveBoard(world)
  try {
    const id = world.sessions.find((s) => s.wire === 'http').id
    const head = async () => { await settled(face.get, id); const { status, doc } = await face.get('session', { id, head: 1 }); assert.equal(status, 200); return doc }
    const h0 = await head()
    assert.ok(h0.packs.length >= 3, `${h0.packs.length} sealed packs`)
    assert.ok(h0.chapters.length >= 3, `${h0.chapters.length} chapters`)
    world.grow(PACK_MEMBERS - (HTTP_CALLS % PACK_MEMBERS))
    let h1
    for (const t0 = Date.now(); Date.now() - t0 < 10_000; await new Promise((r) => setTimeout(r, 200))) if ((h1 = await head()).packs.length > h0.packs.length) break
    assert.equal(h1.packs.length, h0.packs.length + 1)
    assert.ok(h1.open.n > h0.open.n)
  } finally { await face.close() }
})
