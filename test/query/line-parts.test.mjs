// test/query/line-parts.test.mjs — 4.3 §4 分片 (acceptance 4.3 #8): a line file is sealed parts `<name>.<a>-<b>.br` (its global
// bytes [a, b), cut at a line end, chaining from 0, as brotli frames that each decode alone, then the frame table) and one plain tail
// `<name>.<T>.ndjson`. Over seeded line sequences (1 B to 3 MiB, non-ASCII, lines that end exactly where a part ends, lines longer
// than a frame) sealed at random points with random part and frame sizes: every line reads back by its offset, and a read reads from
// disk at most the frame that holds the line and the table, in any order, cold or not; a seal killed at any of its writes reopens to
// the same lines and one tail; a part deleted, not decoding, of the format before frames or with a table that does not tile it, found
// at the open or at its first read after a sidecar open, rebuilds that line file with one note and answers what the undamaged home
// answers.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { tmpDir } from '../helpers/tmp.mjs'
import { lineFile, releaseParts } from '../../src/query/line-file.mjs'
import { openProjection, sessionDir } from '../../src/query/projection.mjs'
import { openFoldLog } from '../../src/query/fold-log.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { extendSession, saveIndexes } from '../../src/query/named/session.mjs'

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
// a sealed part's frames as 4.3 §4 分片 lays them out: each frame's brotli in turn, then the table (per frame: compressed length,
// plain length; u32 LE), the frame count, "TRF1". The table tiles the file; each frame decodes alone to whole lines of `plain` (the
// part's bytes), in order.
function framesOf(file, plain) {
  const b = fs.readFileSync(file), n = b.length >= 8 ? b.readUInt32LE(b.length - 8) : 0, table = 8 * n + 8
  assert.ok(b.length >= 8 && b.toString('latin1', b.length - 4) === 'TRF1' && n > 0 && table <= b.length, `${path.basename(file)}: a frame table`)
  const frames = []
  let c = 0, q = 0
  for (let i = 0; i < n; i++) {
    const zc = b.readUInt32LE(b.length - table + 8 * i), zq = b.readUInt32LE(b.length - table + 8 * i + 4), x = zlib.brotliDecompressSync(b.subarray(c, c + zc))
    assert.ok(x.length === zq && x[zq - 1] === 10 && (!plain || x.equals(plain.subarray(q, q + zq))), `${path.basename(file)}: frame ${i} decodes alone to its lines`)
    frames.push({ q, zq, zc }); c += zc; q += zq
  }
  assert.equal(c + table, b.length, `${path.basename(file)}: the table tiles it`)
  if (plain) assert.equal(q, plain.length, `${path.basename(file)}: the frames hold the part's bytes`)
  return { frames, table }
}
const plainOf = (file) => { const { frames } = framesOf(file); const b = fs.readFileSync(file); let c = 0; return Buffer.concat(frames.map((f) => zlib.brotliDecompressSync(b.subarray(c, (c += f.zc))))) }
// each line read through a fresh handle in a seeded order, the decoded frames dropped before about half of them: the bytes read
// from a part ≤ the frame that holds the line + the table
function readsFrames(dir, want, r, tag) {
  const { parts } = shape(dir, tag), lay = parts.map(([a, b]) => {
    const plain = Buffer.concat(want.filter((l) => l.off >= a && l.off < b).map((l) => l.buf))
    return { a, b, ...framesOf(path.join(dir, `x.${a}-${b}.br`), plain) }
  })
  let read = 0
  const fds = new Set(), counting = { ...fs,
    openSync(p, ...x) { const fd = fs.openSync(p, ...x); if (String(p).endsWith('.br')) fds.add(fd); else fds.delete(fd); return fd },
    closeSync(fd) { fds.delete(fd); return fs.closeSync(fd) },
    readSync(fd, ...x) { const n = fs.readSync(fd, ...x); if (fds.has(fd)) read += n; return n },
    readFileSync(p, ...x) { const b = fs.readFileSync(p, ...x); if (String(p).endsWith('.br')) read += b.length; return b },
  }
  const order = want.map((l) => [r(), l]).sort((x, y) => x[0] - y[0]).map(([, l]) => l)
  for (const l of order) {
    if (r() < 0.5) releaseParts()
    const lf = lineFile({ fs: counting, base: path.join(dir, 'x'), write: false })
    read = 0
    assert.ok(lf.read(l.off, l.len).equals(l.buf), `${tag}: the line at ${l.off}`)
    lf.close()
    const p = lay.find((x) => l.off >= x.a && l.off < x.b), f = p && p.frames.find((x) => l.off - p.a >= x.q && l.off - p.a < x.q + x.zq)
    assert.ok(read <= (p ? f.zc + p.table : 0), `${tag}: the line at ${l.off} read ${read} bytes of parts (its frame ${f ? f.zc : 0} + the table ${p ? p.table : 0})`)
  }
}
function readsBack(dir, want, tag) {
  releaseParts()
  const lf = lineFile({ fs, base: path.join(dir, 'x') })
  assert.equal(lf.unreadable, null, tag)
  assert.equal(lf.bytes, want.reduce((a, l) => a + l.len, 0), `${tag}: the bytes`)
  for (const l of want) assert.ok(lf.read(l.off, l.len).equals(l.buf), `${tag}: the line at ${l.off}`)
  lf.close()
}

test('4.3 #8: every line reads back by its offset whatever was sealed; the disk is parts from 0 and one tail', { timeout: 300_000 }, () => {
  for (const seed of [1, 2, 3]) {
    const r = rng(seed), dir = tmpDir('trocar-parts-'), lf = lineFile({ fs, base: path.join(dir, 'x') }), want = []
    for (let i = 0; i < 300; i++) {
      const buf = Buffer.from(lineOf(r)), off = lf.append(buf.toString())
      want.push({ off, len: buf.length, buf })
      if (r() < 0.08) {
        // a part size that ends exactly at a line end, or any
        const t = shape(dir, `seed ${seed}`).c, ends = want.filter((l) => l.off + l.len > t).map((l) => l.off + l.len - t)
        const partBytes = r() < 0.5 ? ends[Math.floor(r() * ends.length)] : 1 + Math.floor(r() * 300_000)
        lf.seal({ partBytes, frameBytes: r() < 0.3 ? 1 + Math.floor(r() * 2_000) : 1 + Math.floor(r() * 100_000) })
        shape(dir, `seed ${seed} after a seal`)
        for (const l of want) assert.ok(lf.read(l.off, l.len).equals(l.buf), `seed ${seed}: the line at ${l.off}, same process`)
      }
    }
    lf.close()
    assert.ok(shape(dir, `seed ${seed}`).parts.length > 1, `seed ${seed}: parts were sealed`)
    readsBack(dir, want, `seed ${seed}: reopened`)
    readsFrames(dir, want, r, `seed ${seed}: one frame a read`)
  }
})

test('4.3 #8: a seal killed after any of its writes reopens to the same lines and one tail', { timeout: 300_000 }, () => {
  const r = rng(9), src = tmpDir('trocar-parts-'), want = []
  const lf = lineFile({ fs, base: path.join(src, 'x') })
  for (let i = 0; i < 60; i++) { const buf = Buffer.from(lineOf(r)); want.push({ off: lf.append(buf.toString()), len: buf.length, buf }) }
  lf.seal({ partBytes: 50_000, frameBytes: 7_000 }) // a part already there: the next seal chains on it
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
    try { lineFile({ fs: dying, base: path.join(dir, 'x') }).seal({ partBytes: 10_000, frameBytes: 3_000 }); done = true } catch (e) { if (e.code !== 'KILLED') throw e }
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

// A session read as every path reads it (runQuery: `session`, then `lane` for each of its lanes) → the answers without their errors,
// and the errors as [where, code, level].
async function answers(ctx, id) {
  const docs = [await runQuery('session', { id }, ctx)]
  for (const l of docs[0].lanes) docs.push(await runQuery('lane', { id, lane: l.lane }, ctx))
  return { text: JSON.stringify(docs.map(({ errors, ...d }) => d)), errors: docs.flatMap((d) => d.errors.map((e) => [e.where, e.code, e.level])) }
}
const drain = async (ctx, id) => { if (ctx.writer) for (let i = 0; i < 500 && await extendSession(ctx, id, Infinity); i++); }

test('4.3 #8: a part deleted or not decoding, found at the open or at its first read: one projection-rebuilt note, the same answers', { timeout: 300_000 }, async () => {
  // a session whose projection and fold log are sealed into small parts, their sidecars saved (the worker's idle period)
  const base = path.join(tmpDir('trocar-parts-home-'), '.trocar'), s = bigSession({ home: base, wire: 'http', growth: 200, subEvery: 3 })
  s.append(12)
  await drain({ home: base, fs, writer: true }, s.id)
  saveIndexes()
  const fsx = { ...fs }, p = openProjection({ home: base, fs: fsx, key: s.id }), log = openFoldLog({ home: base, fs: fsx, key: s.id, projection: { id: p.id, bytes: p.bytes } })
  assert.ok(p.seal({ partBytes: 4096 }) && log.seal({ partBytes: 4096 }))
  p.close(); log.close(); releaseParts()
  const flip = (f) => { const b = fs.readFileSync(f); b[3] ^= 0xff; b[Math.floor(b.length / 2)] ^= 0x5a; fs.writeFileSync(f, b) }
  const garble = (f) => fs.writeFileSync(f, zlib.brotliCompressSync(Buffer.from('not the bytes it held\n')))
  const unframed = (f) => fs.writeFileSync(f, zlib.brotliCompressSync(plainOf(f))) // the part as sealed before frames: one brotli of its bytes
  const untiled = (f) => fs.writeFileSync(f, Buffer.concat([Buffer.from([0]), fs.readFileSync(f)]))
  const copy = () => { const h = path.join(tmpDir('trocar-parts-case-'), '.trocar'); fs.cpSync(base, h, { recursive: true }); return h }
  for (const writer of [true, false]) {
    const want = (await answers({ home: copy(), fs: { ...fs }, writer }, s.id)).text
    for (const [where, name] of [['projection', 'extract'], ['fold-log', 'fold']]) {
      for (const [kind, damage] of [['deleted', (f) => fs.rmSync(f)], ['flipped', flip], ['another length', garble], ['unframed', unframed], ['untiled', untiled]]) {
        for (const sidecar of [false, true]) {
          const tag = `${writer ? 'worker' : 'local'} · ${name} ${kind} · ${sidecar ? 'sidecar: decoded at its first read' : 'no sidecar: the open scans'}`
          const home = copy(), dir = sessionDir(home, s.id), ctx = { home, fs: { ...fs }, writer }
          damage(path.join(dir, fs.readdirSync(dir).filter((n) => n.startsWith(`${name}.`) && n.endsWith('.br')).sort()[1]))
          if (!sidecar) for (const n of ['extract.idx', 'fold.idx']) fs.rmSync(path.join(dir, n))
          releaseParts()
          const first = await answers(ctx, s.id)
          // the fold log names the projection it was folded from (4.3 §4 折叠日志 `pid`): a rebuilt projection rebuilds it too, with its own note
          const notes = (where === 'projection' ? ['projection', 'fold-log'] : [where]).map((w) => [w, 'projection-rebuilt', 'note'])
          assert.deepEqual(first.errors.sort(), notes.sort(), `${tag}: the first read`)
          if (!writer) assert.equal(first.text, want, `${tag}: the first read's answers`)
          await drain(ctx, s.id)
          for (let k = 2; k <= 3; k++) {
            const later = await answers(ctx, s.id)
            assert.deepEqual(later.errors, [], `${tag}: read ${k}`)
            assert.equal(later.text, want, `${tag}: read ${k}'s answers`)
          }
          // the worker rebuilt the line file: every part left on disk is framed (none of the format before frames is read again)
          if (writer) for (const n of fs.readdirSync(dir).filter((m) => m.endsWith('.br'))) framesOf(path.join(dir, n))
        }
      }
    }
  }
})

// A handle whose index predates another handle's cut-back (settle truncates the tail in place, then appends) reads that handle's
// lines at its own offsets: lines of other lengths (k bytes longer or shorter) put no whole line there (4.3 §4 分片).
test('4.3 #8: a line read by its index after the tail was cut back and written again is no whole line: ELINEPART, never other bytes', () => {
  const PROJ = { id: 'proj-gen', bytes: 1e9 }, pad = (n) => 'x'.repeat(n)
  for (const k of [1, 2, 3, 4, 5, 6, 7, 40, -3]) {
    const home = path.join(tmpDir('trocar-gen-'), '.trocar'), open = (o = {}) => openFoldLog({ home, fs, key: 'gen', projection: PROJ, errors: [], ...o })
    const later = (d) => [{ c: 'r2', s: pad(20 + d) }, { c: 'r1', s: pad(30 + d) }, { l: 'lane', s: pad(5 + d) }, { f: 'r2', n: 2, pb: 1 }]
    const w = open()
    w.append([{ c: 'r1', s: pad(10) }, { f: 'r1', n: 1, pb: 1 }])
    const upTo = w.bytes, f1 = w.frontierAt('r1')
    w.append(later(0)); w.close()
    const a = open() // F1 and F2 indexed, no line read yet
    const b = open({ upTo }) // cut back to F1, then written again with lines of other lengths
    b.append(later(k))
    for (const [what, at] of [['r2', a.latest('r2')], ['r1', a.latest('r1')], ['lane', a.lane('lane')]]) {
      assert.ok(at[0] >= upTo, `k=${k} ${what}: indexed past F1`)
      assert.throws(() => a.read(...at), { code: 'ELINEPART' }, `k=${k} ${what}: read`)
      assert.throws(() => a.peek(...at), { code: 'ELINEPART' }, `k=${k} ${what}: peek`)
      if (what !== 'lane') assert.throws(() => a.versionAt(what, f1), { code: 'ELINEPART' }, `k=${k} ${what}: versionAt`)
    }
    a.close(); b.close()
  }
})

// The same at the session: the first line read from a tail (`fold.<T>.ndjson`, `extract.<T>.ndjson`) reads k bytes on, as a handle
// would that outlived another's cut-back. The read that meets it lets the session go and rereads once in the same request.
test('4.3 #8: a line read by its index that is another generation\'s bytes: reread in the same request, the same answers, no error', { timeout: 300_000 }, async () => {
  const base = path.join(tmpDir('trocar-gen-home-'), '.trocar'), s = bigSession({ home: base, wire: 'http', growth: 200, subEvery: 3 })
  s.append(12)
  await drain({ home: base, fs, writer: true }, s.id)
  saveIndexes()
  const copy = () => { const h = path.join(tmpDir('trocar-gen-case-'), '.trocar'); fs.cpSync(base, h, { recursive: true }); return h }
  for (const writer of [true, false]) {
    const want = (await answers({ home: copy(), fs: { ...fs }, writer }, s.id)).text
    for (const name of ['fold', 'extract']) {
      for (const k of [1, 4, 40]) {
        const tag = `${writer ? 'worker' : 'local'} · ${name} · ${k} B on`, tail = new RegExp(`^${name}\\.\\d+\\.ndjson$`), fds = new Set()
        let shifted = 0
        const fsx = { ...fs,
          openSync: (p, ...r) => { const fd = fs.openSync(p, ...r); if (tail.test(path.basename(String(p)))) fds.add(fd); return fd },
          closeSync: (fd) => { fds.delete(fd); return fs.closeSync(fd) },
          // a line read (its exact length, not a scan's chunk or a one-byte line-end check), once
          readSync: (fd, buf, o, n, pos) => { if (!shifted && fds.has(fd) && n > 1 && buf.length === n) { shifted++; pos += k } return fs.readSync(fd, buf, o, n, pos) } }
        const got = await answers({ home: copy(), fs: fsx, writer }, s.id)
        assert.equal(shifted, 1, `${tag}: a line was read from the tail`)
        assert.deepEqual(got.errors, [], `${tag}: no error`)
        assert.equal(got.text, want, `${tag}: the answers`)
      }
    }
  }
})

// stderr lines said while f() runs (in this process: the line file says its faults here)
function stderrOf(f) {
  const said = [], write = process.stderr.write
  process.stderr.write = (c, ...r) => { said.push(String(c)); return typeof r[r.length - 1] === 'function' ? (r[r.length - 1](), true) : true }
  try { f() } finally { process.stderr.write = write }
  return said.join('').split('\n').filter(Boolean)
}
const linesOf = (r, n) => Array.from({ length: n }, () => lineOf(r)).filter((l) => Buffer.byteLength(l) < 40_000)

// 4.3 §4 分片 「写者只在它的索引所说的末尾写」: a handle whose files were changed by someone else (its directory removed as the GC
// does, or the tail cut back and written again by another handle) writes nothing: append, seal and saveSidecar throw ELINEPART, and
// no file of its line file holds its lines afterwards.
test('4.3 #8: a writer whose tail on disk is not the length it knows writes nothing: ELINEPART', () => {
  for (const [seed, how, sealed] of [[1, 'removed', false], [2, 'removed', true], [3, 'rewritten', false], [4, 'rewritten', true]]) {
    const r = rng(seed), dir = path.join(tmpDir('trocar-mine-'), 'ctx', 'k'), base = path.join(dir, 'x'), tag = `${how}${sealed ? ' after a seal' : ''}`
    const a = lineFile({ fs, base })
    for (const l of linesOf(r, 40)) a.append(l)
    if (sealed) a.seal({ partBytes: 4 << 10, frameBytes: 1 << 10 })
    const mark = `{"mine":"${'q'.repeat(64)}"}\n`
    if (how === 'removed') fs.rmSync(dir, { recursive: true, force: true })
    else { const b = lineFile({ fs, base }); b.cut(Math.floor(b.bytes / 2)); b.append('{"other":1}\n'); b.close() }
    const before = fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n))]) : null
    assert.throws(() => a.append(mark), { code: 'ELINEPART' }, `${tag}: append`)
    assert.throws(() => a.saveSidecar({ head: { bytes: a.bytes }, parts: [] }), { code: 'ELINEPART' }, `${tag}: saveSidecar`)
    try { a.seal({ partBytes: 1, frameBytes: 1 }) } catch (e) { assert.equal(e.code, 'ELINEPART', `${tag}: seal`) }
    const after = fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n))]) : null
    assert.deepEqual(after, before, `${tag}: the files are as the other writer left them`)
    a.close()
  }
})

// 4.3 §4 分片: a part that does not decode at its first read after the open says the same one stderr line per base as a line that is
// no whole line: `trocar query: <dir>: …`, once.
test('4.3 #8: a part gone under an open handle: the read throws ELINEPART and stderr says one line for that directory', () => {
  const r = rng(5), dir = path.join(tmpDir('trocar-said-'), 'ctx', 'k'), base = path.join(dir, 'x')
  const w = lineFile({ fs, base }), want = []
  for (const l of linesOf(r, 60)) want.push({ off: w.append(l), len: Buffer.byteLength(l) - 1 })
  w.seal({ partBytes: 4 << 10, frameBytes: 1 << 10 }); w.close()
  releaseParts()
  const a = lineFile({ fs, base, write: false })
  const part = fs.readdirSync(dir).find((n) => n.endsWith('.br')), [p0, p1] = part.match(/(\d+)-(\d+)/).slice(1).map(Number)
  fs.rmSync(path.join(dir, part))
  const inPart = want.filter((l) => l.off >= p0 && l.off + l.len < p1)
  assert.ok(inPart.length > 1, 'lines in the part')
  const said = stderrOf(() => { for (const l of inPart.slice(0, 2)) assert.throws(() => a.json(l.off, l.len), { code: 'ELINEPART' }) })
  assert.equal(said.length, 1, `one line: ${said}`)
  assert.ok(said[0].startsWith(`trocar query: ${dir}`), said[0])
  a.close()
})
