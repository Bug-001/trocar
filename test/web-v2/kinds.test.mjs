// test/web-v2/kinds.test.mjs — the Readable renderers (spec 2.3 §两种模式, D70 ③): each
// kind draws generated inputs inside its class contract, and an input a kind cannot draw falls back to text with the fail line.
// The wrapper below is the caller's (cell.mjs): renderKind gives the inner html and the wrapper's classes in `cls`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderKind, valueOf, jsonNodeHtml } from '../../web/legacy/replay/kinds.mjs'

const wrap = ({ html, cls }) => `<div class="cellread ${cls}">${html}</div>`
const ENT = { lt: '<', gt: '>', quot: '"', '#39': "'", '#13': '\r', amp: '&' }
const textOf = (h) => h.replace(/<[^>]*>/g, '').replace(/&(lt|gt|quot|#39|#13|amp);/g, (_, n) => ENT[n])
const has = (h, c) => new RegExp(`class="[^"]*(?<![\\w-])${c}(?![\\w-])`).test(h)
const count = (h, re) => [...h.matchAll(re)].length
// code's ESC byte (2.3 §两种模式): each one sits alone in a kd-esc span (the byte itself, so a copy carries it); none stands bare
const ESC_SPAN = /<span class="kd-esc"[^>]*>\u001b<\/span>/g
const escFaults = (h, n) => {
  const spans = count(h, ESC_SPAN), bare = count(h.replace(ESC_SPAN, ''), /\u001b/g)
  return spans === n && bare === 0 ? null : { spans, bare, n }
}

let seed = 0xc311
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const BITS = ['a', 'Z', ' ', '\n', '\r\n', '\t', '<', '>', '&', '"', "'", '\u{1F600}', ' ', '\u001b[31m', '  12→', '3\t', '</pre>', '&amp;']
const str = (n = 40) => { let s = ''; for (let k = Math.floor(rnd() * n); k--;) s += pick(BITS); return s }
const word = () => pick(['ls', '-la', 'a b', "it's", '"q"', '$HOME', 'x=1', '', '/tmp/p q', 'grep'])
const val = (d) => d <= 0 ? pick([() => str(10), () => rnd() * 1e6 - 5e5, () => pick([true, false, null])])()
  : pick([() => Array.from({ length: Math.floor(rnd() * 6) }, () => val(d - 1)),
    () => Object.fromEntries(Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => ['k' + i + str(3), val(d - 1)])), () => val(0)])()

test('text and code: the kind class, and the drawn text is the source (code marks each ESC byte and keeps it, 1.5 #5)', () => {
  for (let i = 0; i < 300; i++) {
    const s = str(200)
    for (const as of ['text', 'code']) {
      const out = renderKind({ as }, s, { budget: 1e9 })
      assert.ok(has(wrap(out), 'kd-' + as), as)
      assert.equal(out.more, null)
      assert.equal(textOf(out.html), s, as)
      if (as === 'code') assert.equal(escFaults(out.html, count(s, /\u001b/g)), null, 'each ESC byte is one kd-esc mark')
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
      assert.equal(got, s)
    }
  }
})

test('one draw spends at most its budget on strings; a cut string opens the rest a slice at a time, no gap or overlap (§4.5)', () => {
  const ALPHA = ['a', 'Z', ' ', '\u{1F600}', 'é'] // nothing JSON escapes, so a drawn character is a source character
  const long = (n) => { let s = ''; while (s.length < n) s += pick(ALPHA); return s }
  const blank = (v) => typeof v === 'string' ? '' : Array.isArray(v) ? v.map(blank) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)]))
  const bare = (h) => textOf(h.replace(/<summary>[^<]*<\/summary>/g, ''))
  for (let i = 0; i < 40; i++) {
    const budget = 1 + Math.floor(rnd() * 3000), s = long(budget * (2 + Math.floor(rnd() * 5))), t = long(Math.floor(rnd() * 50))
    for (const [r, v] of [[{ as: 'json' }, { a: s, b: [t, s] }], [{ as: 'kv' }, { a: s, b: t, c: s }], [undefined, { k: [s] }], [{ as: 'parts' }, [s, t]]]) {
      const out = renderKind(r, v, { budget }), skel = bare(renderKind(r, blank(v), { budget: Infinity }).html).length
      assert.ok(bare(out.html).length - skel <= budget + 1, `${JSON.stringify(r)}: drawn past the budget`) // +1: a pair is never split
      assert.ok(out.shown != null && out.shown <= budget, 'the cut is reported to the cell')
      let chains = 0
      for (const m of out.html.matchAll(/<details class="j-more" data-path="([^"]*)" data-span="(\d+),(\d+)"( data-q="")?>/g)) {
        const path = JSON.parse(textOf(m[1])), q = !!m[4], whole = path.reduce((x, k) => x[k], v)
        let a = +m[2], got = ''
        while (a != null) {
          const h = jsonNodeHtml(v, path, [a, whole.length], { q, budget }), nx = /data-span="(\d+),/.exec(h)
          assert.ok(bare(h).length <= budget + 2, 'a continuation is one slice')
          got += bare(h)
          if (nx) assert.ok(+nx[1] > a, 'progress')
          a = nx ? +nx[1] : null
        }
        assert.equal(got, q ? JSON.stringify(whole.slice(+m[2])).slice(1) : whole.slice(+m[2]))
        chains++
      }
      assert.ok(chains > 0, 'the rest of a cut string is reachable')
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
    const code = rnd() < 0.5 // a code child draws ESC bytes in the bodies; other kids get bodies without them
    const secs = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => [pick(['system-reminder', 'error', 'x-y']), str(20).replace(code ? /</g : /[<\u001b]/g, '')])
    const lead = str(10).replace(/[<\u001b]/g, '')
    const s = lead + secs.map(([t, b]) => `<${t}>${b}</${t}>`).join('\n')
    const out = renderKind({ as: 'sections', ...(code && { kids: secs.map(() => ({ as: 'code' })) }) }, s)
    assert.ok(has(wrap(out), 'kd-sec'))
    assert.equal(count(out.html, /class="sec-tag"/g), secs.length)
    for (const [, b] of secs) assert.ok(textOf(out.html).includes(b))
    if (code) assert.equal(escFaults(out.html, count(s, /\u001b/g)), null, 'each body ESC byte is one kd-esc mark')
  }
})

test('opaque and parts: the signature byte length; each part drawn by its own spec', async () => {
  const { opaqueLine } = await import('../../web/legacy/labels/cells.mjs')
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

// ── markdown, diff, media ─────────────────────────────────────────────────────────────────────────────────────────
const plain = () => str(12).replace(/[\u001b\r\n|*_`[\]\\#>~+-]/g, '') + 'w' // a table cell / text run with no markdown syntax in it

test('markdown: an HTML tag stays text, a link is text and URL with no href, a pipe table becomes cells', () => {
  for (let i = 0; i < 100; i++) {
    const tag = pick(['b', 'script', 'a', 'img', 'h1']), html = `<${tag} x="${plain()}">${plain()}</${tag}>`
    const url = 'https://e.x/' + plain().replace(/[\s()]/g, '')
    const cols = 1 + Math.floor(rnd() * 4), rows = Math.floor(rnd() * 5)
    const line = (f) => '| ' + Array.from({ length: cols }, f).join(' | ') + ' |'
    const lvl = 1 + Math.floor(rnd() * 6)
    const src = [`${'#'.repeat(lvl)} ${plain()}`, html, `see [${plain()}](${url})`, '', line(plain), line(() => '---'),
      ...Array.from({ length: rows }, () => line(plain)), '', `- ${plain()}`, `> ${plain()}`].join('\n')
    const out = renderKind({ as: 'markdown' }, src)
    assert.ok(has(wrap(out), 'kd-md'))
    assert.ok(textOf(out.html).includes(html), 'the tag is shown as text')
    assert.ok(textOf(out.html).includes(url), 'the URL is shown')
    assert.doesNotMatch(out.html, /href|<a[\s>]|<h\d|<ul|<li|<em|<strong/)
    assert.equal(count(out.html, /<th>/g), cols)
    assert.equal(count(out.html, /<td>/g), cols * rows)
    for (const c of ['md-h' + lvl, 'md-li', 'md-q', 'md-table']) assert.ok(has(out.html, c), c)
  }
})

const dlines = (h) => [...h.matchAll(/<div class="(d-add|d-del|d-ctx)">([^<]*)<\/div>/g)].map((m) => [m[1], textOf(m[2])])
const lineBits = () => pick(['a', 'b', 'c', 'x = 1', '', '  }', '<p>', '"q"', '\r'])
test('diff: an edit pair read back with its signs rebuilds old and new', () => {
  for (let i = 0; i < 200; i++) {
    const old = Array.from({ length: Math.floor(rnd() * 60) }, lineBits)
    const nu = old.flatMap((l) => (rnd() < 0.1 ? [] : rnd() < 0.1 ? [lineBits(), l] : rnd() < 0.05 ? [lineBits()] : [l]))
    const v = { o: old.join('\n'), n: nu.join('\n') }
    const out = renderKind({ as: 'diff', title: 'p', f: { old: ['o'], new: ['n'] } }, v)
    assert.ok(has(wrap(out), 'kd-diff') && has(out.html, 'kd-title'))
    const L = dlines(out.html)
    for (const [c, t] of L) assert.equal(t[0], { 'd-add': '+', 'd-del': '-', 'd-ctx': ' ' }[c])
    assert.equal(L.filter(([c]) => c !== 'd-add').map(([, t]) => t.slice(1)).join('\n'), v.o)
    assert.equal(L.filter(([c]) => c !== 'd-del').map(([, t]) => t.slice(1)).join('\n'), v.n)
  }
})

test('diff: past the edit or line cap, two panes; a patch is classed by its first character', () => {
  const many = (n, p) => Array.from({ length: n }, (_, k) => p + k).join('\n')
  for (const [o, n] of [[many(300, 'a'), many(300, 'b')], [many(2001, 'a'), many(2001, 'a') + '\nz']]) {
    const t0 = Date.now()
    const out = renderKind({ as: 'diff', f: { old: ['o'], new: ['n'] } }, { o, n })
    assert.equal(count(out.html, /class="d-pane"/g), 2)
    assert.equal(count(out.html, /class="d-panel"/g), 2)
    assert.ok(Date.now() - t0 < 2000, 'bounded work')
  }
  for (let i = 0; i < 100; i++) {
    const body = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => pick(['+', '-', ' ']) + plain())
    const p = ['@@ -1,3 +1,3 @@', ...body].join('\n')
    const out = renderKind({ as: 'diff', f: { patch: ['p'] } }, { p })
    const want = body.map((l) => ({ '+': 'd-add', '-': 'd-del', ' ': 'd-ctx' }[l[0]]))
    assert.deepEqual(dlines(out.html).map(([c]) => c), want)
    assert.ok(has(out.html, 'd-hunk'))
  }
})

// generated image headers: [mime, bytes, width, height]
function header(kind, w, h) {
  const b = Buffer.alloc(64)
  if (kind === 'png') { Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20) }
  if (kind === 'gif') { b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8) }
  if (kind === 'jpeg') {
    const app = Buffer.alloc(2 + Math.floor(rnd() * 40)); app.writeUInt16BE(app.length, 0)
    const sof = Buffer.from([0xff, pick([0xc0, 0xc1, 0xc2]), 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3])
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), app, sof, Buffer.alloc(20)])
  }
  if (kind.startsWith('webp')) {
    b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1')
    if (kind === 'webp-x') { b.write('VP8X', 12, 'latin1'); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3) }
    if (kind === 'webp-l') { b.write('VP8L', 12, 'latin1'); b[20] = 0x2f; b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 21) }
    if (kind === 'webp') { b.write('VP8 ', 12, 'latin1'); b.writeUIntBE(0x9d012a, 23, 3); b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28) }
  }
  return b
}
const MAX = { png: 2 ** 31 - 1, gif: 65535, jpeg: 65535, webp: 16383, 'webp-l': 16384, 'webp-x': 2 ** 24 }
const MEDIA = { as: 'media', f: { data: ['d'], mime: ['m'] } }

test('media: width and height come from the image header; no src; svg is code; other data a file with Save; a URL is text', () => {
  for (let i = 0; i < 300; i++) {
    const kind = pick(Object.keys(MAX)), w = 1 + Math.floor(rnd() * MAX[kind]), h = 1 + Math.floor(rnd() * MAX[kind])
    const out = renderKind(MEDIA, { d: header(kind, w, h).toString('base64'), m: 'image/' + kind.split('-')[0] }, { bid: 'b' + i })
    assert.ok(has(wrap(out), 'kd-media'))
    const img = out.html.match(/<img ([^>]*)>/)
    assert.ok(img, kind)
    assert.match(img[1], new RegExp(`data-media="b${i}" width="${w}" height="${h}"`))
    assert.doesNotMatch(img[1], /\bsrc=/)
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>' + plain() + '</text></svg>'
  const s = renderKind(MEDIA, { d: Buffer.from(svg).toString('base64'), m: 'image/svg+xml' })
  assert.ok(has(wrap(s), 'kd-code'))
  assert.equal(textOf(s.html), svg)
  const pdf = renderKind(MEDIA, { d: Buffer.from('%PDF-1.7').toString('base64'), m: 'application/pdf' })
  assert.match(pdf.html, /class="kd-file"[^]*<button type="button" data-cellsave>/)
  const url = renderKind({ as: 'media', f: { data: ['d'] } }, { url: 'https://e.x/a.png' })
  assert.doesNotMatch(url.html, /<img|src=/)
  assert.ok(textOf(url.html).includes('https://e.x/a.png'))
})

test('markdown, diff, media: input they cannot draw falls back to text with the fail line', () => {
  for (let i = 0; i < 50; i++) {
    for (const [r, v] of [[{ as: 'diff' }, plain() + '\n+' + plain()], [{ as: 'diff', f: { patch: ['p'] } }, { p: 7 }],
      [{ as: 'diff', f: { old: ['o'], new: ['n'] } }, { o: 'a' }], [{ as: 'markdown' }, { a: 1 }],
      [MEDIA, { d: '!' + plain(), m: 'image/png' }], [MEDIA, { d: header('png', 3, 4).subarray(0, 14).toString('base64'), m: 'image/png' }]]) {
      const h = wrap(renderKind(r, v))
      assert.ok(has(h, 'kd-fail') && has(h, 'kd-text'), JSON.stringify(r))
    }
  }
})
