// test/web-v2/contrast.test.mjs — 1.5 §审美 #7, computed from the token values of css/base.css, both themes, no browser:
// text colours ≥ 4.5:1 on every surface they may sit on; lamp colours, the trace, control edges and the data colours
// ≥ 3:1 on the surfaces they are drawn over; the primary button's ink ≥ 4.5:1 on its own action fill.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'legacy', 'css', 'base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

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
  // a token the same in both themes lives in :root only, so dark inherits it as the cascade does
  dark: { ...declsOf(bodyOf(beforeMedia, ':root')), ...declsOf(bodyOf(darkBody, ':root:not([data-theme="light"])')) },
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

const THEME_NAMES = ['light', 'dark']
const PAPER = ['--paper', '--panel', '--raised', '--sunk']
const SCOPE = ['--scope', '--scope-2']
const at = (min, pairs) => {
  for (const theme of THEME_NAMES) for (const [t, s] of pairs)
    assert.ok(ratio(C(theme, t), C(theme, s)) >= min, `${theme}: ${t} on ${s} = ${ratio(C(theme, t), C(theme, s)).toFixed(2)} < ${min}`)
}
const cross = (fgs, bgs) => fgs.flatMap((f) => bgs.map((b) => [f, b]))
// the #rrggbb stops of a gradient token; at least two, so a check over them is never vacuous
const stops = (theme, name) => {
  const s = [...String(THEMES[theme][name]).matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => parseColor(m[0]))
  assert.ok(s.length >= 2, `${theme} ${name}: expected a gradient with at least two #rrggbb stops (${THEMES[theme][name]})`)
  return s
}

// 1.5 §验收 #7
test('ink, action, status and trace-ink text reach 4.5:1 on the paper faces, in both themes', () => {
  at(4.5, cross(['--ink', '--ink-2', '--ink-3', '--action', '--bad', '--warn', '--ok', '--trace-ink'], PAPER))
})
test('scope ink reaches 4.5:1 on the scope glass, in both themes', () => {
  at(4.5, cross(['--scope-ink', '--scope-ink-2'], SCOPE))
})
test('the action ink, the tag ink and the brand text stay readable on what they sit on, in both themes', () => {
  at(4.5, [['--action-ink', '--action']])
  for (const theme of THEME_NAMES) {
    for (const stop of stops(theme, '--tag'))
      assert.ok(ratio(C(theme, '--tag-ink'), stop) >= 4.5, `${theme}: --tag-ink on a --tag stop = ${ratio(C(theme, '--tag-ink'), stop).toFixed(2)}`)
    for (const stop of stops(theme, '--brand-text'))
      assert.ok(ratio(stop, C(theme, '--raised')) >= 4.5, `${theme}: a --brand-text stop on --raised = ${ratio(stop, C(theme, '--raised')).toFixed(2)}`)
  }
})
test('the segmented control: the selected label at 4.5:1 on its face, the others on the track, and the face set apart from the track', () => {
  at(4.5, [['--ink', '--seg-on'], ['--ink-2', '--seg-track']])
  at(1.25, [['--seg-on', '--seg-track']]) // 1.5 第 7 条: the selected face reads as a face, not only through its shadow
})
test('lamps and control edges reach 3:1 on the paper faces, in both themes', () => {
  at(3, cross(['--bad-lamp', '--warn-lamp', '--note-lamp', '--control-edge'], PAPER))
})
test('the trace, cursor, scope action and edge, and the problem lamps reach 3:1 on the scope glass, in both themes', () => {
  at(3, cross(['--trace', '--cursor', '--scope-action', '--scope-edge', '--bad-lamp', '--warn-lamp'], SCOPE))
})
test('data colours reach 3:1 on the scope glass and the chart surfaces, in both themes', () => {
  const DATA = Object.keys(THEMES.light).filter((k) => k.startsWith('--ct-'))
  assert.ok(DATA.length >= 2, 'the data colour set is not empty')
  at(3, cross(DATA, [...SCOPE, '--raised', '--paper']))
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
