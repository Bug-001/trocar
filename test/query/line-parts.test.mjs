// test/query/line-parts.test.mjs — 4.3 §4 分片 (acceptance 4.3 #17): a line file is sealed parts `<name>.<a>-<b>.br` (the brotli of
// its global bytes [a, b), cut at a line end, chaining from 0) and one plain tail `<name>.<T>.ndjson`. Over seeded line sequences
// (1 B to 3 MiB, non-ASCII, lines that end exactly where a part ends) sealed at random points: every line reads back by its offset;
// a seal killed at any of its writes reopens to the same lines and one tail; a part deleted or not decoding rebuilds the store.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { tmpDir } from '../helpers/tmp.mjs'
import { lineFile, releaseParts } from '../../src/query/line-file.mjs'
import { openProjection, sessionDir } from '../../src/query/projection.mjs'
import { openFoldLog } from '../../src/query/fold-log.mjs'

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
const CHARS = ['a', 'z', ' ', 'é', 'ж', '中', '😀', '"', '\\']
function lineOf(r) {
  const u = r(), n = u < 0.01 ? (3 << 20) - Math.floor(r() * 64) : u < 0.1 ? Math.floor(r() * 40_000) : 1 + Math.floor(r() * 200)
  const out = []
  for (let b = 0; b < n - 1;) { const c = CHARS[Math.floor(r() * CHARS.length)].repeat(1 + Math.floor(r() * 50)); out.push(c); b += Buffer.byteLength(c) }
  return `${out.join('')}\n`
}
const NAMES = /^x\.(?:(\d+)-(\d+)\.br|(\d+)\.ndjson)$/
// the disk is parts chaining from 0 and exactly one tail, from where they end
function shape(dir, tag) {
  const names = fs.readdirSync(dir).filter((n) => n.startsWith('x.') && n !== 'x.idx')
  const ms = names.map((n) => NAMES.exec(n))
  assert.ok(ms.every(Boolean), `${tag}: only parts and a tail: ${names}`)
  const parts = ms.filter((m) => m[1]).map((m) => [+m[1], +m[2]]).sort((a, b) => a[0] - b[0]), tails = ms.filter((m) => m[3])
  let c = 0
  for (const [a, b] of parts) { assert.equal(a, c, `${tag}: the parts chain`); assert.ok(b > a); c = b }
  assert.equal(tails.length, 1, `${tag}: one tail: ${names}`)
  assert.equal(+tails[0][3], c, `${tag}: the tail starts where the parts end`)
  return { parts, c }
}
function readsBack(dir, want, tag) {
  releaseParts()
  const lf = lineFile({ fs, base: path.join(dir, 'x') })
  assert.equal(lf.unreadable, null, tag)
  assert.equal(lf.bytes, want.reduce((a, l) => a + l.len, 0), `${tag}: the bytes`)
  for (const l of want) assert.ok(lf.read(l.off, l.len).equals(l.buf), `${tag}: the line at ${l.off}`)
  lf.close()
}

test('4.3 #17: every line reads back by its offset whatever was sealed; the disk is parts from 0 and one tail', { timeout: 300_000 }, () => {
  for (const seed of [1, 2, 3]) {
    const r = rng(seed), dir = tmpDir('trocar-parts-'), lf = lineFile({ fs, base: path.join(dir, 'x') }), want = []
    for (let i = 0; i < 300; i++) {
      const buf = Buffer.from(lineOf(r)), off = lf.append(buf.toString())
      want.push({ off, len: buf.length, buf })
      if (r() < 0.08) {
        // a part size that ends exactly at a line end, or any
        const t = shape(dir, `seed ${seed}`).c, ends = want.filter((l) => l.off + l.len > t).map((l) => l.off + l.len - t)
        const partBytes = r() < 0.5 ? ends[Math.floor(r() * ends.length)] : 1 + Math.floor(r() * 300_000)
        lf.seal({ partBytes })
        shape(dir, `seed ${seed} after a seal`)
        for (const l of want) assert.ok(lf.read(l.off, l.len).equals(l.buf), `seed ${seed}: the line at ${l.off}, same process`)
      }
    }
    lf.close()
    assert.ok(shape(dir, `seed ${seed}`).parts.length > 1, `seed ${seed}: parts were sealed`)
    readsBack(dir, want, `seed ${seed}: reopened`)
  }
})

test('4.3 #17: a seal killed after any of its writes reopens to the same lines and one tail', { timeout: 300_000 }, () => {
  const r = rng(9), src = tmpDir('trocar-parts-'), want = []
  const lf = lineFile({ fs, base: path.join(src, 'x') })
  for (let i = 0; i < 60; i++) { const buf = Buffer.from(lineOf(r)); want.push({ off: lf.append(buf.toString()), len: buf.length, buf }) }
  lf.seal({ partBytes: 50_000 }) // a part already there: the next seal chains on it
  for (let i = 0; i < 60; i++) { const buf = Buffer.from(lineOf(r)); want.push({ off: lf.append(buf.toString()), len: buf.length, buf }) }
  lf.close()
  const seen = new Set()
  for (let k = 1; ; k++) {
    const dir = tmpDir('trocar-parts-kill-')
    fs.cpSync(src, dir, { recursive: true })
    let n = 0 // the process dies at its k-th write: every write after fails too
    const kill = (f) => (...a) => { if (++n >= k) throw Object.assign(new Error('killed'), { code: 'KILLED' }); return f(...a) }
    const dying = { ...fs, writeFileSync: kill(fs.writeFileSync), fsyncSync: kill(fs.fsyncSync), renameSync: kill(fs.renameSync), rmSync: kill(fs.rmSync) }
    let done = false
    try { lineFile({ fs: dying, base: path.join(dir, 'x') }).seal({ partBytes: 10_000 }); done = true } catch (e) { if (e.code !== 'KILLED') throw e }
    // where in the seal's order it was killed (4.3 §4 分片)
    const names = fs.readdirSync(dir), m = names.map((n) => NAMES.exec(n)).filter(Boolean)
    const c = Math.max(0, ...m.filter((x) => x[2]).map((x) => +x[2])), t = Math.min(...m.filter((x) => x[3]).map((x) => +x[3]))
    if (names.some((n) => n.endsWith('.br.tmp'))) seen.add('a part tmp left')
    if (t < c) seen.add('a part renamed, the old tail there')
    if (names.some((n) => n.endsWith('.ndjson.tmp'))) seen.add('the new tail tmp left')
    readsBack(dir, want, `killed at write ${k}`)
    shape(dir, `killed at write ${k}, reopened`)
    if (done) break
  }
  assert.deepEqual([...seen].sort(), ['a part renamed, the old tail there', 'a part tmp left', 'the new tail tmp left'])
})

// a store whose lines are sealed into parts, one part of `name` damaged: the next open of that store rebuilds it with one note
function damaged(name, damage) {
  const home = tmpDir('trocar-parts-store-'), key = 'session-parts', errors = []
  const p = openProjection({ home, fs, key, errors })
  for (let i = 1; i <= 40; i++) p.append({ defs: [{ bid: `b${i}`, text: `${'ж'.repeat(300)} ${i}` }], rows: [{ rid: `20261021T054349Z:${i}`, bids: [`b${i}`] }] })
  const log = openFoldLog({ home, fs, key, projection: { id: p.id, bytes: p.bytes }, errors })
  for (let i = 1; i <= 40; i++) log.append([{ c: `20261021T054349Z:${i}`, s: '中'.repeat(200) }, { f: `20261021T054349Z:${i}`, n: i, pb: p.bytes }])
  assert.ok(p.seal({ partBytes: 4096 }) && log.seal({ partBytes: 4096 }))
  p.close(); log.close()
  assert.deepEqual(errors, [])
  releaseParts()
  const dir = sessionDir(home, key)
  damage(path.join(dir, fs.readdirSync(dir).filter((n) => n.startsWith(`${name}.`) && n.endsWith('.br')).sort()[1]))
  const again = [], q = openProjection({ home, fs, key, errors: again })
  const l = name === 'fold' ? openFoldLog({ home, fs, key, projection: { id: q.id, bytes: q.bytes }, errors: again }) : null
  return { again, held: name === 'fold' ? l.changedSince(-1).rids.length : [...q.rows.keys()].length }
}

test('4.3 #17: a part deleted or not decoding: the store is rebuilt, with one projection-rebuilt note', () => {
  const flip = (f) => { const b = fs.readFileSync(f); b[3] ^= 0xff; b[Math.floor(b.length / 2)] ^= 0x5a; fs.writeFileSync(f, b) }
  const garble = (f) => fs.writeFileSync(f, zlib.brotliCompressSync(Buffer.from('not the bytes it held\n')))
  for (const [where, name] of [['projection', 'extract'], ['fold-log', 'fold']]) {
    for (const [tag, damage] of [['deleted', (f) => fs.rmSync(f)], ['flipped', flip], ['another length', garble]]) {
      const { again, held } = damaged(name, damage)
      assert.deepEqual(again.map((e) => [e.where, e.code, e.level]), [[where, 'projection-rebuilt', 'note']], `${name} ${tag}`)
      assert.equal(held, 0, `${name} ${tag}: the store starts empty`)
    }
  }
})
