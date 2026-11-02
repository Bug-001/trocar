// test/web-v2/harness-icons.test.mjs — the harness icon files (1.2 §agent chip, guard named there): every chip row has
// its file; the files are pairwise different (bytes) and none equals the unknown glyph; every file passes the loader's
// whitelist; the declared fills reach 3:1 on --panel and --paper in both themes, computed from the token values.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHIP, HARNESS_ORDER, sanitizeHarnessSvg, UNKNOWN_ICON } from '../../web/legacy/core/chips.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ICONS = path.join(HERE, '..', '..', 'web', 'legacy', 'assets', 'harness')
const fileOf = (id) => path.join(ICONS, CHIP[id].icon)

test('every chip row has its icon file, a 16×16 view box, and a title naming the harness', () => {
  for (const id of HARNESS_ORDER) {
    const p = fileOf(id)
    assert.ok(fs.existsSync(p), `${id}: ${CHIP[id].icon}`)
    const t = fs.readFileSync(p, 'utf8')
    assert.match(t, /viewBox="0 0 16 16"/, id)
    assert.match(t, /<title>/, `${id}: a reader-visible name`)
    assert.ok(t.length < 800, `${id}: a hand-drawn glyph, not an embedded bitmap`)
  }
})

test('every file passes the whitelist the loader will apply to it', () => {
  for (const id of HARNESS_ORDER) {
    const t = fs.readFileSync(fileOf(id), 'utf8')
    assert.ok(sanitizeHarnessSvg(t) != null, `${id}: its own file must survive sanitizeHarnessSvg`)
    assert.match(t, /currentColor/, `${id}: the monochrome parts follow the text`)
  }
})

test('the files are pairwise different, and none equals the unknown glyph', () => {
  const bodies = HARNESS_ORDER.map((id) => fs.readFileSync(fileOf(id), 'utf8'))
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++)
    assert.notStrictEqual(bodies[i], bodies[j], `${HARNESS_ORDER[i]} and ${HARNESS_ORDER[j]} are the same drawing`)
  const unknownInner = UNKNOWN_ICON.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
  for (let i = 0; i < bodies.length; i++)
    assert.ok(!bodies[i].includes('stroke-dasharray'), `${HARNESS_ORDER[i]}: the dashed square is the unknown agent's alone`)
})

// ── contrast: the declared fills against the four surfaces they can sit on, both themes ───────────────────────────────
const css = fs.readFileSync(path.join(HERE, '..', '..', 'web', 'legacy', 'css', 'base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
function decls(text) { return Object.fromEntries([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()])) }
function blockOf(text, sel) { const m = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((x) => x[1].trim() === sel); return m ? m[2] : '' }
// light = the defaults of :root; dark = the block inside the OS media query (balanced braces)
const darkAt = css.search(/@media[^{]*prefers-color-scheme:\s*dark/)
let darkBody = ''
for (let j = css.indexOf('{', darkAt), depth = 0; j < css.length; j++) {
  if (css[j] === '{') depth++
  else if (css[j] === '}') { depth--; if (depth === 0) { darkBody = css.slice(css.indexOf('{', darkAt) + 1, j); break } }
}
const themeVars = (sel, inMedia) => decls(blockOf(inMedia ? darkBody : css.slice(0, darkAt < 0 ? css.length : darkAt), sel))
const THEMES = { light: themeVars(':root', false), dark: themeVars(':root:not([data-theme="light"])', true) }
const ch = (x) => { const v = x / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const lum = (h) => 0.2126 * ch(parseInt(h.slice(1, 3), 16)) + 0.7152 * ch(parseInt(h.slice(3, 5), 16)) + 0.0722 * ch(parseInt(h.slice(5, 7), 16))
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const HEX = /^#[0-9a-fA-F]{6}$/

test('the scanner is not vacuous', () => {
  assert.ok(ratio('#000000', '#FFFFFF') > 4)
  assert.deepEqual([...'<path fill="#c25729" stroke="currentColor"/>'.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]), ['#c25729'])
})

test('every declared colour of every icon reaches 3:1 on --panel and --paper, in both themes', () => {
  for (const id of HARNESS_ORDER) {
    const t = fs.readFileSync(fileOf(id), 'utf8')
    const fills = [...t.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1])
    assert.ok(fills.length >= 1, `${id}: carries at least one brand-family colour`)
    for (const f of fills) for (const theme of ['light', 'dark']) for (const s of ['--panel', '--paper']) {
      const surf = THEMES[theme][s]
      assert.ok(HEX.test(surf), `${theme} ${s}`)
      assert.ok(ratio(f, surf) >= 3, `${id}: ${f} on ${theme} ${s} = ${ratio(f, surf).toFixed(2)}`)
    }
  }
})

test('SOURCES.md records every file as trocar 自绘', () => {
  const md = fs.readFileSync(path.join(ICONS, 'SOURCES.md'), 'utf8')
  for (const id of HARNESS_ORDER) assert.ok(md.includes(CHIP[id].icon), `${CHIP[id].icon} is recorded`)
  assert.ok(md.includes('trocar 自绘'))
})
