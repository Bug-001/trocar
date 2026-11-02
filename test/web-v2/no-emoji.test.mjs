// test/web-v2/no-emoji.test.mjs — 1.5 验收 #8: no `\p{Extended_Pictographic}` character in any .mjs, .css or .html under
// web/legacy (the UI's frame; verbatim content is runtime data and never sits in the sources). The allowed glyphs are
// ‹ › ▸ ▾ ▴ · ≈ ◐ ⓘ — ? × and the drawn icons. The scanner is proven not vacuous on a planted emoji.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'legacy')
const FILES = fs.readdirSync(V2, { recursive: true }).filter((p) => /\.(mjs|css|html)$/.test(p)).map((p) => path.join(V2, p)).concat(path.join(V2, '..', 'index.html'))
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

function emojiViolations(rel, text) {
  const out = []
  for (const ch of new Set(text)) if (PICTOGRAPHIC.test(ch)) out.push(`${rel}: ${ch} U+${ch.codePointAt(0).toString(16)}`)
  return out
}

test('the scanner is not vacuous: it catches a planted emoji, in a string and in a comment, and spares the allowed glyphs', () => {
  assert.deepEqual(emojiViolations('x.mjs', 'const a = "🟠"'), ['x.mjs: 🟠 U+1f7e0'])
  assert.notDeepEqual(emojiViolations('x.mjs', '// ⚠ a lamp in a comment'), [])
  assert.deepEqual(emojiViolations('x.mjs', '‹ › ▸ ▾ ▴ · ≈ ◐ ⓘ — ? ×'), [])
  assert.deepEqual(emojiViolations('x.css', '.a::after{content:"▾"}'), [])
})

test('no .mjs / .css / .html under web/legacy carries an emoji character', () => {
  assert.ok(FILES.some((f) => f.endsWith('main.mjs')), 'the walk reaches the tree')
  const bad = FILES.flatMap((f) => emojiViolations(path.relative(V2, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')))
  assert.deepEqual(bad, [])
})
