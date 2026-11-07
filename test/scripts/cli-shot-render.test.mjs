// test/scripts/cli-shot-render.test.mjs — the PNG scripts/cli-shot.mjs writes holds every line of the text, once, and nothing else.
//
// Counts the bands of rows that hold any non-background pixel: each text line is one band. Skipped where neither renderer exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { CHROMES, playwright } from '../../scripts/cli-shot.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/cli-shot.mjs', import.meta.url))
const BG = [0x12, 0x14, 0x1a]
const skip = (await playwright()) || CHROMES.some((p) => fs.existsSync(p)) ? false : 'no renderer: neither playwright nor Google Chrome'

/** 8-bit RGB / RGBA non-interlaced PNG → { w, h, ch, px } with px the unfiltered rows. */
function decode(buf) {
  let off = 8, w, h, ch
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      assert.equal(data[8], 8, 'bit depth'); assert.equal(data[12], 0, 'interlace')
      ch = { 2: 3, 6: 4 }[data[9]]; assert.ok(ch, `colour type ${data[9]}`)
    } else if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]
      px[y * stride + x] = (src[x] + pred) & 255
    }
  }
  return { w, h, ch, px }
}

/** [first, last] row of every run of rows holding a non-background pixel. */
function bands({ w, h, ch, px }) {
  const out = []
  for (let y = 0; y < h; y++) {
    let ink = false
    for (let x = 0; x < w && !ink; x++) { const i = (y * w + x) * ch; ink = BG.some((v, k) => Math.abs(px[i + k] - v) > 8) }
    if (ink && out.length && out.at(-1)[1] === y - 1) out.at(-1)[1] = y
    else if (ink) out.push([y, y])
  }
  return out
}

function shot(lines) {
  const dir = tmpDir('trocar-shot-test-'), txt = path.join(dir, 'in.txt'), png = path.join(dir, 'out.png')
  fs.writeFileSync(txt, Array.from({ length: lines }, (_, i) => `line ${i + 1} ${'x'.repeat(i % 40)}`).join('\n') + '\n')
  const r = spawnSync(process.execPath, [SCRIPT, '--text', txt, '--out', png], { encoding: 'utf8', timeout: 90000 })
  assert.equal(r.status, 0, r.stderr)
  return decode(fs.readFileSync(png))
}

for (const n of [3, 30]) {
  test(`a ${n}-line text renders as ${n} text rows and nothing below the last`, { skip }, () => {
    const img = shot(n), b = bands(img)
    assert.equal(b.length, n, JSON.stringify(b))
    const pitch = (b.at(-1)[0] - b[0][0]) / Math.max(1, n - 1)
    assert.ok(img.h - b.at(-1)[1] < 2 * pitch, `last band ends at ${b.at(-1)[1]} of ${img.h}`)
  })
}
