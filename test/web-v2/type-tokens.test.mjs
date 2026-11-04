// test/web-v2/type-tokens.test.mjs — 1.5 #15 (D77 ②): type goes only through the tokens. Every declaration in web/legacy/css/*.css sets
// font-size / font-weight / font-family / font only from --fs-* / --fw-* / --sans / --mono (/ --lh) or inherit; --wordmark, letter-spacing
// and text-transform live only in wordmark rules; nothing is italic. Scripts under web/legacy and web/src carry no inline type at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  return d.isDirectory() ? walk(p) : [p]
})

const FAMILY = /^var\(--(sans|mono)\)$/
const ALLOWED = {
  'font-size': (v) => /^var\(--fs-[\w-]+\)$/.test(v),
  'font-weight': (v) => /^var\(--fw-[\w-]+\)$/.test(v),
  'font-family': (v, wm) => FAMILY.test(v) || (wm && v === 'var(--wordmark)'),
  font: (v, wm) => v.split(/\s+|(?=\/)|(?<=\/)/).filter(Boolean).every((p) => p === '/' || /^var\(--(fs-[\w-]+|fw-[\w-]+|lh)\)$/.test(p) || ALLOWED['font-family'](p, wm)),
  'letter-spacing': (v, wm) => wm,
  'text-transform': (v, wm) => wm,
  'font-style': (v) => !/italic|oblique/.test(v),
}

// `rel` is the path relative to web/; one line per violation, [] when clean
export function cssTypeViolations(rel, text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  // every innermost block with the selector text just before it; @media wrappers are not blocks of their own here
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim()
    const wm = /wordmark/.test(sel)
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      const prop = decl.slice(0, i).trim().toLowerCase()
      const v = decl.slice(i + 1).replace(/!important/, '').trim()
      if (!(prop in ALLOWED) || v === 'inherit') continue // a --* definition (the :root token blocks) is not a type property
      if (!ALLOWED[prop](v, wm)) out.push(`${rel}: ${prop}: ${v} in "${sel.slice(-60)}"`)
    }
  }
  return out
}

const KEY = /\b(fontSize|fontWeight|fontFamily|letterSpacing|textTransform)\b/g
const STR = /(['"`])(?:\\.|(?!\1)[^\\])*?\1/g
const IN_STRING = /\b(font-size|font-weight|font-family|letter-spacing|text-transform)\s*:/
export function scriptTypeViolations(rel, text) {
  const code = text.replace(/\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g, '')
  return [
    ...[...code.matchAll(KEY)].map((m) => `${rel}: ${m[0]}`),
    ...[...code.matchAll(STR)].filter((m) => IN_STRING.test(m[0])).map((m) => `${rel}: ${m[0].slice(0, 60)}`),
  ]
}

test('the scanner catches each planted violation (it is not vacuous)', () => {
  const css = (s) => cssTypeViolations('legacy/css/x.css', s)
  assert.equal(css('.a{font-size:14px}').length, 1)
  assert.equal(css('.a{font-weight:500}').length, 1)
  assert.equal(css('.a{letter-spacing:.02em}').length, 1)
  assert.equal(css('.a{text-transform:uppercase}').length, 1)
  assert.equal(css('.a{font-family:Georgia,serif}').length, 1)
  assert.equal(css('.a{font-family:var(--wordmark)}').length, 1)
  assert.equal(css('.a{font:500 14px/20px var(--sans)}').length, 1)
  assert.equal(css('.a{font-style:italic}').length, 1)
  assert.equal(css('@media (max-width:900px){.a{font-size:var(--fs-body);font-weight:700}}').length, 1)
  assert.equal(scriptTypeViolations('legacy/x.mjs', 'el.style.fontSize = "14px"').length, 1)
  assert.equal(scriptTypeViolations('src/x.tsx', '<b style={{ fontWeight: 600 }}/>').length, 1)
  assert.equal(scriptTypeViolations('legacy/x.mjs', 'el.style.cssText = "font-size:14px"').length, 1)
  // what is allowed stays clean
  assert.deepEqual(css(':root{--fs-body:13px;--sans:Georgia}.wordmark{font-family:var(--wordmark);letter-spacing:-.01em}'), [])
  assert.deepEqual(css('.a{font:var(--fw-strong) var(--fs-body)/var(--lh) var(--sans);font-size:inherit;font-style:normal}'), [])
})

test('every stylesheet and script sets type only through the tokens (1.5 #15)', () => {
  const out = []
  for (const p of walk(path.join(WEB, 'legacy', 'css'))) if (p.endsWith('.css')) out.push(...cssTypeViolations(path.relative(WEB, p), fs.readFileSync(p, 'utf8')))
  for (const dir of ['legacy', 'src']) {
    for (const p of walk(path.join(WEB, dir))) {
      if (!/\.(mjs|js|ts|tsx)$/.test(p) || /\.test\./.test(p)) continue
      out.push(...scriptTypeViolations(path.relative(WEB, p), fs.readFileSync(p, 'utf8')))
    }
  }
  assert.deepEqual(out, [])
})
