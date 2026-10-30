// test/web-v2/contrast.test.mjs — 1.5 §审美 #7, computed from the token values of css/base.css, both themes, no browser:
// text colours ≥ 4.5:1 on every surface they may sit on; lamp colours, the trace, control edges and the data colours
// ≥ 3:1 on the surfaces they are drawn over; the primary button's ink ≥ 4.5:1 on its own action fill.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2', 'css', 'base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

// the light values are the defaults of :root; the dark ones sit inside the OS media query (balanced braces)
function declsOf(text) {
  const out = {}
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
function bodyOf(text, sel) {
  const m = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((x) => x[1].trim() === sel)
  return m ? m[2] : ''
}
const darkAt = css.search(/@media[^{]*prefers-color-scheme:\s*dark/)
const open = css.indexOf('{', darkAt)
let darkBody = ''
for (let j = open, depth = 0; j < css.length; j++) {
  if (css[j] === '{') depth++
  else if (css[j] === '}') { depth--; if (depth === 0) { darkBody = css.slice(open + 1, j); break } }
}
const beforeMedia = darkAt < 0 ? css : css.slice(0, darkAt)
const THEMES = {
  light: declsOf(bodyOf(beforeMedia, ':root')),
  dark: declsOf(bodyOf(darkBody, ':root:not([data-theme="light"])')),
}

// WCAG 2.x relative luminance and contrast ratio over #rrggbb (every token value here is a hex or an rgb() with alpha)
const chan = (x) => { const v = x / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const lum = (rgb) => 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2])
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
function parseColor(v) {
  v = String(v).trim()
  const hex = v.match(/^#([0-9a-f]{6})$/i) || v.match(/^#([0-9a-f]{8})$/i)
  if (hex) return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)]
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]]
  return null
}
const C = (theme, name) => { const c = parseColor(THEMES[theme][name]); assert.ok(c, `${theme} ${name} is not a solid colour (${THEMES[theme][name]})`); return c }

test('the scanner is not vacuous: it knows black on white passes and white on white fails', () => {
  assert.ok(ratio([0, 0, 0], [255, 255, 255]) >= 4.5)
  assert.ok(ratio([255, 255, 255], [255, 255, 255]) < 4.5)
  assert.deepEqual(parseColor('rgb(0 101 127 / .09)'), [0, 101, 127])
  assert.deepEqual(parseColor('#EEF1F0'), [238, 241, 240])
})

// 1.5 §验收 #7: the ink colours and the status text colours on every surface ≥ 4.5:1
const TEXT = ['--ink', '--ink-2', '--ink-3', '--action', '--bad', '--warn', '--ok']
// lamps, the trace and control edges are drawn on these surfaces; data colours on the chart surfaces
const CONTROL = ['--bad-lamp', '--warn-lamp', '--note-lamp', '--trace', '--control-edge']
const SURFACES = ['--paper', '--panel', '--raised', '--scope', '--sunk']
const DATA = ['--ct-tools', '--ct-system', '--ct-user', '--ct-assistant', '--ct-thinking', '--ct-tooluse', '--ct-result', '--ct-hatch']
const CHART = ['--scope', '--raised', '--paper']

test('text colours reach 4.5:1 on every surface, in both themes', () => {
  for (const theme of ['light', 'dark']) for (const t of TEXT) for (const s of SURFACES)
    assert.ok(ratio(C(theme, t), C(theme, s)) >= 4.5, `${theme}: ${t} on ${s} = ${ratio(C(theme, t), C(theme, s)).toFixed(2)}`)
})
test('the primary button keeps its own ink readable in both themes', () => {
  for (const theme of ['light', 'dark']) assert.ok(ratio(C(theme, '--action-ink'), C(theme, '--action')) >= 4.5, theme)
})
test('lamps, the trace and control edges reach 3:1 on the surfaces they sit on, in both themes', () => {
  for (const theme of ['light', 'dark']) for (const l of CONTROL) for (const s of ['--paper', '--panel', '--raised', '--scope'])
    assert.ok(ratio(C(theme, l), C(theme, s)) >= 3, `${theme}: ${l} on ${s} = ${ratio(C(theme, l), C(theme, s)).toFixed(2)}`)
})
test('data colours reach 3:1 on the chart surfaces, in both themes', () => {
  for (const theme of ['light', 'dark']) for (const d of DATA) for (const s of CHART)
    assert.ok(ratio(C(theme, d), C(theme, s)) >= 3, `${theme}: ${d} on ${s} = ${ratio(C(theme, d), C(theme, s)).toFixed(2)}`)
})
// 1.5 §审美 #7 for the block cells (RFC 2.3 §两种模式): the diff hunk and JSON-tree text colours on every surface a cell sits on;
// the ink colours on the diff and error tints; the error text on its own tint
test('cell text tokens and cell tints keep 4.5:1, in both themes', () => {
  const pairs = [
    ...['--diff-hunk', '--j-key', '--j-str', '--j-num', '--j-lit'].flatMap((t) => ['--raised', '--sunk', '--paper'].map((s) => [t, s])),
    ...['--ink', '--ink-2'].flatMap((t) => ['--diff-add-bg', '--diff-del-bg', '--err-bg'].map((s) => [t, s])),
    ['--bad', '--err-bg'],
  ]
  for (const theme of ['light', 'dark']) for (const [t, s] of pairs)
    assert.ok(ratio(C(theme, t), C(theme, s)) >= 4.5, `${theme}: ${t} on ${s} = ${ratio(C(theme, t), C(theme, s)).toFixed(2)}`)
})
