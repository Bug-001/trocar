// test/web-v2/theme.test.mjs — 1.5 §审美 #5: light is the token default and [data-theme="light"] repeats it; dark sits in the
// OS media query on :root:not([data-theme="light"]) and is repeated by [data-theme="dark"]; both manual directions beat the OS
// preference; every block carries the same token names. The switch itself only ever moves the attribute on <html> — no render
// call — and a storage that throws means "follow the system", never an error.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyThemePref, THEME_KEY } from '../../src/web/v2/core/ui.mjs'

const BASE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2', 'css', 'base.css'), 'utf8')

const css = BASE.replace(/\/\*[\s\S]*?\*\//g, '')
// the dark @media block (balanced braces), so the block inside it is read with its media context; the pin blocks
// that follow it are read back into the no-media group
const darkAt = css.search(/@media[^{]*prefers-color-scheme:\s*dark/)
let mediaDark = '', afterDark = css
if (darkAt >= 0) {
  const open = css.indexOf('{', darkAt)
  let depth = 0
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++
    else if (css[j] === '}') { depth--; if (depth === 0) { mediaDark = css.slice(open + 1, j); afterDark = css.slice(j + 1); break } }
  }
}
const flat = (text, media) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2], media])
const blocks = [...flat(css.slice(0, darkAt < 0 ? css.length : darkAt), null), ...flat(mediaDark, '@media dark'), ...flat(afterDark, null)]
const tokenBlock = (sel) => blocks.find(([s, , media]) => s === sel && (media === null || media === '@media dark'))
const vars = (decls) => Object.fromEntries([...decls.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const own = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => !/^var\(/.test(v))) // values that are not aliases

const LIGHT = tokenBlock(':root'), LIGHT_PIN = tokenBlock(':root[data-theme="light"]')
const DARK_MQ = tokenBlock(':root:not([data-theme="light"])'), DARK_PIN = tokenBlock(':root[data-theme="dark"]')

test('base.css has all four theme blocks, the dark one inside the OS media query', () => {
  for (const b of [LIGHT, LIGHT_PIN, DARK_MQ, DARK_PIN]) assert.ok(b, 'a theme block is missing')
  assert.equal(DARK_MQ[2], '@media dark', 'the dark values sit inside the OS media query')
})

test('the colour tokens are overridden whole: both pins repeat the media dark set, and the default block carries it too', () => {
  const names = (b) => Object.keys(own(vars(b[1]))).sort()
  const n = names(LIGHT)
  assert.ok(n.length >= 40, `expected the token set, found ${n.length}`)
  // the pins and the media block override the colour tokens; the rest of the set (:root) stays put
  assert.deepEqual(names(DARK_MQ), names(LIGHT_PIN), 'the light pin repeats the dark block\'s token list')
  assert.deepEqual(names(DARK_MQ), names(DARK_PIN), 'the dark pin repeats the dark block\'s token list')
  for (const k of names(DARK_MQ)) assert.ok(k in vars(LIGHT[1]), `${k} missing from the default block`)
})

test('light is the default; light and dark differ; [data-theme="light"] repeats the light values', () => {
  // compare over the colour token set (the pins and the media block override those; the rest of :root carries over)
  const KEYS = Object.keys(own(vars(DARK_MQ[1])))
  const pick = (b) => Object.fromEntries(KEYS.map((k) => [k, own(vars(b[1]))[k]]))
  const L = pick(LIGHT), LP = pick(LIGHT_PIN), D = pick(DARK_MQ), DP = pick(DARK_PIN)
  assert.deepEqual(LP, L, 'the manual light pin repeats the defaults exactly')
  assert.deepEqual(DP, D, 'the manual dark pin repeats the media-query dark exactly')
  let diff = 0
  for (const k of Object.keys(L)) if (L[k] !== D[k]) diff++
  assert.ok(diff >= 25, `the two themes must actually differ (only ${diff} tokens differ)`)
})

// ── the switch: attribute only, both ways, storage errors tolerated ───────────────────────────────────────────────────
const fakeDoc = (store) => {
  const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, removeAttribute(k) { delete this.attrs[k] } }
  const doc = { documentElement: el }
  if (store !== undefined) doc.localStorage = store
  return doc
}
test('applyThemePref: light / dark pin the attribute, anything else follows the system', () => {
  assert.equal(applyThemePref(fakeDoc({ getItem: () => 'light' })), 'light')
  assert.equal(applyThemePref(fakeDoc({ getItem: () => 'dark' })), 'dark')
  for (const absent of [null, '', 'blue', 'asight', undefined]) {
    const doc = fakeDoc({ getItem: () => absent })
    doc.documentElement.setAttribute('data-theme', 'left-over')
    assert.notEqual(applyThemePref(doc), 'light'); assert.notEqual(applyThemePref(doc), 'dark')
    assert.ok(!('data-theme' in doc.documentElement.attrs), `data-theme is removed for ${JSON.stringify(absent)}`)
  }
})
test('applyThemePref: a storage that throws, or no storage at all, means follow the system — never an error', () => {
  const throwing = { getItem() { throw new Error('denied') } }
  assert.doesNotThrow(() => applyThemePref(fakeDoc(throwing)))
  const doc = fakeDoc(throwing); doc.documentElement.setAttribute('data-theme', 'dark')
  applyThemePref(doc); assert.ok(!('data-theme' in doc.documentElement.attrs))
  assert.doesNotThrow(() => applyThemePref(fakeDoc()))
})
test('applyThemePref only moves the attribute: its source names no screen and no render function', () => {
  const src = fs.readFileSync(new URL('../../src/web/v2/core/ui.mjs', import.meta.url), 'utf8')
  const at = src.indexOf('export function applyThemePref')
  const body = src.slice(at, src.indexOf('\nexport ', at + 10)) // just this function
  assert.ok(!/import|render|show\(|mount\(/.test(body))
  assert.equal(THEME_KEY, 'asight.v2.theme')
})
test('the page applies the preference before the first paint, from the same key, without throwing', () => {
  const html = fs.readFileSync(new URL('../../src/web/v2/index.html', import.meta.url), 'utf8')
  const head = html.slice(0, html.indexOf('</head>'))
  const m = head.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m && m.index < head.indexOf('<link'), 'the boot script runs before the stylesheets')
  assert.match(m[1], /asight\.v2\.theme/)
  assert.match(m[1], /light|dark/)
  assert.match(m[1], /catch/, 'a blocked localStorage must not break the boot')
})
