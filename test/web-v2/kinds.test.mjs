// test/web-v2/kinds.test.mjs — the Readable renderers (spec 2.3 §两种模式, D70 ③): each
// kind draws generated inputs inside its class contract, and an input a kind cannot draw falls back to text with the fail line.
// The wrapper below is the caller's (cell.mjs): renderKind gives the inner html and the wrapper's classes in `cls`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderKind, setMarkdown, jsonNodeHtml, textOf as copyOf } from '../../web/legacy/replay/kinds.mjs'
import { FAIL_LINE, IMAGE_URL, NO_ARGS, OPAQUE_LINE } from '../../web/legacy/labels/cells.mjs'

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
  assert.ok(has(wrap(renderKind({ as: 'code', f: { wrap: true } }, lines[0])), 'kd-wrap'))
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

test('shell: a $ prompt followed by the command; argv is joined; the note is the shell\'s, other keys are drawn below', () => {
  for (let i = 0; i < 200; i++) {
    const argv = rnd() < 0.5
    const cmd = argv ? Array.from({ length: 1 + Math.floor(rnd() * 4) }, word) : str(30)
    const extra = Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => ['x' + k, val(1)]))
    const note = 'NOTE' + i, v = { command: cmd, description: note, ...extra }
    const out = renderKind({ as: 'shell', f: { body: [], cmd: ['command'], note: ['description'] } }, v)
    const h = wrap(out)
    assert.ok(has(h, 'kd-shell'))
    assert.ok(!textOf(h).includes(note), 'the note is not drawn here')
    const m = h.match(/<span class="sh-ps"[^>]*>\$<\/span>([^<]*)/)
    assert.ok(m, 'sh-ps then the command')
    const shown = textOf(m[1]).trim()
    if (!argv) assert.equal(shown, cmd.trim())
    else for (const a of cmd.filter((a) => /^[\w./=-]+$/.test(a))) assert.ok(shown.split(' ').includes(a), a)
    assert.deepEqual([...h.matchAll(/class="kv-k">([^<]*)/g)].map((x) => x[1]), Object.keys(extra))
  }
})

test('kv: every key and value is there, each child drawn by its own spec; an empty object says so', () => {
  for (let i = 0; i < 200; i++) {
    const first = 'first' + i
    const v = { [first]: 'v' + str(120), ...Object.fromEntries(Array.from({ length: Math.floor(rnd() * 8) }, (_, k) => [str(5) + k, pick([str(200), Math.floor(rnd() * 1e6), rnd() < 0.5])])) }
    const out = renderKind({ as: 'kv', kids: { [first]: { as: 'code' } } }, v), h = wrap(out), got = textOf(h)
    assert.ok(has(h, 'kd-kv'))
    assert.ok(has(h, 'kd-code'), 'a kid keeps its own kind')
    for (const [k, x] of Object.entries(v)) assert.ok(got.includes(k) && got.includes(String(x)), k)
  }
  assert.equal(textOf(renderKind({ as: 'kv' }, {}).html), NO_ARGS)
})

// a generated schema with what a reader must find in its Parameters: every name, its types and allowed values, how many are required
function schemaOf(depth) {
  const seen = { names: [], words: [], required: 0 }
  const scalar = () => pick(['string', 'number', 'integer', 'boolean'])
  const prop = (d) => {
    const a = scalar(), b = 'null', vals = ['v' + Math.floor(rnd() * 1e6), 'w' + Math.floor(rnd() * 1e6)], description = 'about' + Math.floor(rnd() * 1e6)
    const shapes = [
      () => { seen.words.push(a); return { type: a } },
      () => { seen.words.push(a, b); return { type: [a, b] } },
      () => { seen.words.push(a, b); return { [pick(['anyOf', 'oneOf'])]: [{ type: a }, { type: b }] } },
      () => { seen.words.push('string', ...vals); return { type: 'string', enum: vals } },
      () => { seen.words.push('array', ...vals); return { type: 'array', items: { enum: vals } } },
      ...(d > 0 ? [() => { seen.words.push('object'); return { type: 'object', ...object(d - 1) } },
        () => { seen.words.push('object'); return { type: 'array', items: { type: 'object', ...object(d - 1) } } }] : []),
    ]
    const s = pick(shapes)()
    if (rnd() < 0.5) { s.description = description; seen.words.push(description) }
    return s
  }
  const object = (d) => {
    const names = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => `p${seen.names.length + k}x`)
    seen.names.push(...names)
    const required = names.filter(() => rnd() < 0.5)
    seen.required += required.length
    return { properties: Object.fromEntries(names.map((n) => [n, prop(d)])), ...(required.length && { required }) }
  }
  const top = object(depth)
  return { schema: { type: 'object', ...top }, top: Object.keys(top.properties), ...seen }
}
const TOOL = { as: 'tool', f: { body: [], desc: ['desc'], schema: ['schema'] } }

test('tool: every parameter, type, allowed value and required mark is read from the schema; the summary lists the names', () => {
  for (let i = 0; i < 300; i++) {
    const { schema, top, names, words, required } = schemaOf(2)
    const out = renderKind(TOOL, { desc: 'Does a thing', schema }), h = wrap(out), got = textOf(h)
    assert.ok(has(h, 'kd-tool') && !has(h, 'kd-fail'))
    assert.ok(got.includes('Does a thing'))
    const m = h.match(/<details class="tool-params" data-path="([^"]*)"><summary>([^<]*)<\/summary>/)
    assert.ok(m, 'Parameters, closed')
    assert.deepEqual(JSON.parse(textOf(m[1])), ['schema'])
    for (const n of top) assert.ok(m[2].includes(n), n)
    for (const w of [...names, ...words]) assert.ok(got.includes(w), w)
    assert.equal(count(h, /class="pr"/g), required)
  }
})

test('tool: a union is written a | b', () => {
  for (const u of [{ type: ['string', 'null'] }, { anyOf: [{ type: 'string' }, { type: 'null' }] }, { oneOf: [{ type: 'string' }, { type: 'null' }] }]) {
    assert.ok(textOf(renderKind(TOOL, { schema: { properties: { a: u } } }).html).includes('string | null'))
  }
})

test('tool: a schema with no properties to read falls back to the JSON tree, never the fail line; no arguments is said', () => {
  for (const schema of [{}, { type: 'object' }, { type: 'string' }, { $ref: '#/x' }, [], [{ type: 'object' }], { properties: 7 }, { properties: ['a'] }]) {
    const h = wrap(renderKind(TOOL, { desc: 'd', schema }))
    assert.ok(has(h, 'kd-json') && !has(h, 'kd-fail') && !has(h, 'tool-params'), JSON.stringify(schema))
  }
  const none = wrap(renderKind(TOOL, { desc: 'd', schema: { type: 'object', properties: {} } }))
  assert.ok(textOf(none).includes(NO_ARGS) && !has(none, 'kd-fail'))
})

test('tool: the description slices through more; Parameters come with the slice that has no more', () => {
  for (let i = 0; i < 100; i++) {
    const { schema } = schemaOf(1), budget = JSON.stringify(schema).length + 1 + Math.floor(rnd() * 200)
    const desc = 'word '.repeat(budget * (1 + Math.floor(rnd() * 3))), v = { desc, schema }
    let from = 0, got = '', out, n = 0
    do {
      out = renderKind(TOOL, v, { from, budget })
      assert.ok(out.more === null || out.more > from, 'progress')
      assert.equal(has(out.html, 'tool-params'), out.more === null)
      got += textOf(out.html.replace(/<details class="tool-params"[^]*$/, ''))
      from = out.more
    } while (from !== null && ++n < 1e4)
    assert.equal(got, desc)
  }
})

test('tool: a schema past the budget is the JSON tree, inside the budget', () => {
  const { schema } = schemaOf(2), budget = 20
  let from = 0, out, n = 0
  do { out = renderKind(TOOL, { schema }, { from, budget }); from = out.more } while (from !== null && ++n < 100)
  assert.ok(has(wrap(out), 'kd-json') && !has(out.html, 'tool-params'))
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

test('opaque and parts: the fidelity line and no bytes of the signature; each part drawn by its own spec', () => {
  for (let i = 0; i < 50; i++) {
    const sig = 'SIG' + str(60), v = { signature: sig, thinking: '' }
    const out = renderKind({ as: 'opaque', f: { body: [] } }, v)
    assert.ok(has(wrap(out), 'kd-opaque'))
    assert.equal(textOf(out.html), OPAQUE_LINE)
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
      assert.ok(textOf(h).startsWith(FAIL_LINE), 'one line, no kind word')
    }
  }
})

test('tone: error and quiet put their class on the wrapper of any kind', () => {
  for (const as of ['text', 'code', 'json', 'kv', 'nope']) {
    assert.ok(has(wrap(renderKind({ as, tone: 'error' }, { a: 1 })), 'tone-error'))
    assert.ok(has(wrap(renderKind({ as, tone: 'quiet' }, 'x')), 'tone-quiet'))
  }
})

// ── markdown, diff, media ─────────────────────────────────────────────────────────────────────────────────────────
const plain = () => str(12).replace(/[\u001b\r\n|*_`[\]\\#>~+-]/g, '') + 'w' // a table cell / text run with no markdown syntax in it

test('markdown: with no renderer registered it is text with every source byte', () => {
  for (let i = 0; i < 100; i++) {
    const src = `# ${plain()}\n${str(100)}`, out = renderKind({ as: 'markdown' }, src, { budget: 1e9 })
    assert.ok(has(wrap(out), 'kd-text'))
    assert.equal(textOf(out.html), src)
  }
})

test('markdown: a registered renderer gets the source, from, budget and file, and its more comes back as it is', () => {
  const calls = []
  setMarkdown((src, o) => { calls.push({ src, ...o }); return { html: '<p>x</p>', more: o.from > 0 ? null : 7 } })
  try {
    for (let i = 0; i < 50; i++) {
      calls.length = 0
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, plain), gutter = rnd() < 0.5, file = rnd() < 0.5
      const src = lines.map((l, k) => (gutter ? `${String(k + 1).padStart(6)}→${l}` : l)).join('\n')
      const budget = 100 + Math.floor(rnd() * 1000), r = { as: 'markdown', f: { gutter, file } }
      const one = renderKind(r, src, { budget }), two = renderKind(r, src, { from: 7, budget })
      assert.ok(has(wrap(one), 'kd-md'))
      assert.equal(one.more, 7)
      assert.equal(two.more, null)
      assert.deepEqual(calls, [{ src: lines.join('\n'), from: 0, budget, file }, { src: lines.join('\n'), from: 7, budget, file }].map((c) => (gutter ? c : { ...c, src })))
    }
  } finally { setMarkdown(null) }
})

// ── paths: every data-path and data-media is absolute from the view's body ──────────────────────────────────────────────
const pathsIn = (h, attr) => [...h.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map((m) => JSON.parse(textOf(m[1])))
const TEXT = { as: 'text', f: { body: ['text'] } }

test('parts: a part cut by the budget opens its tail at the path it names, and the siblings after it stay reachable', () => {
  for (const budget of [20000, 7000, 29999]) {
    const a = 'x'.repeat(30000), b = 'second part', body = { block: { content: [{ type: 'text', text: a }, { type: 'text', text: b }] } }
    const r = { as: 'parts', f: { body: ['block', 'content'] }, kids: { 0: TEXT, 1: TEXT } }
    const out = renderKind(r, body, { budget })
    const opened = [...out.html.matchAll(/<details class="j-more" data-path="([^"]*)" data-span="(\d+),(\d+)">/g)].map((m) => {
      let at = +m[2], got = ''
      while (at != null) {
        const h = jsonNodeHtml(body, JSON.parse(textOf(m[1])), [at, +m[3]], { budget })
        got += textOf(h.replace(/<summary>[^<]*<\/summary>/g, ''))
        at = /data-span="(\d+),/.exec(h)?.[1] ?? null
        if (at != null) at = +at
      }
      return [+m[2], got]
    })
    const whole = textOf(out.html.replace(/<details[^]*?<\/details>/g, ''))
    assert.equal(whole + opened.map(([, t]) => t).join(''), a + b)
  }
})

test('a JSON tree stored in a string opens below two levels from the absolute path', () => {
  for (let i = 0; i < 50; i++) {
    const leaf = 'leaf' + i, v = { a: { b: { c: { d: [leaf] } } } }, body = { block: { text: JSON.stringify(v) } }
    const out = renderKind({ as: 'json', f: { body: ['block', 'text'] } }, body)
    const closed = out.html.match(/<details (?:class="[^"]*" )?data-path="([^"]*)"><summary>/)
    assert.ok(closed, 'a closed node')
    const path = JSON.parse(textOf(closed[1]))
    assert.deepEqual(path.slice(0, 2), ['block', 'text'])
    assert.notEqual(jsonNodeHtml(body, path), '')
  }
})

const dlines = (h) => [...h.matchAll(/<div class="(d-add|d-del|d-ctx)">([^<]*)<\/div>/g)].map((m) => [m[1], textOf(m[2])])
const lineBits_ = ['a', 'b', 'c', 'x = 1', '', '  }', '<p>', '"q"']
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
    const out = renderKind({ as: 'diff', f: { old: ['o'], new: ['n'] } }, { o, n }, { budget: o.length + n.length })
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

// 2.3 §切片: a kind drawn whole is drawn within the budget whatever its body's shape, the slices read back as its text, and what it
// draws is spent, so what follows it in the block gets what is left
test('diff and shell over an object body: past the budget their text in slices within it; what they draw is spent', () => {
  const lines = (n) => { let s = '@@ -1 +1 @@'; while (s.length < n) s += '\n+' + plain(); return s.slice(0, n) }
  const kinds = [
    ['patch', { as: 'diff', f: { body: ['input'], patch: ['input', 'p'] } }, (t) => ({ input: { p: t } })],
    ['pair', { as: 'diff', f: { body: ['input'], old: ['input', 'o'], new: ['input', 'n'] } }, (t) => ({ input: { o: t, n: t.slice(0, t.length >> 1) } })],
    ['shell', { as: 'shell', f: { body: ['input'], cmd: ['input', 'c'] } }, (t) => ({ input: { c: t } })],
  ]
  for (const budget of [500, 3000]) for (const [name, r, of] of kinds) for (const n of [budget >> 2, budget - 1, budget + 1, budget * 3, budget * 20]) {
    const v = of(lines(n)), at = `${name} ${n}/${budget}`, want = copyOf(r, v)
    let out = renderKind(r, v, { budget }), got = textOf(out.html).replace(/\n+/g, '\n'), from = 0, steps = 0
    if (out.more == null) { assert.ok(out.cls.includes(name === 'shell' ? 'kd-shell' : 'kd-diff'), at); continue }
    assert.ok(n > budget >> 1, at)
    assert.equal(out.total, want.length, at)
    let read = ''
    while (out) {
      const end = out.more ?? want.length
      assert.ok(end - from <= budget + 1, `${at}: a slice of ${end - from}`)
      read += want.slice(from, end); from = end; steps++
      out = out.more == null ? null : renderKind(r, v, { from, budget })
    }
    assert.equal(read, want, at)
    assert.ok(steps > 1, at)
  }
  const t = lines(300), left = 100
  for (const [, r, of] of kinds) {
    const v = of(t), spent = t.length + (v.input.n?.length ?? 0)
    const out = renderKind({ as: 'parts', kids: [r, { as: 'text' }] }, [v, 'Y'.repeat(1000)], { budget: spent + left })
    assert.equal(count(out.html, /Y/g), left, 'what follows a whole kind has what it left')
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
    const out = renderKind(MEDIA, { d: header(kind, w, h).toString('base64'), m: 'image/' + kind.split('-')[0] })
    assert.ok(has(wrap(out), 'kd-media'))
    const img = out.html.match(/<img ([^>]*)>/)
    assert.ok(img, kind)
    assert.deepEqual(pathsIn(img[1], 'data-media'), [['d']])
    assert.match(img[1], new RegExp(`data-mime="image/${kind.split('-')[0]}"`))
    assert.match(img[1], new RegExp(`width="${w}" height="${h}"`))
    assert.doesNotMatch(img[1], /\bsrc=/)
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>' + plain() + '</text></svg>'
  const s = renderKind(MEDIA, { d: Buffer.from(svg).toString('base64'), m: 'image/svg+xml' })
  assert.ok(has(wrap(s), 'kd-code'))
  assert.equal(textOf(s.html), svg)
  const pdf = renderKind(MEDIA, { d: Buffer.from('%PDF-1.7').toString('base64'), m: 'application/pdf' })
  assert.match(pdf.html, /class="kd-file"[^]*<button type="button" data-cellsave/)
  assert.deepEqual(pathsIn(pdf.html, 'data-media'), [['d']])
  assert.match(pdf.html, /data-mime="application\/pdf"/)
  const url = renderKind({ as: 'media', f: { body: [], url: ['url'] } }, { url: 'https://e.x/a.png' })
  assert.doesNotMatch(url.html, /<img|src=|href=/)
  assert.ok(textOf(url.html).includes('https://e.x/a.png') && textOf(url.html).includes(IMAGE_URL))
})

test('media: images in parts each carry the absolute path of their own data', () => {
  const pic = (w) => ({ type: 'image', source: { media_type: 'image/png', data: header('png', w, 3).toString('base64') } })
  const body = { block: { content: [pic(1), pic(2)] } }, kid = { as: 'media', f: { body: [], data: ['source', 'data'], mime: ['source', 'media_type'] } }
  const out = renderKind({ as: 'parts', f: { body: ['block', 'content'] }, kids: { 0: kid, 1: kid } }, body)
  const paths = pathsIn(out.html, 'data-media')
  assert.equal(new Set(paths.map(String)).size, 2)
  assert.deepEqual(paths.map((p) => p.reduce((x, k) => x[k], body)), body.block.content.map((x) => x.source.data))
})

test('total: a string is its length, an object the sum of its strings, drawn or not', () => {
  const strings = (v) => typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.values(v).reduce((n, x) => n + strings(x), 0) : 0
  for (let i = 0; i < 100; i++) {
    const v = val(4), budget = 1 + Math.floor(rnd() * 50)
    assert.equal(renderKind({ as: typeof v === 'string' ? 'text' : 'json', f: { body: ['b'] } }, { b: v, other: 'not this cell' }, { budget }).total, strings(v))
  }
  const wide = renderKind({ as: 'json' }, Array.from({ length: 2e6 }, () => 'ab'))
  assert.ok(wide.total > 0 && wide.total < 4e6, 'a bounded walk')
})

test('markdown, diff, media: input they cannot draw falls back to text with the fail line', () => {
  for (let i = 0; i < 50; i++) {
    for (const [r, v] of [[{ as: 'diff' }, plain() + '\n+' + plain()], [{ as: 'diff', f: { patch: ['p'] } }, { p: 7 }],
      [{ as: 'diff', f: { old: ['o'], new: ['n'] } }, { o: 'a' }], [{ as: 'markdown' }, { a: 1 }],
      [MEDIA, { d: '!' + plain(), m: 'image/png' }], [MEDIA, { d: header('png', 3, 4).subarray(0, 14).toString('base64'), m: 'image/png' }]]) {
      const h = wrap(renderKind(r, v))
      assert.ok(has(h, 'kd-fail') && has(h, 'kd-text'), JSON.stringify(r))
      assert.ok(textOf(h).startsWith(FAIL_LINE), 'one line, no kind word')
    }
  }
})

// ── textOf: what Copy text gives (2.3 #41) ───────────────────────────────────────────────────────────────────────────
const LONG = 'a line of the body\n'.repeat(3000) // past a slice; a copy is not cut by any budget
const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 9, 0, 0, 0, 7, 8, 2, 0, 0, 0))
const kinds = (S) => ({
  text: [{ as: 'text', f: { body: ['t'] } }, { t: S + LONG + S }],
  'text over an object': [{ as: 'text', f: { body: ['t'] } }, { t: { k: S } }],
  code: [{ as: 'code', title: S, f: { body: ['t'] } }, { t: LONG + S }],
  markdown: [{ as: 'markdown', f: { body: ['t'] } }, { t: `# ${S}\n\n**b** ${LONG}` }],
  shell: [{ as: 'shell', f: { body: ['input'], cmd: ['input', 'command'], note: ['input', 'description'] } }, { input: { command: `echo ${S}`, description: 'x', timeout: S + 'T' } }],
  'shell argv': [{ as: 'shell', f: { body: [], cmd: ['cmd'] } }, { cmd: ['echo', S] }],
  'diff patch': [{ as: 'diff', f: { body: ['p'] } }, { p: `--- a\n+++ b\n@@ -1 +1 @@\n-x\n+${S}\n` }],
  'diff pair': [{ as: 'diff', f: { body: [], old: ['o'], new: ['n'] } }, { o: 'same\nold', n: `same\n${S}` }],
  kv: [{ as: 'kv', f: { body: ['i'] }, kids: { a: { as: 'code', f: { body: [] } } } }, { i: { a: S, b: { deep: S + 'B' } } }],
  json: [{ as: 'json', f: { body: ['j'] } }, { j: { a: [S] } }],
  'json in a string': [{ as: 'json', f: { body: ['j'] } }, { j: JSON.stringify({ a: S }) }],
  parts: [{ as: 'parts', f: { body: ['c'] }, kids: { 0: { as: 'text', f: { body: ['text'] } } } }, { c: [{ text: S }, S + 'P'] }],
  tool: [TOOL, { desc: S, schema: { properties: { [S + 'K']: { type: 'string' } } } }],
  'media url': [{ as: 'media', f: { body: [], url: ['u'] } }, { u: `https://x.test/${S}` }],
})
test('2.3 #41: textOf holds the view\'s words for every kind, whole, past any slice', () => {
  for (let i = 0; i < 40; i++) {
    const S = `S${i}-${pick(['plain', '<tag>', 'a&b', 'é😀'])}`
    for (const [name, [r, v]] of Object.entries(kinds(S))) {
      const t = copyOf(r, v)
      assert.equal(typeof t, 'string', name)
      assert.ok(t.includes(S), `${name}: holds what the view holds`)
      assert.ok(!t.includes('<div') && !t.includes('<span'), `${name}: no markup`)
    }
    assert.equal(copyOf(kinds(S).text[0], kinds(S).text[1]), S + LONG + S)
  }
  assert.equal(copyOf({ as: 'opaque' }, { signature: 'SIG' }), OPAQUE_LINE)
  assert.ok(copyOf({ as: 'media', f: { body: [], data: ['d'], mime: ['m'] } }, { d: PNG, m: 'image/png' }).includes('9×7'), 'an image with no URL: its description')
})

test('2.3 #41: textOf reads each kind\'s source: markdown as written, a gutter and a parts break, an edit pair signed line by line', () => {
  const src = '# T\n\n**bold** `c`\n'
  assert.equal(copyOf({ as: 'markdown', f: { body: [] } }, src), src)
  assert.equal(copyOf({ as: 'code', title: 'file.txt', f: { body: [], gutter: true } }, '     1→one\n     2→two'), 'file.txt\none\ntwo')
  assert.equal(copyOf({ as: 'parts', f: { body: [] } }, ['a', 'b']), 'a\n\nb')
  assert.deepEqual(JSON.parse(copyOf({ as: 'json', f: { body: [] } }, { a: [1] })), { a: [1] })
  for (let i = 0; i < 50; i++) {
    const a = Array.from({ length: Math.floor(rnd() * 8) }, () => pick(lineBits_)), b = Array.from({ length: Math.floor(rnd() * 8) }, () => pick(lineBits_))
    const L = copyOf({ as: 'diff', f: { body: [], old: ['o'], new: ['n'] } }, { o: a.join('\n'), n: b.join('\n') }).split('\n')
    assert.deepEqual(L.filter((l) => l[0] !== '+').map((l) => l.slice(1)).join('\n'), a.join('\n'))
    assert.deepEqual(L.filter((l) => l[0] !== '-').map((l) => l.slice(1)).join('\n'), b.join('\n'))
  }
  const big = Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n'), both = copyOf({ as: 'diff', f: { body: [], old: ['o'], new: ['n'] } }, { o: big, n: 'NEW-' + big })
  assert.ok(both.includes(big) && both.includes('NEW-'), 'past the line cap: both sides whole')
})

test('2.3 #41: what cannot be drawn is copied as the fallback text, never a throw', () => {
  const S = 'SENTINEL', cases = [
    [{ as: 'markdown', f: { body: [] } }, { a: S }], [{ as: 'diff', f: { body: [] } }, `not a patch ${S}`], [{ as: 'kv', f: { body: ['a'] } }, { a: S }],
    [{ as: 'shell', f: { body: [], cmd: ['x'] } }, { y: S }], [{ as: 'tool', f: { body: [], desc: ['d'] } }, { y: S }], [{ as: 'parts', f: { body: [] } }, S],
    [{ as: 'media', f: { body: [], data: ['d'], mime: ['m'] } }, { d: '*not base64*', m: 'image/png', S }], [{ as: 'json', f: { body: [] } }, `{half ${S}`],
    [{ as: 'text', f: { body: ['gone'] } }, { S }], [{ as: 'no such kind' }, S], [undefined, S], [null, { S }],
  ]
  for (const [r, v] of cases) assert.ok(copyOf(r, v).includes(S), JSON.stringify(r))
})
