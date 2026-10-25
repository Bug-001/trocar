// test/query/follow-history.test.mjs — following does not read more as sealed history grows (RFC 4.3 验收 #9; 3.5:40 设计界⑤, D71②).
// One generated session, without and with an extra stretch of history before its last calls: `quiet` (the main lane pauses for over
// two packs of subagent calls, so a sealed pack has no main step) with the main context open across it (`compactAt` large: its
// definitions grow old and lie far back). Each is folded whole by a worker that then seals its projection and fold log into small parts
// and frames (the worker's idle seal, at test size); a fresh worker follows the same last calls one by one. Per followed call, the
// bytes it reads of the projection and the fold log with the history ≤ without it + 2 frames (the largest sealed frame's compressed
// length; a part with no frame table is one frame); the sealed packs it leaves are a one-shot fold's bytes (the head it writes when
// due: 3.5:45).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { tmpDir } from '../helpers/tmp.mjs'
import { within } from '../helpers/bounded.mjs'
import { bigSession } from './big-session.mjs'
import '../../src/query/named/index.mjs'
import { extendSession } from '../../src/query/named/session.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { PACK_MEMBERS } from '../../src/query/ctx-files.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const SHAPE = { wire: 'http', growth: 600, subEvery: 3, subLanes: 2, subLen: 6, compactAt: 1e12 }
// the quiet stretch covers pack 1 (members 512 … 1023: one member a call) whole and keeps the calls after it in step with the
// session without it (a multiple of subEvery); the projection stays under PART_BYTES, so only the small seal cuts parts
const H = 90, Q = SHAPE.subEvery * Math.ceil((2 * PACK_MEMBERS - H + 6) / SHAPE.subEvery), F = 9, PART = 64 << 10, FRAME = 4 << 10

// a worker in a process of its own folds the session to its end and saves at idle; then (partBytes > 0) its projection and fold log
// are sealed into parts of partBytes and frames of frameBytes
const DRIVER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
const { openProjection } = await import(${at('../../src/query/projection.mjs')})
const { openFoldLog } = await import(${at('../../src/query/fold-log.mjs')})
const [home, id, partBytes, frameBytes] = [process.argv[1], process.argv[2], Number(process.argv[3]), Number(process.argv[4])]
while (await extendSession({ home, writer: true }, id, 1e9));
saveIndexes()
if (partBytes) {
  const p = openProjection({ home, key: id }), log = openFoldLog({ home, key: id, projection: { id: p.id, bytes: p.bytes } })
  const a = p.seal({ partBytes, frameBytes }), b = log.seal({ partBytes, frameBytes })
  if (!a || !b) process.exit(3)
  p.close(); log.close()
}
process.exit(0)`
async function fold(home, id, partBytes = 0) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', DRIVER, home, id, String(partBytes), String(FRAME)], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  c.stderr.on('data', (b) => { err += b })
  const code = await within(new Promise((ok) => c.on('close', ok)), 240_000, 'the fold process', () => c.kill('SIGKILL'))
  assert.equal(code, 0, `the fold process: ${err.split('\n').slice(0, 6).join(' / ')}`)
}

// the compressed length of each frame of a sealed part (4.3 §4 分片: the frame table at its end; a part with none is one frame)
function framesOf(file) {
  const b = fs.readFileSync(file), n = b.length >= 8 ? b.readUInt32LE(b.length - 8) : 0
  if (b.length < 8 || b.toString('latin1', b.length - 4) !== 'TRF1' || !n || 8 * n + 8 > b.length) return [b.length]
  return Array.from({ length: n }, (_, i) => b.readUInt32LE(b.length - 8 - 8 * n + 8 * i))
}
const LINES = /^(extract|fold)\./

// A followed session: `quiet` with the history, else without. → {reads: bytes read per followed call, frame: the largest sealed
// frame, home, id}
async function followed(quiet) {
  const home = path.join(tmpDir('trocar-fhist-'), '.trocar'), s = bigSession({ home, ...SHAPE, ...(quiet ? { quiet: [H, Q] } : {}) })
  s.append(H + (quiet ? Q : 0))
  await fold(home, s.id, PART)
  const dir = sessionDir(home, s.id)
  const sealed = fs.readdirSync(dir).filter((n) => LINES.test(n) && n.endsWith('.br'))
  assert.ok(sealed.length > (quiet ? 8 : 2), `${quiet ? 'with' : 'without'} the history: sealed parts (${sealed.length})`)
  const frame = Math.max(...sealed.flatMap((n) => framesOf(path.join(dir, n))))
  // a worker of its own (src/query/warm.mjs fsTag) over an fs that counts the bytes it reads of the projection and the fold log
  const fds = new Set(), mine = (p) => path.dirname(String(p)) === dir && LINES.test(path.basename(String(p)))
  let counting = false, bytes = 0
  const own = { ...fs,
    openSync(p, ...a) { const fd = fs.openSync(p, ...a); if (mine(p)) fds.add(fd); else fds.delete(fd); return fd },
    closeSync(fd) { fds.delete(fd); return fs.closeSync(fd) },
    readSync(fd, ...a) { const n = fs.readSync(fd, ...a); if (counting && fds.has(fd)) bytes += n; return n },
    readFileSync(p, ...a) { const b = fs.readFileSync(p, ...a); if (counting && mine(p)) bytes += b.length; return b },
  }
  // the worker opens the session again and follows its first call (its first slice renders its files: the cold path), then the rest
  const ctx = { home, fs: own, writer: true }
  s.append(1)
  while (await extendSession(ctx, s.id, Infinity));
  const reads = []
  for (let i = 1; i < F; i++) {
    s.append(1)
    bytes = 0; counting = true
    try { while (await extendSession(ctx, s.id, Infinity)); } finally { counting = false }
    reads.push(bytes)
  }
  return { reads, frame, home, id: s.id }
}

const PACKS = /^p\d+\.(main|rest)\.ndjson\.gz$/
const packs = (home, id) => {
  const dir = sessionDir(home, id)
  return Object.fromEntries(fs.readdirSync(dir).filter((n) => PACKS.test(n)).sort().map((n) => [n, gunzipSync(fs.readFileSync(path.join(dir, n))).toString('utf8')]))
}

test('4.3 #9: following reads per call at most what it reads without an older stretch of sealed history + 2 frames; its sealed packs are a one-shot fold\'s', { timeout: 600_000 }, async (t) => {
  const [without, wth] = await Promise.all([followed(false), followed(true)])
  const slack = 2 * wth.frame
  t.diagnostic(`bytes read per followed call, with the history: ${wth.reads}; without: ${without.reads}; 2 frames: ${slack}`)
  for (let i = 0; i < F - 1; i++) {
    assert.ok(wth.reads[i] <= without.reads[i] + slack,
      `call ${i + 2}: ${wth.reads[i]} bytes read with the history, ${without.reads[i]} without (+ 2 frames = ${slack}); all: ${wth.reads} / ${without.reads}`)
  }
  // the same raw folded in one shot, no parts sealed
  const one = path.join(tmpDir('trocar-fhist-one-'), '.trocar')
  fs.cpSync(path.join(wth.home, 'raw'), path.join(one, 'raw'), { recursive: true })
  await fold(one, wth.id)
  const got = packs(wth.home, wth.id), want = packs(one, wth.id)
  assert.ok(Object.keys(want).length >= 4, 'at least two sealed packs')
  assert.deepEqual(Object.keys(got), Object.keys(want), 'the same packs')
  for (const n of Object.keys(want)) assert.equal(got[n], want[n], `${n}: a one-shot fold's bytes`)
})
