// test/web-v2/no-bare-colors.test.mjs — every colour on the v2 board is a token (var(--x)) or a color-mix() of tokens. Outside the
// :root token blocks of css/base.css there is no #rgb / #rrggbb, no rgb( / rgba( / hsl( / hsla( anywhere under web/legacy — in
// stylesheets, scripts or the page. (The first board had hard-coded hex in its banners and a hex fallback inside var().)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'legacy')
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  return d.isDirectory() ? walk(p) : /\.(mjs|css|html)$/.test(d.name) ? [p] : []
})
// 3, 4, 6 and 8 digits (#rgb #rgba #rrggbb #rrggbbaa), not the tail of a longer word, an entity (&#39;), a fragment (…/#x) or an id (a#b).
const HEX = /(?<![&\w#/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g
const FN = /\b(?:rgba?|hsla?)\s*\(/gi
// Every hex counts by default — a string, an array, a return, a ternary, a call argument, a CSS string in a script, a declaration in a
// stylesheet. A hex that is not a colour is exempt only where the text on its left says so: it sits inside the string argument of a DOM
// lookup (querySelector / querySelectorAll / getElementById / closest / matches, the project's $(sel) helper in core/dom.mjs, and the
// q(el, sel) helper of replay/timeline.mjs) — an id selector like '#decade' or '#add' — or it is a fragment link (href="#decade") or an
// SVG reference (url(#add)). Hash routes ('#/…') never match HEX at all. `left` is the text of the same line before the hex; the sink's
// string must still be open there (same quote, not closed yet), so `$('#a').style.color = '#fff'` is flagged.
const OPEN_STRING = "(['\"`])(?:\\\\.|(?!\\1)[^\\\\\\n])*$"
const SELECTOR_ARG = [
  new RegExp("(?<![\\w$])(?:querySelector(?:All)?|getElementById|closest|matches|\\$)\\s*\\(\\s*" + OPEN_STRING),
  new RegExp("(?<![\\w$.])q\\s*\\(\\s*[\\w$.]+\\s*,\\s*" + OPEN_STRING),
]
const NOT_A_COLOUR = /(?:\bhref\s*=\s*['"]?|\burl\(\s*['"]?)$/
const exempt = (left) => NOT_A_COLOUR.test(left) || SELECTOR_ARG.some((re) => re.test(left))

// the colour literals in a piece of text: [] when clean
const literals = (text) => [
  ...[...text.matchAll(HEX)].filter((m) => !exempt(text.slice(text.lastIndexOf('\n', m.index - 1) + 1, m.index))).map((m) => m[0]),
  ...[...text.matchAll(FN)].map((m) => m[0]),
]

// `rel` is the path relative to web/legacy. Only css/base.css may define colours, and only in :root token blocks.
export function colorViolations(rel, text) {
  if (!rel.endsWith('.css')) return literals(text).map((l) => `${rel}: ${l}`)
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  // every innermost block with the selector text just before it; @media wrappers are not blocks of their own here
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim()
    if (rel === 'css/base.css' && sel.startsWith(':root')) continue // the token blocks: :root, :root[data-theme=…], inside @media too
    for (const l of literals(m[2])) out.push(`${rel}: ${l} in "${sel.slice(-60)}"`)
  }
  return out
}

test('the scanner catches planted violations and spares the token blocks (it is not vacuous)', () => {
  assert.equal(colorViolations('replay/x.mjs', 'el.style.cssText = "color:#fff"').length, 1)
  assert.equal(colorViolations('replay/x.mjs', "const c = 'rgba(0,0,0,.5)'").length, 1)
  assert.equal(colorViolations('replay/x.mjs', 'x = `hsl(10 20% 30%)`').length, 1)
  assert.equal(colorViolations('css/replay.css', '.a{color:#abc}').length, 1)
  assert.equal(colorViolations('css/replay.css', '.a{box-shadow:0 0 4px rgba(0,0,0,.4)}').length, 1)
  assert.equal(colorViolations('css/replay.css', '.a{color:var(--amber,#e8c15a)}').length, 1) // a hex fallback inside var()
  assert.equal(colorViolations('css/replay.css', '.a{background:#12345678}').length, 1)
  assert.equal(colorViolations('css/replay.css', '@media (max-width:900px){.a{color:#fff}}').length, 1)
  // clean: tokens, mixes, entities, ids that merely look like hex
  assert.deepEqual(colorViolations('css/replay.css', '.a{color:var(--fg);background:color-mix(in srgb,var(--amber) 10%,transparent)} #add{color:var(--dim)}'), [])
  assert.deepEqual(colorViolations('replay/x.mjs', "const q = '&#39;' + '&#13;' + '#/replay' + '#cachebrk'"), [])
  // in a script a hex counts wherever it stands — an assignment, an array, a return, a ternary, a call argument, a CSS string …
  for (const src of [
    "const c = '#ff0000'", "const palette = ['#3c3', '#a1b2c3']", "function f(on) { return on ? '#fff' : '#000' }", "const t = on ? '.a' : '#decade'",
    "setColor('#c33')", "el.style.setProperty('--a', '#c33')", "const o = { 'color': '#fff' }", "const o = { ok: '#3c3' }", "const RED = '#c33'",
    "el.setAttribute('fill', '#c33')", "el.style.cssText = 'color:#decade'", "el.style.cssText = 'border:1px solid #decade;margin:0'", "const s = { color: '#decade' }",
    "el.style.color = '#decade'", 'ctx.fillStyle = "#add"', "const w = '#abcd' /* 4 digits */", "const x = '#ab12cd34' /* 8 digits */",
    'html = `<i style="background:var(--x,#abc)">`', '$(\'#add\').style.color = \'#fff\'', "el.querySelector('#decade .x').style.cssText = 'color:#facade'",
    "const a = $('.a ' + '#decade')", // a hex outside the selector string of the call
  ]) assert.ok(colorViolations('replay/x.mjs', src).length >= 1, src)
  assert.equal(colorViolations('replay/x.mjs', "const palette = ['#3c3', '#a1b2c3']").length, 2)
  // … except where it is a selector (the string argument of the DOM lookups and the project's $ / q helpers), a fragment link or an SVG reference
  for (const src of [
    "const a = $('#add')", "const a = $('#decade', root)", "const a = el.querySelector('#add, #bad'), b = document.querySelectorAll('#decade .x')",
    "const a = el.closest('a:hover #decade'), b = el.matches('#decade.on'), c = document.getElementById('decade')", "const a = $(`#row-${i} #facade > b`)",
    "const a = q(el, '.row #facade > b')", "const a = $(\"#decade [data-x='y']\")",
    "const h = `<a href=\"#decade\">x</a>`", "const u = 'http://host/#decade'", "const f = `<use fill=\"url(#add)\"/>`", "go('#/sessions'); go('#/replay?p=x')",
  ]) assert.deepEqual(colorViolations('replay/x.mjs', src), [], src)
  assert.equal(colorViolations('index.html', '<style>.a{color:#decade}</style> <a href="#decade">').length, 1)
  assert.equal(colorViolations('css/replay.css', '.a{color:#decade}').length, 1) // a stylesheet body has no selectors: unchanged
  // the token blocks of base.css are allowed — and only there, and only :root blocks
  assert.deepEqual(colorViolations('css/base.css', ':root{--bg:#0e0f13;--x:rgb(1,2,3)} @media (prefers-color-scheme: light){:root{--bg:#fff;}} :root[data-theme="dark"]{--bg:#000;}'), [])
  assert.equal(colorViolations('css/base.css', 'body{background:#fff}').length, 1)
  assert.equal(colorViolations('css/base.css', '.a{box-shadow:0 0 1px rgba(0,0,0,.5)}').length, 1)
  assert.equal(colorViolations('css/replay.css', ':root{--bg:#fff}').length, 1)
})

test('web/legacy has no bare colour outside the :root tokens of css/base.css', () => {
  const files = walk(ROOT)
  assert.ok(files.length >= 15, `expected the v2 front end to exist, found ${files.length} files`)
  assert.ok(files.some((f) => f.endsWith(path.join('css', 'base.css'))))
  const bad = files.flatMap((f) => colorViolations(path.relative(ROOT, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')))
  assert.deepEqual(bad, [])
})
