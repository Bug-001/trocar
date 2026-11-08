// test/scripts/deploy-check.test.mjs — the units of scripts/deploy-check.mjs (4.4 #19, D78 ④) on made-up directories. The check itself runs
// by hand over a copy of a real capture, which never enters the repository, so what is here is what decides its exit code.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { preRead, rawDiff, rawList, segmentCheck, verdict } from '../../scripts/deploy-check-lib.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/deploy-check.mjs', import.meta.url))
const A = '20261101T080000Z', B = '20261101T090000Z'
const TIME = new Date('2026-11-01T10:00:00.000Z')

/** A raw/ of `files` (name → bytes), every mtime the same, and what moves it. */
function rawDir(files) {
  const dir = tmpDir('trocar-deploy-raw-')
  const put = (name, bytes) => { fs.writeFileSync(path.join(dir, name), bytes); fs.utimesSync(path.join(dir, name), TIME, TIME) }
  for (const [name, bytes] of Object.entries(files)) put(name, bytes)
  return { dir, put, list: () => rawList(dir) }
}
const refusedFiles = (d) => d.refused.map((r) => r.file)

test('rawDiff: a sealed segment that did not move is ok; one whose size or mtime moved is refused by name', () => {
  const raw = rawDir({ [`${A}.sealed`]: 'sealed bytes', [`${B}.sealed`]: 'other bytes' }), before = raw.list()
  assert.deepEqual(rawDiff(before, raw.list()), { ok: true, refused: [] })
  raw.put(`${A}.sealed`, 'sealed bytes and more')
  const size = rawDiff(before, raw.list())
  assert.deepEqual([size.ok, refusedFiles(size)], [false, [`${A}.sealed`]], 'size')
  raw.put(`${A}.sealed`, 'sealed bytes')
  fs.utimesSync(path.join(raw.dir, `${B}.sealed`), TIME, new Date(TIME.getTime() + 1000))
  const mtime = rawDiff(before, raw.list())
  assert.deepEqual([mtime.ok, refusedFiles(mtime)], [false, [`${B}.sealed`]], 'mtime')
})

test('rawDiff: an open segment may grow, and may be sealed under its own name; shrunk or gone is refused by name', () => {
  const raw = rawDir({ [`${A}.ndjson`]: 'one line\n', [`${B}.sealed`]: 'sealed' }), before = raw.list()
  raw.put(`${A}.ndjson`, 'one line\nand another\n')
  assert.equal(rawDiff(before, raw.list()).ok, true, 'grown')

  fs.rmSync(path.join(raw.dir, `${A}.ndjson`))
  raw.put(`${A}.sealed`, 'sealed form')
  assert.equal(rawDiff(before, raw.list()).ok, true, 'sealed under its own name')

  fs.rmSync(path.join(raw.dir, `${A}.sealed`))
  raw.put(`${A}.ndjson`, 'one')
  const shrunk = rawDiff(before, raw.list())
  assert.deepEqual([shrunk.ok, refusedFiles(shrunk)], [false, [`${A}.ndjson`]], 'shrunk')

  fs.rmSync(path.join(raw.dir, `${A}.ndjson`))
  const gone = rawDiff(before, raw.list())
  assert.deepEqual([gone.ok, refusedFiles(gone)], [false, [`${A}.ndjson`]], 'an open segment gone')

  raw.put(`${A}.ndjson`, 'one line\n')
  fs.rmSync(path.join(raw.dir, `${B}.sealed`))
  const sealedGone = rawDiff(before, raw.list())
  assert.deepEqual([sealedGone.ok, refusedFiles(sealedGone)], [false, [`${B}.sealed`]], 'a sealed segment gone')
})

const onDisk = (...names) => names.map((name) => ({ name, size: 10 }))
test('segmentCheck: every segment of raw is in the rows once; one lost and one twice are each named', () => {
  assert.deepEqual(segmentCheck(onDisk(`${A}.sealed`, `${B}.ndjson`), [{ segment: A, rows: 3 }, { segment: B, rows: 1 }]), { ok: true, lost: [], twice: [] })
  assert.deepEqual(segmentCheck(onDisk(`${A}.sealed`, `${B}.sealed`), [{ segment: B, rows: 1 }]), { ok: false, lost: [A], twice: [] })
  assert.deepEqual(segmentCheck(onDisk(`${A}.sealed`, `${B}.sealed`), [{ segment: A, rows: 3 }, { segment: B, rows: 1 }, { segment: A, rows: 2 }]), { ok: false, lost: [], twice: [A] })
})

test('segmentCheck: a segment the rows knew as plain and raw now holds sealed is the same segment', () => {
  assert.deepEqual(segmentCheck(onDisk(`${A}.sealed`), [{ segment: `${A}.ndjson`, rows: 3 }]), { ok: true, lost: [], twice: [] })
  assert.deepEqual(segmentCheck(onDisk(`${A}.sealed`), [{ segment: `${A}.ndjson`, rows: 3 }, { segment: `${A}.sealed`, rows: 3 }]), { ok: false, lost: [], twice: [A] })
})

test('verdict: at the line passes, over it fails, no measured value fails, and a failure of any other kind fails', () => {
  const lines = { fastMs: 100, slowMs: 500 }
  assert.deepEqual(verdict(lines, { fastMs: 100, slowMs: 500 }, []), { pass: true, failures: [] })
  const over = verdict(lines, { fastMs: 100.5, slowMs: 500 }, [])
  assert.equal(over.pass, false); assert.equal(over.failures.length, 1)
  for (const measured of [{ slowMs: 1 }, { fastMs: null, slowMs: 1 }, { fastMs: NaN, slowMs: 1 }, { fastMs: Infinity, slowMs: 1 }]) assert.equal(verdict(lines, measured, []).pass, false, JSON.stringify(measured))
  assert.equal(verdict(lines, { fastMs: 1, slowMs: 1 }, ['a page error']).pass, false)
})

test('verdict: a line against the idle p95 holds at idle * times + plus, not past it, and needs both values', () => {
  const lines = { busyP95: { idle: 'idleP95', times: 1.5, plusMs: 10 } }
  assert.equal(verdict(lines, { busyP95: 160, idleP95: 100 }, []).pass, true, 'at the edge')
  assert.equal(verdict(lines, { busyP95: 160.5, idleP95: 100 }, []).pass, false, 'past the edge')
  assert.equal(verdict(lines, { busyP95: 10, idleP95: 0 }, []).pass, true, 'an idle of 0: the plus alone')
  assert.equal(verdict(lines, { busyP95: 11, idleP95: 0 }, []).pass, false)
  assert.equal(verdict(lines, { busyP95: 1 }, []).pass, false, 'no idle value')
  assert.equal(verdict(lines, { idleP95: 100 }, []).pass, false, 'no value under the re-read')
})

test('preRead: what it prints swaps the index with the daemon gone, keeps the old one, and touches nothing while the lock is there', () => {
  const dir = tmpDir("trocar-deploy it's-"), real = path.join(dir, '.trocar'), side = path.join(dir, 'side', 'index')
  fs.mkdirSync(path.join(real, 'collector'), { recursive: true }); fs.mkdirSync(path.join(real, 'index')); fs.mkdirSync(side, { recursive: true })
  fs.writeFileSync(path.join(real, 'index', 'x.json'), 'old'); fs.writeFileSync(path.join(side, 'x.json'), 'new')
  const lock = path.join(real, 'collector', 'lock'), script = preRead({ real, side, before: 'index.before-1' })
  const swap = () => spawnSync('sh', ['-c', script], { encoding: 'utf8' }).status
  const read = (...p) => fs.readFileSync(path.join(real, ...p), 'utf8')

  fs.writeFileSync(lock, '{}')
  assert.equal(swap(), 1)
  assert.equal(read('index', 'x.json'), 'old')
  assert.ok(fs.existsSync(side))

  fs.rmSync(lock)
  assert.equal(swap(), 0)
  assert.equal(read('index', 'x.json'), 'new')
  assert.equal(read('index.before-1', 'x.json'), 'old')
  assert.ok(!fs.existsSync(side))
})

test('deploy-check: a home with no raw/ is refused with exit 2, before anything is made', () => {
  const home = tmpDir('trocar-deploy-home-')
  const r = spawnSync(process.execPath, [SCRIPT, '--home', home], { encoding: 'utf8' })
  assert.equal(r.status, 2, r.stderr)
  assert.deepEqual(fs.readdirSync(home), [])
})
