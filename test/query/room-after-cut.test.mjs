// test/query/room-after-cut.test.mjs — 3.5 #11「一场被实测的界截过的大会话之后,同一进程里的小会话照样折完」: the state of the big session, the
// ledger's to let go, leaves the heap with it, so a small one folded after it finds the room (a session of 3 members stopped at
// `heap-no-room` while nothing but the ledger had let the big state go, 2026-11-05).
//
// A process of its own with a small heap, as in test/query/cut-fits.test.mjs: the session past the budget for real (past-room.mjs), the
// small sessions beside it in the same home.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { pastRoom, readerFlags } from './past-room.mjs'

const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const READ = `
await import(${at('../../src/query/named/index.mjs')}) // first: the registry imports session.mjs
const { extendSession } = await import(${at('../../src/query/named/session.mjs')})
const { readHead } = await import(${at('../../src/query/ctx-files.mjs')})
const { drain } = await import(${at('../helpers/bounded.mjs')})
const [home, big, ...small] = process.argv.slice(1)
const ctx = { home, writer: true }, after = []
await drain(() => extendSession(ctx, big, 50), big)
for (const id of small) {
  let stop = null
  try { await drain(() => extendSession(ctx, id, 50), id) } catch (e) { stop = e.code || e.message }
  const head = readHead(home, id)
  after.push({ stop, tier: head?.tier, pending: head?.pending })
}
console.log(JSON.stringify(after))`

test('3.5 #11: small sessions fold whole after a big one was cut, in the same process', { timeout: 300_000 }, () => {
  const shape = { wire: 'threads', growth: 150, compactAt: 3_000, subEvery: 4, subLanes: 3, subLen: 12, names: 16_000 }, heapMb = 112
  const home = path.join(tmpDir('trocar-room-'), '.trocar'), id = pastRoom({ home, shape, heapMb })
  try {
    const small = [1, 2, 3].map((n) => { const s = bigSession({ home, id: `sma${n}0000-4a1b-9c2d-00000000000${n}`, segment: `20261020T16473${n}Z`, growth: 120 }); s.append(20 * n); return s.id })
    const after = JSON.parse(execFileSync(process.execPath, [...readerFlags(heapMb), '--input-type=module', '-e', READ, home, id, ...small], { encoding: 'utf8', maxBuffer: 1 << 20 }))
    assert.deepEqual(after, small.map(() => ({ stop: null, tier: 1, pending: null })))
  } finally { fs.rmSync(path.dirname(home), { recursive: true, force: true }) } // hundreds of MB on disk
})
