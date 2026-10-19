// test/query/calls-index-first.test.mjs — `asight query calls` answers from the SEGMENT INDEX and reads back only
// the records of the page it returns (RFC 3.5 §访问模式, D62②; 1.6 §4.1, 附录 C.5 `calls`).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { runQuery, QueryArgError } from '../../src/query/named/index.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { indexRows } from '../../src/query/rows.mjs'

const SEG = '20261018T100000Z'
const at = (i) => new Date(Date.parse('2026-10-18T10:00:00.000Z') + i * 1000).toISOString()
const N = 12, L = 2

// variation along every filter axis: two classes, two hosts, two harnesses, two sessions, distinct times
const homeWithIndex = async (extra = []) => {
  const home = rawHome()
  writeSegment(home, SEG, [...Array.from({ length: N }, (_, i) => ({
    ts: at(i), class: i % 3 ? 'llm' : 'telemetry', is_llm: !!(i % 3),
    host: i % 2 ? 'a.example' : 'b.example', harness: i % 2 ? 'opencode' : 'codex', sessionKey: `s-${i % 4}`,
  })), ...extra])
  await segmentIndex({ home, segment: SEG, owner: true }) // the index the daemon keeps (4.2 §段索引)
  return home
}

// every byte read out of raw/: readSync on an fd opened there, and a whole-file read counts as unbounded
const countingFs = () => {
  const rawFds = new Set(); let reads = 0
  const inRaw = (p) => String(p).includes(`${path.sep}raw${path.sep}`)
  const f = {
    ...fs, promises: fs.promises,
    openSync(p, ...a) { const fd = fs.openSync(p, ...a); if (inRaw(p)) rawFds.add(fd); return fd },
    closeSync(fd) { rawFds.delete(fd); return fs.closeSync(fd) },
    readSync(fd, ...a) { if (rawFds.has(fd)) reads++; return fs.readSync(fd, ...a) },
    readFileSync(p, ...a) { if (inRaw(p)) reads = Infinity; return fs.readFileSync(p, ...a) },
  }
  return { fs: f, reads: () => reads }
}

test('3.5 / D62②: on every filter axis, calls reads back at most --limit records', async () => {
  const home = await homeWithIndex()
  const rows = await indexRows({ home })
  const axes = { class: 'llm', host: 'a.example', harness: 'opencode', session: rows.find((r) => r.session_id).session_id, since: at(3) }
  for (const [axis, value] of Object.entries(axes)) {
    const c = countingFs()
    const doc = await runQuery('calls', { [axis]: value, class: axis === 'class' ? value : 'llm,telemetry', limit: String(L) }, { home, fs: c.fs })
    assert.deepEqual(doc.errors, [], axis)
    assert.ok(doc.total > L, `${axis}: the filter matches more than one page`)
    assert.ok(c.reads() <= L, `${axis}: ${c.reads()} reads for a page of ${L}`)
  }
})

test('C.5 --ref: that one record, total 1, the same record as on its --class page; malformed → arg error; unknown → [] + errors', async () => {
  const home = await homeWithIndex()
  const page = await runQuery('calls', { class: 'llm', limit: '500' }, { home })
  const want = page.records[page.records.length - 1] // inside the detail window, as a single record is
  const one = await runQuery('calls', { ref: want.id }, { home })
  assert.equal(one.records.length, 1)
  assert.equal(one.total, 1)
  assert.deepEqual(one.records[0], want)
  await assert.rejects(() => runQuery('calls', { ref: 'not-a-record' }, { home }), QueryArgError)
  const none = await runQuery('calls', { ref: `${SEG}:9999` }, { home })
  assert.deepEqual([none.records, none.total, none.ok], [[], 0, false])
  assert.ok(none.errors.length > 0)
})

test('C.5: an unrecorded response size is received_bytes null, never 0; a log-only row is retention log', async () => {
  const logged = JSON.stringify({ ...JSON.parse(envLine({ ts: at(N), class: 'llm', wireResp: null })), body_retention: 'log' })
  const home = await homeWithIndex([logged])
  const doc = await runQuery('calls', { class: 'llm', limit: '500' }, { home })
  const rec = doc.records.find((r) => r.id === `${SEG}:${N + 1}`)
  assert.equal(rec.received_bytes, null)
  assert.equal(rec.retention, 'log')
  for (const r of doc.records.filter((x) => x !== rec)) assert.equal(r.retention, 'full')
})

test('C.5 --host: every record is on that host and total is that host\'s index rows', async () => {
  const home = await homeWithIndex()
  const doc = await runQuery('calls', { host: 'a.example', limit: '500' }, { home })
  assert.ok(doc.records.length > 0)
  for (const r of doc.records) assert.equal(r.host, 'a.example')
  assert.equal(doc.total, (await indexRows({ home })).filter((r) => r.host === 'a.example').length)
})

test('D38: a record that cannot be read back is named in errors and the page is still answered', async () => {
  const home = await homeWithIndex()
  const rows = await indexRows({ home })
  const victim = rows.find((r) => r.class === 'telemetry')
  // the disk hands back other bytes for that one record (a bad sector, a torn write) after the index was built
  const bad = { ...fs, promises: fs.promises,
    readSync(fd, buf, off, len, pos) { const n = fs.readSync(fd, buf, off, len, pos); const at = victim.offset - pos
      if (pos != null && at >= 0 && at < n) buf.fill(0x23, off + at, off + Math.min(n, at + victim.stored_bytes)); return n } }
  const doc = await runQuery('calls', { class: 'telemetry', limit: '500' }, { home, fs: bad })
  assert.equal(doc.ok, false)
  assert.ok(doc.errors.some((e) => e.where === victim.id), JSON.stringify(doc.errors))
  assert.ok(Array.isArray(doc.records))
})
