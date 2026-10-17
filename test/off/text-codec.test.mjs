// test/off/text-codec.test.mjs — src/off/text-codec.mjs against spec 4.6 「文件的编码」: one row per form of the table, the closed `why` set,
// the round trip, and — over every shape the independent generator (test/helpers/file-shapes.mjs) makes — determinable ⇔ ok.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeText, encodeText, WHY_TEXT, CHARSETS } from '../../src/off/text-codec.mjs'

const WHYS = Object.keys(WHY_TEXT) // the closed set is the table's keys
import { shapeCases, axes, decodeBytes } from '../helpers/file-shapes.mjs'

const B = (...xs) => Buffer.from(xs.flat())
const ZH = String.fromCodePoint(0x4e2d, 0x6587) // two CJK code points, built from code points, not from any code page
const le = (s) => [...Buffer.from(s, 'utf16le')]
const be = (s) => [...Buffer.from(s, 'utf16le').swap16()]

test('codec: the table, one row per form — a mark names the form and stays as U+FEFF at offset 0; no mark is strict UTF-8; null is a new UTF-8 file', () => {
  const rows = [
    [null, { ok: true, text: null, charset: 'utf8' }],
    [B(), { ok: true, text: '', charset: 'utf8' }],
    [Buffer.from(`K=${ZH}\n`), { ok: true, text: `K=${ZH}\n`, charset: 'utf8' }],
    [B([0xef, 0xbb, 0xbf], [...Buffer.from(`K=${ZH}\r\n`)]), { ok: true, text: `﻿K=${ZH}\r\n`, charset: 'utf8' }],
    [B([0xff, 0xfe], le(`K=${ZH}\n`)), { ok: true, text: `﻿K=${ZH}\n`, charset: 'utf16le' }],
    [B([0xfe, 0xff], be(`K=${ZH}\n`)), { ok: true, text: `﻿K=${ZH}\n`, charset: 'utf16be' }],
    [B([0xff, 0xfe]), { ok: true, text: '﻿', charset: 'utf16le' }],
    [B([0x00, 0x00, 0xfe, 0xff], [0, 0, 0, 0x4b]), { ok: false, why: 'utf32' }],
    [B([0xff, 0xfe, 0x00, 0x00], [0x4b, 0, 0, 0]), { ok: false, why: 'utf32' }],
    [B([0xff, 0xfe], le('K=1'), [0x41]), { ok: false, why: 'odd-length' }],
    [B([0xfe, 0xff], be('K'), [0xdc, 0x00]), { ok: false, why: 'invalid-utf16' }], // a lone low surrogate
    [B([0xef, 0xbb, 0xbf], [0x4b, 0x3d, 0xc3, 0x28]), { ok: false, why: 'invalid-utf8-after-bom' }],
    [B([0x4b, 0x3d, 0xd6, 0x41, 0x0a]), { ok: false, why: 'not-utf8-no-bom' }], // a lead byte with an ASCII byte after it
    [B(le('K=1\n')), { ok: false, why: 'nul-in-text' }], // UTF-16 without a mark is valid UTF-8 byte for byte
    [B([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00]), { ok: false, why: 'nul-in-text' }],
  ]
  for (const [bytes, want] of rows) assert.deepEqual(decodeText(bytes), want, bytes == null ? 'null' : bytes.toString('hex'))
})

test('codec: `why` is the closed set of spec 4.6, every one has a phrase, and nothing outside it comes out (also on random bytes)', () => {
  assert.deepEqual([...WHYS].sort(), ['invalid-utf16', 'invalid-utf8-after-bom', 'not-round-trip', 'not-utf8-no-bom', 'nul-in-text', 'odd-length', 'utf32'])
  for (const w of WHYS) assert.ok(typeof WHY_TEXT[w] === 'string' && WHY_TEXT[w].length > 10, w)
  let s = 7
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24
  for (let i = 0; i < 2000; i++) {
    const b = Buffer.from(Array.from({ length: i % 17 }, rnd))
    const d = decodeText(b)
    if (d.ok) assert.ok(encodeText(d.text, d.charset).equals(b), `ok means the round trip holds: ${b.toString('hex')}`)
    else assert.ok(WHYS.includes(d.why), `${d.why} for ${b.toString('hex')}`)
  }
})

test('codec: encodeText writes asight\'s non-ASCII text in each form and decodeText reads it back unchanged; an unknown charset is refused', () => {
  const t = `﻿# ${ZH} \u{1F600}\r\nPATH=/Users/${ZH} x/.asight\n`
  for (const cs of CHARSETS) {
    const b = encodeText(t, cs)
    assert.deepEqual(decodeText(b), { ok: true, text: t, charset: cs }, cs)
  }
  assert.deepEqual([...encodeText('﻿A', 'utf16be')], [0xfe, 0xff, 0x00, 0x41])
  assert.throws(() => encodeText('x', 'latin1'), /unknown charset/)
})

test('codec: over every generated shape of every format, determinable ⇔ ok; ok gives the shape\'s charset and its text (the mark as U+FEFF), not ok gives the why the generator\'s own table gives', () => {
  for (const format of Object.keys(axes.content)) {
    for (const c of shapeCases({ format })) {
      const d = decodeText(c.bytes)
      assert.equal(d.ok, c.determinable, `${c.id} seed=${c.seed} ${c.describe}`)
      if (d.ok) {
        assert.equal(d.charset, c.charset, c.id)
        assert.equal(d.text, (c.bom ? '﻿' : '') + c.text, c.id)
        assert.ok(encodeText(d.text, d.charset).equals(c.bytes), c.id)
      } else {
        // a shape is built as one `why` (c.why), but its bytes may fail an earlier gate of the same table first (UTF-16 without a mark whose
        // text is not valid UTF-8 either): the reason is the first gate failed, as the generator's independent table also says
        assert.equal(d.why, decodeBytes(c.bytes).why, `${c.id} ${c.describe}`)
      }
    }
  }
})
