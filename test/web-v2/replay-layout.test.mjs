// 1.2 #9, the clamp half: a split's width (dragged, or read back from storage) never leaves [min, max], never takes more of its host
// than the host minus the margin the other side keeps, and pins to min when the host is too narrow to give the margin. Widths are
// generated across the axis: below min, inside, above max, not a number; hosts from too narrow to wide, and unknown (0).
import test from 'node:test'
import assert from 'node:assert/strict'
import { clampWidth } from '../../web/legacy/replay/layout.mjs'

const BOUNDS = [{ min: 220, max: 720, margin: 380 }, { min: 160, max: 560, margin: 360 }, { min: 100, max: 100, margin: 0 }]

test('1.2 #9: clampWidth keeps min ≤ width ≤ max, leaves the host its margin, and gives min when the host is too narrow', () => {
  for (const b of BOUNDS) {
    const widths = [-1, 0, b.min - 1, b.min, (b.min + b.max) / 2, b.max, b.max + 1, 5000, NaN, Infinity]
    const hosts = [0, b.min + b.margin - 1, b.min + b.margin, b.min + b.margin + 40, b.max + b.margin, 4000]
    for (const w of widths) for (const host of hosts) {
      const r = clampWidth(w, b, host), at = `${JSON.stringify(b)} w=${w} host=${host} → ${r}`
      assert.ok(r >= b.min && r <= b.max, at)
      if (host && host - b.margin >= b.min) assert.ok(r <= host - b.margin, at)
      if (host && host - b.margin < b.min) assert.equal(r, b.min, at)
    }
  }
})
