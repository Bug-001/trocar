// entries-once.test.mjs — one `on` writes each JSON route file once and backs up only the user's bytes (spec 4.6「日志」, 4.11 P5): one rename onto the file,
// one backup holding the pre-on bytes and never the door password; a crash at the intent or after the write is finished by the next `on` without a second
// backup or a second write; `off` brings the file back byte for byte and drops the backup. Generated over every json-key route × darwin / win32 × file
// present / absent. A crash is an fs that refuses every change from the failing call on; the next run reads the manifest back from the disk.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { routeEntry } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { readManifest } from '../../../../src/off/manifest.mjs'
import { backupDir } from '../../../../src/off/paths.mjs'
import { sha256 } from '../../../../src/off/fsutil.mjs'
import { undoHarnesses } from '../../../../src/off/undo.mjs'
import { world, put, bytesOf, door } from './fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const PW = new URL(door()).password
const CHANGES = new Set(['renameSync', 'writeFileSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'copyFileSync', 'writeSync', 'fchmodSync'])

// fs whose renameSync records its destination; `failAt(dest, renames)` true → that rename throws and every change after it throws too (the process died)
function spyFs(failAt = () => false) {
  const renames = []
  let dead = false
  const crash = () => Object.assign(new Error('crashed'), { code: 'EIO' })
  const fsx = new Proxy(fs, {
    get(t, k) {
      const f = t[k]
      if (k === 'renameSync') return (a, b) => { if (dead || failAt(b, renames)) { dead = true; throw crash() } renames.push(b); return f.call(t, a, b) }
      if (k === 'openSync') return (p, flags, ...more) => { if (dead && flags && flags !== 'r') throw crash(); return f.call(t, p, flags, ...more) }
      if (CHANGES.has(k)) return (...a) => { if (dead) throw crash(); return f.apply(t, a) }
      return f
    },
  })
  return { fs: fsx, renames }
}
const backups = (home) => { try { return fs.readdirSync(backupDir(home)).map((n) => path.join(backupDir(home), n)) } catch (e) { if (e.code === 'ENOENT') return []; throw e } }

const CELLS = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).filter(([, r]) => r.kind === 'json-key' && !r.select).map(([id, r]) => ({ h, id, r })))
  .flatMap((c) => ['darwin', 'win32'].flatMap((os) => [true, false].map((exists) => ({ ...c, os, exists }))))
  .filter((c) => c.exists || c.r.absent !== 'not-routed')

// one cell: a world with the user's file (or none), the route's ctx, and a run of `on` with the given fs
function cell({ h, id, r, os, exists }) {
  const w = world({ os })
  const ctx = (fsx, manifest = w.ctx.manifest) => ({ ...w.ctx, fs: fsx, manifest, harness: h.name, route: r, routeId: id })
  const file = resolveLoc(r.file, ctx(fs))[0]
  const pre = exists ? Buffer.from('{\n  "unrelated": "keep"\n}\n') : null
  if (pre) put(file, pre)
  const run = (spy, manifest) => routeEntry(r.kind).write(ctx(spy.fs, manifest), door())
  const label = `${h.name}.${id} · ${os} · file ${exists ? 'present' : 'absent'}`
  return { w, file, pre, run, label }
}
const onto = (c, spy) => spy.renames.filter((d) => d === c.file).length
const ons = (dir) => readManifest(dir).entries.filter((x) => x.phase === 'on')

// the three ways one `on` reaches a written file: straight, after a crash at the intent, after a crash once the file was written
const SCENARIOS = {
  O1(c) { const s = spyFs(); assert.equal(c.run(s).ok, true, c.label); return s },
  O2(c) {
    assert.throws(() => c.run(spyFs((d) => d === c.file)), /crashed/, c.label)
    const s = spyFs(); assert.equal(c.run(s, readManifest(c.w.dir)).ok, true, c.label); return s
  },
  O3(c) {
    assert.throws(() => c.run(spyFs((d, done) => done.includes(c.file))), /crashed/, c.label)
    const s = spyFs(); assert.equal(c.run(s, readManifest(c.w.dir)).ok, true, c.label); return s
  },
}

test('O1 · every json-key route: one on → one rename onto the file, one backup (only when the file existed) holding the pre bytes and not the door password', () => {
  for (const x of CELLS) {
    const c = cell(x)
    const s = SCENARIOS.O1(c)
    assert.equal(onto(c, s), 1, `${c.label}: one write`)
    const b = backups(c.w.home)
    assert.equal(b.length, c.pre ? 1 : 0, `${c.label}: one backup when there was a file`)
    for (const f of b) { assert.deepEqual(fs.readFileSync(f), c.pre, c.label); assert.ok(!fs.readFileSync(f, 'latin1').includes(PW), `${c.label}: no password in the backup`) }
  }
})

test('O2 · a crash at the intent, then on: every key in the file, still one backup, no record left without post_sha256', () => {
  for (const x of CELLS) {
    const c = cell(x)
    SCENARIOS.O2(c)
    const doc = JSON.parse(fs.readFileSync(c.file, 'utf8'))
    for (const k of [...(x.r.proxyKeys || []), ...(x.r.noProxyKeys || [])]) assert.notEqual(k.reduce((o, n) => o?.[n], doc), undefined, `${c.label}: ${k.join('.')}`)
    assert.equal(backups(c.w.home).length, c.pre ? 1 : 0, `${c.label}: the backup kept`)
    assert.ok(ons(c.w.dir).length > 0 && ons(c.w.dir).every((e) => e.post_sha256 != null), c.label)
  }
})

test('O3 · a crash after the write, then on: no further write onto the file, every post_sha256 set', () => {
  for (const x of CELLS) {
    const c = cell(x)
    const s = SCENARIOS.O3(c)
    assert.equal(onto(c, s), 0, `${c.label}: not written again`)
    assert.ok(ons(c.w.dir).length > 0 && ons(c.w.dir).every((e) => e.post_sha256 != null), c.label)
  }
})

test('O4 · off after each of O1–O3: the file is its pre-on bytes (gone when trocar made it), the backup gone, no on record left', async () => {
  for (const x of CELLS) for (const name of Object.keys(SCENARIOS)) {
    const c = cell(x)
    SCENARIOS[name](c)
    const first = ons(c.w.dir).find((e) => e.path === c.file)
    await undoHarnesses({ dir: c.w.dir, home: c.w.home, manifest: readManifest(c.w.dir), ids: null, procs: async () => [] })
    const label = `${name} ${c.label}`
    assert.deepEqual(bytesOf(c.file), c.pre, `${label}: the pre-on bytes`)
    assert.equal(sha256(bytesOf(c.file)), first.pre_sha256, label)
    assert.deepEqual(backups(c.w.home), [], `${label}: the backup goes`)
    assert.deepEqual(ons(c.w.dir), [], `${label}: no on record left`)
  }
})
