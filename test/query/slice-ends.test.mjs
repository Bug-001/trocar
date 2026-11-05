// test/query/slice-ends.test.mjs — 3.5 #39 (§后台抽取与归约「说还有就一定做了事」): whatever the slice's budget and whatever comes between
// slices, a slice that says more has done a member or a unit, so the slices end; a write that failed ends the turn.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { drain } from '../helpers/bounded.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { extendSession, sessionState } from '../../src/query/named/session.mjs'
import { readHead, rereadFile, writeInFlight } from '../../src/query/ctx-files.mjs'
import { projectionFile, PROJ_V, sessionDir } from '../../src/query/projection.mjs'
import { yieldCaches } from '../../src/query/warm.mjs'

const SHAPE = { growth: 120, compactAt: 6_000, subEvery: 3, subLanes: 2, late: 3 }
const SPENT = 1e-6 // a budget spent before any unit of work ends
const CALLS = 520 // a pack and the open span: a write of many units
let ids = 0
const nextId = () => `end${String(++ids).padStart(5, '0')}-4a1b-9c2d-000000000001`
function homeWith(calls) {
  const home = path.join(tmpDir('trocar-ends-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const id = nextId(), other = nextId(), a = bigSession({ home, id, segment: '20261020T164731Z', ...SHAPE }), b = bigSession({ home, id: other, segment: '20261020T164732Z', growth: 120 })
  a.append(calls); b.append(20)
  return { home, id, other, a, ctx: { home, fs, writer: true } }
}
// a seeded stream of numbers in [0, 1)
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return seed / 2 ** 32 }
// an fs that refuses the session's answer files while `on()` holds; `refused()` says how many packs and tails it refused
function refusing(home, id, on) {
  let n = 0
  const dir = sessionDir(home, id), no = (f, file, ...r) => {
    if (on() && file.startsWith(dir) && /\.(gz|ndjson)(\.tmp)?$/.test(file)) { if (!path.basename(file).startsWith('head')) n++; throw Object.assign(new Error('injected: no room'), { code: 'ENOSPC' }) }
    return f(file, ...r)
  }
  return { fs: { ...fs, writeFileSync: (...a) => no(fs.writeFileSync, ...a), appendFileSync: (...a) => no(fs.appendFileSync, ...a) }, refused: () => n }
}
// the slices a session of `calls` calls may take, at a member or a unit each: a member is read, folded and rendered a few times over
const bound = (calls) => 40 * calls + 1_000
// the projection of another version on disk: the next store opened over it is a re-read (3.5 §访问模式「版本变更的重读」)
function stale(home, id) {
  for (const n of fs.readdirSync(sessionDir(home, id))) if (n.startsWith('extract.')) fs.unlinkSync(path.join(sessionDir(home, id), n))
  fs.writeFileSync(projectionFile(home, id), `${JSON.stringify({ v: PROJ_V + 1 })}\n`)
}

test('a write that fails ends the turn, with new members waiting or not', async () => {
  const { home, id, a, ctx } = homeWith(300)
  let full = false
  const f = refusing(home, id, () => full), slices = { ...ctx, fs: f.fs }
  await drain(() => extendSession(slices, id, Infinity))
  a.append(600) // a pack to seal: a write of many units
  const log = (await sessionState(slices, id)).V.log
  await drain(async () => { await extendSession(slices, id, SPENT); return !writeInFlight(log) }, 'until a write is in flight')
  a.append(3) // they wait for the write
  full = true
  await drain(() => extendSession(slices, id, SPENT), 'the turn', bound(900))
  assert.equal(f.refused(), 1, 'one failed write, not the same write again')
})

for (const budget of [0, 1, 50, Infinity]) for (const start of ['a first read', 'a re-read']) {
  test(`at a budget of ${budget} ms, in ${start}, the slices end whatever comes between them`, async () => {
    for (let seed = 1; seed <= 2; seed++) {
      const r = rng(seed * 7919), { home, id, other, a, ctx } = homeWith(CALLS)
      if (start === 'a re-read') { await drain(() => extendSession(ctx, id, Infinity)); stale(home, id) }
      let events = 30, landed = CALLS, full = false
      const { fs: refusal } = refusing(home, id, () => full), slices = { ...ctx, fs: refusal } // its own store: ctx's has not seen the stale projection
      const between = async () => {
        if (!events) return
        events--
        const x = r()
        if (x < 0.4) { const n = 1 + Math.floor(r() * 4); a.append(n); landed += n }
        else if (x < 0.55) await runQuery('session', { id }, slices)
        else if (x < 0.7) await extendSession(slices, other, 1)
        else if (x < 0.85) yieldCaches()
        else full = !full
      }
      // turn after turn until nothing comes: a write that failed ends a turn, the next one tries again
      await drain(async () => {
        await drain(async () => { await between(); return extendSession(slices, id, budget) }, `seed ${seed}`, bound(landed))
        return events > 0
      }, `seed ${seed}: the turns`, 100)
      full = false
      await drain(() => extendSession(slices, id, budget), `seed ${seed}: the last turn`, bound(landed))
      const head = readHead(home, id)
      assert.deepEqual([head.tier, head.pending], [1, null], `seed ${seed}: a whole answer`)
      assert.equal(fs.existsSync(rereadFile(home, id)), false, `seed ${seed}: no re-read left`)
    }
  })
}
