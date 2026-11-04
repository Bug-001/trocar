// 3.5 验收 #29: the warm segment index keeps each segment's rows as one column store read through one accessor
// (src/query/row-table.mjs). Whatever the store does, a row read through it is the index file's entry, byte for byte, and a
// warm process that kept reading while segments grew answers every data query as a fresh process does.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { writeSegment, DATA_QUERIES, requiredFor } from './raw-home.mjs'
import { segmentIndex, segmentFiles, warmSegmentIndex, indexDir } from '../../src/query/index-build.mjs'
import { indexRows } from '../../src/query/rows.mjs'
import { sealSegment } from '../../src/raw/seal.mjs'

const NOW = Date.parse('2026-11-02T00:00:00Z')
const PLAIN = '20261101T080000Z', SEALED = '20261101T090000Z', LIVE = '20261101T100000Z'
// the value axes of an index row: wire bytes absent or null, hosts, classes, statuses, times canonical and not, session keys
const axes = (k, t0) => Array.from({ length: 9 }, (_, i) => {
  const n = k * 9 + i, ts = new Date(Date.parse(t0) + n * 1000).toISOString()
  return {
    id: `r${n}`,
    ts: n % 4 === 1 ? ts.replace('Z', '+00:00') : n % 4 === 2 ? ts.replace('.000Z', 'Z') : ts,
    host: ['api.anthropic.com', 'chatgpt.com', `h${n % 3}.example`][n % 3],
    class: ['llm', 'files', 'telemetry'][n % 3],
    is_llm: n % 3 === 0,
    status: [200, 404, 500, 201][n % 4],
    ...(n % 5 === 0 ? { noWire: true } : n % 5 === 1 ? { wireReq: null } : {}),
    ...(n % 2 === 0 ? { sessionKey: 's-live', harness: 'opencode' } : { harness: ['claude-code', 'codex'][(n >> 1) % 2] }),
  }
})

// the entry lines of ~/.trocar/index/<segment>.json, as their own bytes
const fileRows = (home, segment) => fs.readFileSync(path.join(indexDir(home), `${segment}.json`), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((o) => !o.m && !o.p).map((o) => JSON.stringify(o))

test('段索引行按列存:访问器读出的行 = 索引文件的条目;长了之后每个数据查询在温的进程里与全新进程逐字节相同', async () => {
  const dir = tmpDir('trocar-rows-'), home = path.join(dir, '.trocar')
  generate({ home, seed: 5, bytes: 400_000, segmentBytes: 100_000 })
  writeSegment(home, PLAIN, axes(0, '2026-11-01T08:00:00.000Z'))
  writeSegment(home, SEALED, axes(1, '2026-11-01T09:00:00.000Z'))
  writeSegment(home, LIVE, axes(2, '2026-11-01T10:00:00.000Z'))
  const lockFile = path.join(home, 'collector', 'lock')
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, segment: LIVE }))
  await sealSegment(path.join(home, 'raw', `${SEALED}.ndjson`), { lockFile, journal: null })
  fs.rmSync(lockFile) // a lock is fresh for seconds only: left in place, `segments` would answer by how long this test ran
  const keep = async () => { for (const [segment, at] of segmentFiles(home)) if (at.plain) await segmentIndex({ home, segment, owner: true }) }
  await keep()

  // one answering function, run here (warm) and in a fresh child process
  const answers = path.join(dir, 'answers.mjs')
  fs.writeFileSync(answers, `import { runQuery } from ${JSON.stringify(new URL('../../src/query/named/index.mjs', import.meta.url).href)}
export async function answerAll(home, now, asks) {
  const out = []
  for (const [name, params] of asks) { try { out.push(JSON.stringify(await runQuery(name, params, { home, now: () => now }))) } catch (e) { out.push('threw ' + e.message) } }
  return out
}
if (process.argv[2]) process.stdout.write(JSON.stringify(await answerAll(process.argv[2], Number(process.argv[3]), JSON.parse(process.argv[4]))))
`)
  const { answerAll } = await import(pathToFileURL(answers).href)
  const asks = DATA_QUERIES.map((name) => [name, requiredFor(name, { segment: LIVE, session: 's-live' })])
  const fresh = () => JSON.parse(execFileSync(process.execPath, [answers, home, String(NOW), JSON.stringify(asks)], { env: { ...process.env, HOME: dir }, maxBuffer: 1 << 28 }))

  for (let step = 0; step <= 3; step++) {
    if (step) {
      writeSegment(home, LIVE, axes(2 + step, '2026-11-01T10:00:00.000Z'))
      await answerAll(home, NOW, asks) // read before the keeper: the reader scans the new tail itself, then the keeper writes it
      await keep()
    }
    for (const [segment] of segmentFiles(home)) {
      const { records } = await warmSegmentIndex({ home, segment })
      assert.deepEqual([...records].map((r) => JSON.stringify(r)), fileRows(home, segment), `step ${step}: ${segment}`)
    }
    const warm = await answerAll(home, NOW, asks), cold = fresh()
    asks.forEach(([name], i) => assert.equal(warm[i], cold[i], `step ${step}: ${name}`))
  }
})

test('段索引行按列存:时刻列读回的文本 = 存进去的文本 = toISOString,沿年份、日界与毫秒位生成', async () => {
  const { rowTable, isoText } = await import('../../src/query/row-table.mjs')
  const MAX = Date.parse('9999-12-31T23:59:59.999Z')
  let x = 7
  const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n }
  const ms = [0, -1, MAX, MAX + 1, -62198755200000, Date.parse('2024-02-29T23:59:59.999Z'), Date.parse('2026-12-31T23:59:59.000Z')]
  for (let i = 0; i < 4000; i++) ms.push(rnd(2) ? rnd(MAX) + rnd(1000) : -rnd(1e12) * 1000 - rnd(1000))
  // days alternating and repeating, so a row's day is never assumed to be the one read before it
  for (let i = 0; i < 200; i++) ms.push(Date.parse('2026-11-01T00:00:00Z') + (i % 3 === 0 ? -1 : i % 3) * 86_399_990 + i)
  const entries = ms.map((m, i) => ({ id: `r${i}`, ts: new Date(m).toISOString() }))
  ms.forEach((m, i) => assert.equal(isoText(m), entries[i].ts)) // the decoder alone: a wrong one would also refuse to encode, unseen below
  const view = rowTable(entries)
  for (let pass = 0; pass < 2; pass++) // forwards, then backwards
    for (let k = 0; k < entries.length; k++) { const i = pass ? entries.length - 1 - k : k; assert.equal(view.at(i).ts, entries[i].ts, `ms ${ms[i]}`) }
})

// 3.5 §行表先读: a read of the rows may give way (`ease`), between segments and inside a scan, and what it reads does not change. The
// axes: a segment plain or sealed × its index kept, of another version, or missing. The `fs` here takes 60 ms per read, so a scan is long
// enough to give way inside (no time is asserted); the other read is of a copy of the home, which nothing has read yet.
test('ease: rows and a rebuilt index are what they are without it, whatever the segment kind and the state of its index', async () => {
  const block = new Int32Array(new SharedArrayBuffer(4))
  const slow = { ...fs, readSync: (...a) => { Atomics.wait(block, 0, 0, 60); return fs.readSync(...a) } }
  const rowsOf = (list) => [...list].map((r) => JSON.stringify(r))
  for (const sealed of [false, true]) for (const index of ['kept', 'other version', 'missing']) {
    const dir = tmpDir('trocar-ease-'), home = path.join(dir, 'a', '.trocar'), lockFile = path.join(home, 'collector', 'lock')
    fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    const segments = [PLAIN, SEALED, LIVE]
    segments.forEach((s, k) => writeSegment(home, s, Array.from({ length: 8 }, (_, i) => axes(k * 8 + i, '2026-11-01T08:00:00.000Z')).flat()))
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, segment: LIVE }))
    if (sealed) for (const s of [PLAIN, SEALED]) await sealSegment(path.join(home, 'raw', `${s}.ndjson`), { lockFile, journal: null })
    fs.rmSync(lockFile)
    for (const segment of segments) await segmentIndex({ home, segment, owner: true })
    if (index === 'missing') fs.rmSync(indexDir(home), { recursive: true })
    if (index === 'other version') for (const segment of segments) {
      const f = path.join(indexDir(home), `${segment}.json`)
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"v":\d+\}\n/g, '"v":1}\n'))
    }
    const copy = path.join(dir, 'b', '.trocar')
    fs.cpSync(home, copy, { recursive: true, preserveTimestamps: true })

    let eased = 0
    const give = async () => { eased++; await new Promise(setImmediate) }
    const read = await indexRows({ home, fs: slow, ease: give })
    assert.deepEqual(rowsOf(read), rowsOf(await indexRows({ home: copy })), `${sealed} ${index}`)
    assert.ok(eased >= 1, `${sealed} ${index}`)
    if (index === 'kept') continue
    const inside = eased
    await segmentIndex({ home, segment: LIVE, fs: slow, ease: give })
    assert.ok(eased > inside, `${sealed} ${index}: a plain scan gave way`)
    if (!sealed) continue
    const idx = path.join(indexDir(home), `${SEALED}.json`), plainly = fs.readFileSync(idx)
    fs.rmSync(idx)
    eased = 0
    await segmentIndex({ home, segment: SEALED, fs: slow, ease: give })
    assert.ok(eased >= 1, `${index}: a sealed scan gave way`)
    assert.ok(fs.readFileSync(idx).equals(plainly), `${index}: the rebuilt sealed index, byte for byte`)
  }
})
