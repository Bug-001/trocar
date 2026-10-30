// native-pin.test.mjs — CM34 (RFC 4.11, RFC 4.9 §3 ⑮): the committed macOS native binaries are exactly the pinned ones, and
// each is a universal Mach-O with an arm64 and an x86_64 slice. Read as bytes in JS: no tool runs, the binaries never run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NATIVE, nativePath, pins, sha256 } from '../../../../src/collector/arch/darwin/native.mjs'

const FAT_MAGIC = 0xcafebabe
const MH_MAGIC_64 = 0xfeedfacf
const CPU = { 0x0100000c: 'arm64', 0x01000007: 'x86_64' }

/** The slices of a fat Mach-O: [{ arch, magic }] (the fat header is big-endian, each 64-bit slice header little-endian). */
function fatSlices(buf) {
  assert.equal(buf.readUInt32BE(0), FAT_MAGIC, 'a Mach-O fat file (0xCAFEBABE)')
  const n = buf.readUInt32BE(4)
  return Array.from({ length: n }, (_, i) => {
    const at = 8 + i * 20
    const offset = buf.readUInt32BE(at + 8), size = buf.readUInt32BE(at + 12)
    assert.ok(offset + size <= buf.length, 'the slice lies inside the file')
    return { arch: CPU[buf.readUInt32BE(at)] || `cpu ${buf.readUInt32BE(at).toString(16)}`, magic: buf.readUInt32LE(offset) }
  })
}

test('CM34: pins.json names every native piece, and nothing else', () => {
  assert.deepEqual(Object.keys(pins()).sort(), Object.values(NATIVE).sort())
})

for (const name of Object.values(NATIVE)) {
  test(`CM34: ${name} is the pinned binary and a universal arm64 + x86_64 Mach-O`, () => {
    const bytes = fs.readFileSync(nativePath(name))
    assert.equal(sha256(bytes), pins()[name], `${name}'s sha256 differs from native/pins.json: rebuild only with scripts/build-darwin-native.sh and commit both`)
    const slices = fatSlices(bytes)
    assert.deepEqual(slices.map((s) => s.arch).sort(), ['arm64', 'x86_64'])
    for (const s of slices) assert.equal(s.magic, MH_MAGIC_64, `${s.arch} slice is a 64-bit Mach-O`)
    assert.ok(fs.statSync(nativePath(name)).mode & 0o111, `${name} is executable`)
  })
}

test('CM34: the fat parser goes red on a thin binary and on a missing slice', () => {
  assert.throws(() => fatSlices(Buffer.from('cffaedfe0c000001', 'hex')))
  const one = Buffer.alloc(64); one.writeUInt32BE(FAT_MAGIC, 0); one.writeUInt32BE(1, 4); one.writeUInt32BE(0x0100000c, 8)
  one.writeUInt32BE(32, 16); one.writeUInt32BE(32, 20); one.writeUInt32LE(MH_MAGIC_64, 32)
  assert.notDeepEqual(fatSlices(one).map((s) => s.arch).sort(), ['arm64', 'x86_64'])
})
