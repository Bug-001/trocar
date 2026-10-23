// test/query/cut-grows.test.mjs — a cut session that keeps growing never shows fewer than half of the calls that fit (RFC 3.5
// §内存有界: the segment index rows and the distinct blocks, never cut, count at their bytes; the cut only moves forward and stays
// while it shows the fit less two steps; no room for one row is a non-2xx error, never a sliver).
//
// The index rows and the blocks grow with every call, so the room for the cut's rows shrinks as the session grows. Charged in whole
// steps of a tenth of the budget, either term crossing a step took a step (8.9 MB in a 128 MB reader) out of a room of ~3 MB and the
// session showed 1 call of 12,429 while 14,290 fit (2026-10-23). A reader with a 160 MB heap reads the session, the grower adds 25
// calls, the reader reads again; each read is held against the fit the spec's formula gives at that moment.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpDir } from '../helpers/tmp.mjs'
import { grower, readerFlags } from './past-room.mjs'

const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
// one line in, one read out: the session as the worker reads it (its background slices extend the state while the answer is pending),
// and the fit at that moment: (budget − work − index rows − blocks × SPINE_PER_BLOCK) / SPINE_PER_ROW
const READER = `
const fs = await import('node:fs')
const { runQuery } = await import(${at('../../src/query/named/index.mjs')}) // first: the registry imports session.mjs
const { SPINE_PER_ROW, SPINE_PER_BLOCK, CACHES, working, extendSession } = await import(${at('../../src/query/named/session.mjs')})
const { heapBudget, steadyBytes } = await import(${at('../../src/query/warm.mjs')})
const { projectionFile } = await import(${at('../../src/query/projection.mjs')})
const { indexRows, sessionGroups } = await import(${at('../../src/query/rows.mjs')})
const [home, id] = process.argv.slice(1), ctx = { home, writer: true }
// the projection's definition lines, counted over the bytes appended since the last count
let blocks = 0, read = 0, tail = ''
const count = () => {
  const fd = fs.openSync(projectionFile(home, id), 'r'), size = fs.fstatSync(fd).size, b = Buffer.alloc(size - read)
  fs.readSync(fd, b, 0, b.length, read); fs.closeSync(fd); read = size
  const lines = (tail + b.toString('latin1')).split('\\n'); tail = lines.pop()
  for (const l of lines) if (l.startsWith('{"d":')) blocks++
}
for await (const _ of (await import('node:readline')).createInterface({ input: process.stdin })) {
  let out
  try {
    let doc
    for (;;) { doc = await runQuery('session', { id, limit: '1' }, ctx); if (!doc.pending) break; while (await extendSession(ctx, id, 50)); }
    out = doc.truncated ? { shown: doc.truncated.shown, total: doc.truncated.total } : { shown: null, total: doc.lanes.reduce((n, l) => n + l.count, 0) }
    if (out.shown == null) out.shown = out.total
  } catch (e) { out = { error: String(e.message || e) } }
  const rows = sessionGroups(await indexRows({ home, errors: [] })).get(id); count()
  out.fit = Math.floor((heapBudget() - working(rows) - steadyBytes() - blocks * SPINE_PER_BLOCK - CACHES) / SPINE_PER_ROW)
  console.log(JSON.stringify(out))
}`

test('3.5 §内存有界: a growing cut session never shows fewer than half of the calls that fit', { timeout: 180_000 }, async () => {
  const home = path.join(tmpDir('trocar-cutgrows-'), '.trocar')
  // Claude Code on Message Threads (cut-fits.test.mjs case 1), grown past a 160 MB reader's room
  const s = await grower({ home, heapMb: 160, shape: { growth: 150, subEvery: 4, subLanes: 3, subLen: 12, wire: 'threads', compactAt: 3_000, cc: 4 } })
  const reader = spawn(process.execPath, [...readerFlags(160), '--input-type=module', '-e', READER, home, s.id], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: reader.stdout })[Symbol.asyncIterator]()
  const look = async () => { reader.stdin.write('\n'); const { value, done } = await lines.next(); assert.ok(!done, 'the reader ended'); return JSON.parse(value) }
  const seen = []
  try {
    for (let i = 0; i < 60; i++) {
      const r = await look()
      seen.push(r)
      if (r.error) assert.ok(r.fit < 1, `read ${i}: "${r.error}" while ${r.fit} calls fit`)
      else {
        assert.ok(r.fit >= 1, `read ${i}: ${r.shown} calls shown where none fit (no room is an error)`)
        assert.ok(r.shown >= Math.min(r.total, Math.floor(r.fit / 2)), `read ${i}: ${r.shown} / ${r.total} calls shown, fewer than half of the ${r.fit} that fit`)
      }
      for (let k = 0; k < 25; k++) await s.more()
    }
  } finally {
    reader.stdin.end(); reader.kill(); s.stop()
    fs.rmSync(path.dirname(home), { recursive: true, force: true }) // hundreds of MB on disk
  }
  assert.ok(seen.some((r) => !r.error && r.shown < r.total), 'no read was cut (else this test proves nothing)')
})
