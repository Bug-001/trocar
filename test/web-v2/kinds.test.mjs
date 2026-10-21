// test/web-v2/kinds.test.mjs — the Readable renderers (spec 2.3 §两种模式, D70 ③): each
// kind draws generated inputs inside its class contract, and an input a kind cannot draw falls back to text with the fail line.
// The wrapper below is the caller's (cell.mjs): renderKind gives the inner html and the wrapper's classes in `cls`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderKind, valueOf, jsonNodeHtml } from '../../src/web/v2/replay/kinds.mjs'

const wrap = ({ html, cls }) => `<div class="cellread ${cls}">${html}</div>`
const ENT = { lt: '<', gt: '>', quot: '"', '#39': "'", '#13': '\r', amp: '&' }
const textOf = (h) => h.replace(/<[^>]*>/g, '').replace(/&(lt|gt|quot|#39|#13|amp);/g, (_, n) => ENT[n])
const has = (h, c) => new RegExp(`class="[^"]*(?<![\\w-])${c}(?![\\w-])`).test(h)
const count = (h, re) => [...h.matchAll(re)].length

let seed = 0xc311
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const BITS = ['a', 'Z', ' ', '\n', '\r\n', '\t', '<', '>', '&', '"', "'", '\u{1F600}', ' ', '\u001b[31m', '  12→', '3\t', '</pre>', '&amp;']
const str = (n = 40) => { let s = ''; for (let k = Math.floor(rnd() * n); k--;) s += pick(BITS); return s }
const word = () => pick(['ls', '-la', 'a b', "it's", '"q"', '$HOME', 'x=1', '', '/tmp/p q', 'grep'])
const val = (d) => d <= 0 ? pick([() => str(10), () => rnd() * 1e6 - 5e5, () => pick([true, false, null])])()
  : pick([() => Array.from({ length: Math.floor(rnd() * 6) }, () => val(d - 1)),
    () => Object.fromEntries(Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => ['k' + i + str(3), val(d - 1)])), () => val(0)])()

test('text and code: the kind class, and the drawn text is the source (code shows ESC as a visible mark)', () => {
  for (let i = 0; i < 300; i++) {
    const s = str(200)
    for (const as of ['text', 'code']) {
      const out = renderKind({ as }, s, { budget: 1e9 })
      assert.ok(has(wrap(out), 'kd-' + as), as)
      assert.equal(out.more, null)
      assert.equal(textOf(out.html), as === 'code' ? s.replaceAll('\u001b', '␛') : s, as)
    }
  }
})

test('code with a gutter: line numbers go into aria-hidden gut spans, the title into kd-title', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `${String(i + 7).padStart(6)}→${str(20).replace(/[\r\n]/g, '')}`)
  const out = renderKind({ as: 'code', title: 'p.txt', f: { gutter: true } }, lines.join('\n'), { budget: 1e9 })
  assert.ok(has(out.html, 'kd-title'))
  assert.equal(count(out.html, /<span class="gut" aria-hidden="true">/g), lines.length)
})

test('slicing: the more chain covers the whole string with no gap or overlap', () => {
  for (let i = 0; i < 200; i++) {
    const s = str(400), budget = 1 + Math.floor(rnd() * 60)
    for (const as of ['text', 'code']) {
      let from = 0, got = '', n = 0
      do {
        const out = renderKind({ as }, s, { from, budget })
        got += textOf(out.html)
        assert.ok(out.more === null || out.more > from, 'progress')
        from = out.more; n++
      } while (from !== null && n < 1e5)
      assert.equal(got, as === 'code' ? s.replaceAll('\u001b', '␛') : s)
    }
  }
})

test('shell: a $ prompt followed by the command; argv is joined; note and other keys are drawn below', () => {
  for (let i = 0; i < 200; i++) {
    const argv = rnd() < 0.5
    const cmd = argv ? Array.from({ length: 1 + Math.floor(rnd() * 4) }, word) : str(30)
    const extra = Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => ['x' + k, val(1)]))
    const v = { command: cmd, description: 'n' + str(10), ...extra }
    const out = renderKind({ as: 'shell', f: { body: [], cmd: ['command'], note: ['description'] } }, v)
    const h = wrap(out)
    assert.ok(has(h, 'kd-shell') && has(h, 'kd-note'))
    const m = h.match(/<span class="sh-ps"[^>]*>\$<\/span>([^<]*)/)
    assert.ok(m, 'sh-ps then the command')
    const shown = textOf(m[1]).trim()
    if (!argv) assert.equal(shown, cmd.trim())
    else for (const a of cmd.filter((a) => /^[\w./=-]+$/.test(a))) assert.ok(shown.split(' ').includes(a), a)
    assert.equal(count(h, /<dt>/g), Object.keys(extra).length)
  }
})

test('kv: one dt and one dd per key, each child drawn by its own spec', () => {
  for (let i = 0; i < 200; i++) {
    const v = Object.fromEntries(Array.from({ length: Math.floor(rnd() * 8) }, (_, k) => [str(5) + k, val(2)]))
    const out = renderKind({ as: 'kv', kids: { [Object.keys(v)[0]]: { as: 'code' } } }, v)
    const h = wrap(out)
    assert.ok(has(h, 'kd-kv'))
    assert.equal(count(h, /<dt>/g), Object.keys(v).length)
    assert.equal(count(h, /<dd>/g), Object.keys(v).length)
  }
})

test('json: the first paint holds at most 200 nodes, arrays over 100 entries are grouped, closed nodes open on demand', () => {
  const nodes = (h) => count(h, /<details|<div>/g)
  for (let i = 0; i < 100; i++) {
    const n = Math.floor(rnd() * 3000), deep = val(4)
    const v = rnd() < 0.5 ? Array.from({ length: n }, (_, k) => (k % 7 ? k : val(2))) : { a: deep, b: Array.from({ length: n }, () => str(4)), c: val(3) }
    const out = renderKind({ as: 'json' }, v)
    const h = wrap(out)
    assert.ok(has(h, 'kd-json'))
    assert.ok(nodes(out.html) <= 200, `${nodes(out.html)} nodes`)
    for (const m of out.html.matchAll(/<details(?! open)[^>]*data-path="([^"]*)"(?: data-span="(\d+),(\d+)")?[^>]*>/g)) {
      const path = JSON.parse(textOf(m[1])), span = m[2] ? [+m[2], +m[3]] : undefined
      const kids = jsonNodeHtml(v, path, span)
      let node = v; for (const k of path) node = node[k]
      const len = span ? span[1] - span[0] : Object.keys(node).length
      if (len > 0) assert.ok(nodes(kids) > 0 && nodes(kids) <= 200)
      break
    }
  }
  const big = Array.from({ length: 250 }, (_, k) => k)
  const out = renderKind({ as: 'json' }, big)
  assert.ok(count(out.html, /data-span="/g) >= 3, 'groups of 100')
  assert.ok(count(out.html, /class="j-num"/g) <= 200)
})

test('sections: each top-level tag pair gets a sec-tag label; text outside the tags stays', () => {
  for (let i = 0; i < 100; i++) {
    const secs = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => [pick(['system-reminder', 'error', 'x-y']), str(20).replace(/[<\u001b]/g, '')])
    const lead = str(10).replace(/</g, '')
    const s = lead + secs.map(([t, b]) => `<${t}>${b}</${t}>`).join('\n')
    const out = renderKind({ as: 'sections', ...(rnd() < 0.5 && { kids: [{ as: 'code' }] }) }, s)
    assert.ok(has(wrap(out), 'kd-sec'))
    assert.equal(count(out.html, /class="sec-tag"/g), secs.length)
    for (const [, b] of secs) assert.ok(textOf(out.html).includes(b.replaceAll('\u001b', '␛')))
  }
})

test('opaque and parts: the signature byte length; each part drawn by its own spec', async () => {
  const { opaqueLine } = await import('../../src/web/v2/labels/cells.mjs')
  for (let i = 0; i < 50; i++) {
    const sig = str(60), v = { signature: sig, thinking: '' }
    const out = renderKind({ as: 'opaque', f: { sig: ['signature'] } }, v)
    assert.ok(has(wrap(out), 'kd-opaque'))
    assert.equal(textOf(out.html), opaqueLine(new TextEncoder().encode(sig).length))
    const parts = Array.from({ length: Math.floor(rnd() * 5) }, () => str(10))
    const kinds = parts.map(() => pick(['text', 'code']))
    const p = renderKind({ as: 'parts', kids: kinds.map((as) => ({ as })) }, parts)
    assert.ok(has(wrap(p), 'kd-parts'))
    assert.deepEqual([...p.html.matchAll(/<div class="kd-(text|code)/g)].map((m) => m[1]), kinds)
  }
})

test('fallbacks: unknown as, missing r, text over an object; a failure is kd-fail plus kd-text', () => {
  for (let i = 0; i < 100; i++) {
    const s = str(30), o = { k: val(2) }
    assert.ok(has(wrap(renderKind({ as: pick(['nope', 'constructor', '__proto__', 7]) }, s)), 'kd-text'))
    assert.ok(has(wrap(renderKind(undefined, s)), 'kd-text'))
    assert.ok(has(wrap(renderKind(null, s)), 'kd-text'))
    assert.ok(has(wrap(renderKind({ as: 'text' }, o)), 'kd-json'))
    for (const [r, v] of [[{ as: 'shell', f: { cmd: ['command'] } }, { cmd: s }], [{ as: 'json' }, '{"a":' + s],
      [{ as: 'kv', f: { body: ['missing'] } }, o], [{ as: 'kv' }, { get a() { throw new Error('x') } }], [{ as: 'parts' }, s]]) {
      const h = wrap(renderKind(r, v))
      assert.ok(has(h, 'kd-fail') && has(h, 'kd-text'), JSON.stringify(r))
    }
  }
})

test('tone: error and quiet put their class on the wrapper of any kind', () => {
  for (const as of ['text', 'code', 'json', 'kv', 'nope']) {
    assert.ok(has(wrap(renderKind({ as, tone: 'error' }, { a: 1 })), 'tone-error'))
    assert.ok(has(wrap(renderKind({ as, tone: 'quiet' }, 'x')), 'tone-quiet'))
  }
})

test('valueOf: JSON when it parses, else the text itself', () => {
  for (let i = 0; i < 100; i++) {
    const v = val(3), t = JSON.stringify(v)
    assert.deepEqual(valueOf(t), JSON.parse(t))
    const s = '{' + str(10)
    assert.equal(valueOf(s), s)
  }
})
