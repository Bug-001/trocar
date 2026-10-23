// 3.5 §冷路径 (D71 ②): a fold in the worker's background slices reads each record once — the decoded frames of a sealed segment
// outlive the slice that decoded them (keyed by the file's identity, not by the open), so a slice that ends inside a frame does not
// make the next slice decode it again.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import '../../src/query/named/index.mjs' // the named queries load the session module (an import cycle starts there)
import { extendSession } from '../../src/query/named/session.mjs'
import { openSealed } from '../../src/raw/reader.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'

test('decodes per frame ≤ 1.1 over a full fold of a multi-segment sealed session', { timeout: 300_000 }, async () => {
  const home = path.join(tmpDir('trocar-decodes-'), '.trocar')
  const s = bigSession({ home, growth: 6_000, subEvery: 4, subLanes: 2, seal: 1 << 20 })
  for (let k = 0; k < 3; k++) { s.append(40); await s.seal() }
  const raw = path.join(home, 'raw')
  const sealed = fs.readdirSync(raw).filter((f) => f.endsWith('.sealed'))
  assert.ok(sealed.length >= 3, `several sealed segments (${sealed.length})`)
  let frames = 0
  for (const f of sealed) { const sf = openSealed(path.join(raw, f)); frames += sf.frames.length; sf.close() }
  // the segment index is its own projection, built once (D59): what is counted is the fold reading the records back
  for (const f of sealed) await segmentIndex({ home, fs, segment: f.replace(/\.sealed$/, '') })

  const real = zlib.brotliDecompressSync
  let decodes = 0, slices = 0
  zlib.brotliDecompressSync = (...a) => { decodes++; return real(...a) }
  try {
    while (await extendSession({ home, fs, writer: true }, s.id, 2)) { slices++; await new Promise((r) => setImmediate(r)) }
  } finally { zlib.brotliDecompressSync = real }
  assert.ok(slices > 3, `the fold took several slices (${slices})`)
  assert.ok(decodes <= 1.1 * frames, `${decodes} decodes for ${frames} frames over ${slices} slices`)
})
