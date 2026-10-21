// test/query/cut-fits.test.mjs — a session past the heap bound shows the newest calls that FIT, not a sliver of them (RFC 3.5
// §内存有界: 只读从尾部往前放得进的记录,至多少一步,截断点落在步格上).
//
// The measured bound stops a fold when what it holds passes what the plan reserved for it, and the next fold reads as many rows as
// the stopped one got through, less a step, on the grid. So the spine a cut answer keeps is most of the room, whatever the working
// set beside it: a bound that divided the whole heap growth (the spine AND the parsed chunk, the baselines, the chain tips) by the
// rows folded cut harder the earlier it stopped (review 2026-10-21). The contract, in heap bytes, for a session whose rows cost
// alike (a generated one): the spine a cut answer leaves in the warm cache is at least half of the read side's budget — the stopped
// fold held the whole reservation (the budget less the steady caches' steps), the working set goes when the fold ends, and the cut
// gives back at most the step left and the step of the grid (a tenth of the budget each). On real captures the cut is set by the
// fold's peak where large records run (a long main-thread context), not by what the newest rows keep, so this is not asserted there.
// The fold runs in this process; the budget is the worker's (heapBudget: min of the two heaps), so it cuts where the worker does.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { runQuery } from '../../src/query/named/index.mjs'
import { heapBudget, liveHeap } from '../../src/query/warm.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

test('3.5 §内存有界: a cut session keeps the newest calls that fit — its spine is at least half the budget, not a sliver', { timeout: 300_000 }, async () => {
  const home = path.join(tmpDir('trocar-cutfits-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  // never compacted: the main thread's context grows to ~2 MB, as the user's does, so the chain tips hold a working set that is large
  // beside a row's meta — where dividing the heap's growth by the rows folded cut hardest
  const s = bigSession({ home, wire: 'threads', growth: 3_000, subEvery: 2, subLanes: 8, subLen: 60, late: 3, compactAt: 3_000_000, cc: 30 })
  s.append(1_500)
  const before = liveHeap()
  const doc = await runQuery('session', { id: s.id, limit: '60' }, { home })
  const t = doc.truncated
  assert.ok(t, 'the generated session is past the budget (else this test proves nothing)')
  assert.ok(t.shown < t.total && doc.page.total === t.shown)
  const kept = liveHeap() - before // the spine, kept warm for the next look
  assert.ok(kept >= heapBudget() / 2,
    `a cut session keeps ${(kept / 1048576).toFixed(0)} MB of spine for ${t.shown} / ${t.total} calls, under half of the ${(heapBudget() / 1048576).toFixed(0)} MB budget`)
})
