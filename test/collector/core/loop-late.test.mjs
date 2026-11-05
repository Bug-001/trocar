// test/collector/core/loop-late.test.mjs — MA20 (spec 4.9, 4.6 §记录): a daemon whose event loop came back ≥ 1 s late leaves one `loop-late` state event with
// `late_ms`, read off the lock timer it already has; that record is the direct evidence of a stall, and it is no failure, so health never counts it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createLoopWatch, LOOP_LATE_MS } from '../../../src/collector/core/loop-late.mjs'
import { checkRecord, isFailure } from '../../../src/health/codes.mjs'
import { foldFlows } from '../../../src/health/flows.mjs'
import { modelWorld } from '../../helpers/model-world.mjs'
import { liveUnit, withScratchCwd, unservable } from '../../helpers/model-daemon.mjs'
import { renderWrapper } from '../../../src/collector/arch/darwin/wrapper.mjs'

const EVERY = 100
const PLATFORMS = ['darwin', 'win32']
const cannot = Object.fromEntries(await Promise.all(PLATFORMS.map(async (p) => [p, await unservable(p)]))) // before the first test(): one registered after an await here never runs
/** Runs the watch over `gaps` (the ms between two ticks of the lock timer), the clock starting at a time that is not zero → the records written. */
function watched(gaps, opts = {}) {
  let t = 5000
  const out = []
  const watch = createLoopWatch({ everyMs: EVERY, write: (r) => out.push(r), now: () => t, ...opts })
  for (const g of gaps) { t += g; watch.tick() }
  return out
}

test('MA20 a tick late by the line or more writes one record whose late_ms is that lateness; a tick under it writes none', () => {
  const line = EVERY + LOOP_LATE_MS
  for (const gap of [EVERY, EVERY + 1, line - 1]) assert.deepEqual(watched([gap]), [], `${gap} ms between ticks`)
  for (const gap of [line, line + 1, line + 2400]) {
    const [r, ...more] = watched([gap])
    assert.deepEqual(more, [], `${gap} ms between ticks: one record`)
    assert.deepEqual([r.event, r.where, r.code, r.level, r.late_ms], ['loop-late', 'daemon', 'loop-late', 'note', gap - EVERY])
    assert.deepEqual(checkRecord(r), [])
    assert.equal(isFailure(r), false)
  }
  assert.deepEqual(watched([EVERY, line, EVERY, EVERY, line + 7, EVERY]).map((r) => r.late_ms), [LOOP_LATE_MS, LOOP_LATE_MS + 7], 'each tick is judged from the one before it')
  assert.deepEqual(watched([EVERY + 50], { lateMs: 50 }).map((r) => r.late_ms), [50], 'the line is the caller\'s when it says one')
})

test('MA20 a loop-late record is no failure in health: the fold has no group and no condition for it', () => {
  const [r] = watched([EVERY + 3000])
  const now = Date.parse('2026-11-05T12:00:00Z')
  const ts = new Date(now - 1000).toISOString()
  const start = { ts, event: 'daemon-start', pid: 1 }
  const f = foldFlows([start, { ts, ...r }], { now })
  assert.deepEqual([f.groups, f.conditions], [[], []])
  assert.equal(foldFlows([start, { ts, ...r, event: 'failure' }], { now }).groups.length, 1, 'the same fields as a failure are counted, so the fold can fail this test')
})

for (const platform of PLATFORMS) {
  test(`${platform} · MA20: a real daemon whose loop is held for 1.3 s writes loop-late into flows/, late_ms ≥ 1 s`, { skip: cannot[platform], timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const box = await liveUnit({ w, platform, daemon: { lockRefreshMs: EVERY } })
    const lates = () => fs.readdirSync(path.join(w.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8').split('\n')).filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === 'loop-late')
    await withScratchCwd(platform, async () => {
      try {
        box.unit.start()
        await box.starting
        const until = performance.now() + 1300
        while (performance.now() < until); // the daemon runs on this very loop
        for (const end = Date.now() + 5000; !lates().length && Date.now() < end;) await new Promise((r) => setTimeout(r, 20))
        const [r] = lates()
        assert.ok(r && r.late_ms >= LOOP_LATE_MS, JSON.stringify(r))
        assert.deepEqual(checkRecord(r), [])
      } finally { await box.stop() }
    })
  })
}
