// test/query/cut-fits.test.mjs — a session whose fold passes the heap budget for real is cut by the measured bound to the newest calls
// that fit, not a sliver of them, and never refused (RFC 3.5 §内存有界「截断只是兜底,按实测的堆截」: the fold stops when the live
// heap comes within half a step of the budget; it then reads the newest rows it got through, at least half of those asked, less one
// step on the grid; the heap stays inside the budget).
//
// One cold query in a process of its own with a small heap (test/query/past-room.mjs readerFlags), of a session grown and extracted
// past that budget for real beforehand (pastRoom: its calls dear, each keeping a long tool name in the fold).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { pastRoom, readerFlags } from './past-room.mjs'

const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
// read as the worker reads it (it writes the projection, 3.5 §后台抽取), until no member is above the extraction frontier
const READ = `
const { runQuery } = await import(${at('../../src/query/named/index.mjs')}) // first: the registry imports session.mjs
const { heapBudget, liveHeap } = await import(${at('../../src/query/warm.mjs')})
const [home, id] = process.argv.slice(1)
let doc, peak = 0
do { doc = await runQuery('session', { id, limit: '60' }, { home, writer: true }); peak = Math.max(peak, liveHeap()) } while (doc.pending)
const { truncated } = doc, total = doc.lanes.reduce((n, l) => n + l.count, 0)
doc = null
console.log(JSON.stringify({ truncated, total, peak, budget: heapBudget() }))`

const mb = (n) => (n / 1048576).toFixed(1)

test('3.5 §内存有界: a session whose fold passes the budget is cut by the measured bound to at least half of what fits, inside the budget', { timeout: 300_000 }, () => {
  // Claude Code on Message Threads, its tool definitions and cache markers riding every request (cc), every call a tool of its own
  // with a name of 16,000 characters: each call keeps ~16 KB in the fold, far more than the spine's estimate
  const shape = { growth: 150, subEvery: 4, subLanes: 3, subLen: 12, wire: 'threads', compactAt: 3_000, cc: 4, names: 16_000 }, heapMb = 160
  const home = path.join(tmpDir('trocar-cutfits-'), '.trocar'), id = pastRoom({ home, shape, heapMb })
  try {
    const c = JSON.parse(execFileSync(process.execPath, [...readerFlags(heapMb), '--input-type=module', '-e', READ, home, id], { encoding: 'utf8', maxBuffer: 1 << 20 }))
    const t = c.truncated
    assert.ok(t && t.shown < t.total, `a session of calls holding twice the budget is cut: ${JSON.stringify(t)}`)
    assert.equal(c.total, t.shown, 'the lanes count the calls shown')
    assert.ok(c.peak <= c.budget, `the live heap peaked at ${mb(c.peak)} MB, past the ${mb(c.budget)} MB budget`)
    // what fits: the calls a fold holds in the budget at their names' bytes at most; the cut shows at least half of that, less a step
    const fits = Math.floor(c.budget / shape.names / 2)
    assert.ok(t.shown >= fits * 0.4, `${t.shown} / ${t.total} calls shown, a sliver of the ~${fits}+ that fit`)
  } finally { fs.rmSync(path.dirname(home), { recursive: true, force: true }) } // hundreds of MB on disk
})
