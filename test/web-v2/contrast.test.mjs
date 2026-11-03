// test/web-v2/contrast.test.mjs — 1.5 §审美 #7, computed from the token values of css/base.css, both themes, no browser:
// text colours ≥ 4.5:1 on every surface they may sit on; lamp colours, the trace, control edges and the data colours
// ≥ 3:1 on the surfaces they are drawn over; the primary button's ink ≥ 4.5:1 on its own action fill.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CT_ORDER } from '../../web/legacy/replay/analysis.mjs'

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

// CIEDE2000 between two CIELAB colours; sRGB → CIELAB (D65) first (1.5 §审美 #7: the solid data colours are pairwise distinguishable)
function lab(rgb) {
  const [r, g, b] = rgb.map(chan)
  const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883]
  const [fx, fy, fz] = xyz.map((t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116))
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
const rad = Math.PI / 180
function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)))
  const C1 = Math.hypot(a1 * (1 + G), b1), C2 = Math.hypot(a2 * (1 + G), b2)
  const hue = (a, b) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360)
  const h1 = hue(a1 * (1 + G), b1), h2 = hue(a2 * (1 + G), b2)
  let dh = C1 * C2 === 0 ? 0 : h2 - h1
  if (dh > 180) dh -= 360; else if (dh < -180) dh += 360
  const Hm = C1 * C2 === 0 ? h1 + h2 : Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2
  const Lm = (L1 + L2) / 2, Cpm = (C1 + C2) / 2
  const T = 1 - 0.17 * Math.cos((Hm - 30) * rad) + 0.24 * Math.cos(2 * Hm * rad) + 0.32 * Math.cos((3 * Hm + 6) * rad) - 0.2 * Math.cos((4 * Hm - 63) * rad)
  const SL = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cpm, SH = 1 + 0.015 * Cpm * T
  const RT = -2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((Hm - 275) / 25) ** 2)) * rad)
  const dL = (L2 - L1) / SL, dC = (C2 - C1) / SC, dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad) / SH
  return Math.sqrt(dL ** 2 + dC ** 2 + dH ** 2 + RT * dC * dH)
}
test('the CIEDE2000 scanner matches published reference pairs (Sharma, Wu and Dalal 2005)', () => {
  for (const [p, q, want] of [[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 2.5, 0], [73, 25, -18], 27.1492], [[50, 2.5, 0], [50, 0, -2.5], 4.3065]])
    assert.ok(Math.abs(deltaE2000(p, q) - want) < 1e-3, `ΔE00 ${deltaE2000(p, q)} ≠ ${want}`)
  assert.ok(Math.abs(lab([255, 255, 255])[0] - 100) < 0.01)
})
// 1.5 §审美 #7: the seven solid data colours (--ct-hatch is told apart by its stripes) differ pairwise by ΔE00 ≥ 12, both themes
test('the solid data colours are pairwise distinguishable (CIEDE2000 ≥ 12), in both themes', () => {
  const SOLID = Object.keys(THEMES.light).filter((k) => k.startsWith('--ct-') && k !== '--ct-hatch')
  assert.equal(SOLID.length, 7)
  for (const theme of THEME_NAMES) for (const [i, a] of SOLID.entries()) for (const b of SOLID.slice(i + 1)) {
    const d = deltaE2000(lab(C(theme, a)), lab(C(theme, b)))
    assert.ok(d >= 12, `${theme}: ${a} vs ${b} ΔE00 = ${d.toFixed(1)} < 12`)
  }
})
// 1.5 §前置定义 内容类型配色: every .ct-<kind> background references only the data token the spec gives that kind
test('each content-type class in replay.css draws with its own data token only', () => {
  const SPEC = { tools: '--ct-tools', system: '--ct-system', user: '--ct-user', assistant: '--ct-assistant', thinking: '--ct-thinking',
    tool_use: '--ct-tooluse', tool_result: '--ct-result', image: '--ct-hatch', other: '--ct-hatch', unloaded: '--ct-hatch' }
  const replay = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'legacy', 'css', 'replay.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const kind of [...CT_ORDER, 'unloaded']) {
    assert.ok(SPEC[kind], `the spec gives ${kind} a data token`)
    // every rule whose selector list names the class on its own
    const body = [...replay.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').some((x) => x.trim() === `.ct-${kind}`)).map((m) => m[2]).join(';')
    const bg = [...body.matchAll(/background(?:-color|-image)?\s*:\s*([^;]+)/g)].map((m) => m[1])
    assert.ok(bg.length, `.ct-${kind} sets a background`)
    assert.deepEqual([...new Set(bg.flatMap((v) => [...v.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])))], [SPEC[kind]], `.ct-${kind}: ${bg.join(' ; ')}`)
  }
})
