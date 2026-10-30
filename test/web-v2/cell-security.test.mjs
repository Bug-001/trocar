// test/web-v2/cell-security.test.mjs — a cell's safety (spec 2.3 §两种模式): hostile content
// pushed through every Readable kind and through the Raw layout emits only the allowed elements and attributes: no src, no
// href, `style` only as `--cl:<digits>`, and no attribute value or text run that leaves its quotes or its tag.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderKind, jsonNodeHtml } from '../../src/web/v2/replay/kinds.mjs'
import { layout } from '../../src/web/v2/replay/jsonlay.mjs'

const ELEMENTS = new Set(['pre', 'code', 'span', 'div', 'dl', 'dt', 'dd', 'table', 'tr', 'td', 'th', 'details', 'summary', 'img', 'button'])
// the allowed cell attributes (RFC 2.3 §两种模式), plus `open`: the boolean state of the allowed <details>
const ATTR = /^(?:class|data-[a-z0-9-]+|aria-[a-z]+|role|title|type|tabindex|width|height|alt|decoding|style|open)$/
const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z][a-z0-9-]*(?:="[^"<>]*")?)*)\s*>/y

function check(html, what) {
  for (let i = 0; i < html.length;) {
    const lt = html.indexOf('<', i)
    assert.ok(!html.slice(i, lt < 0 ? undefined : lt).includes('>'), `${what}: a raw > in text`)
    if (lt < 0) break
    TAG.lastIndex = lt
    const m = TAG.exec(html)
    assert.ok(m, `${what}: not a well-formed tag at ${JSON.stringify(html.slice(lt, lt + 60))}`)
    assert.ok(ELEMENTS.has(m[2]), `${what}: element ${m[2]}`)
    if (m[1]) assert.equal(m[3], '', `${what}: an end tag with attributes`)
    for (const [, name, val] of m[3].matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/g)) {
      assert.match(name, ATTR, `${what}: attribute ${name}`)
      if (name === 'style') assert.match(val ?? '', /^--cl:\d+$/, `${what}: style`)
      if (name === 'open') assert.equal(val, undefined)
    }
    i = TAG.lastIndex
  }
}

const CTRL = Array.from({ length: 32 }, (_, k) => String.fromCharCode(k)).join('')
const H = ['<script>alert(1)</script>', '" onerror="alert(1)', "' onerror='x", 'javascript:alert(1)', '</pre>', '"><img src=x>',
  '  ', CTRL, '<', '"', "'", '&lt;', '</div><a href="x">', '-->', '<!--', '<svg onload=x>', '`', 'x'.repeat(200000)]
const hs = (k) => H[k % H.length]
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000100000000c', 'hex'), Buffer.alloc(20)]).toString('base64')

// hostile values: strings, objects keyed by hostile strings, arrays, and composites in each kind's own syntax
function values() {
  const out = []
  for (let k = 0; k < H.length; k++) {
    const h = hs(k), g = hs(k + 3)
    out.push(h, { [h]: g, [g]: [h, { [h]: h }] }, [h, g],
      `# ${h}\n- ${g}\n> ${h}\n[${h}](${g})\n**${h}** *${g}* \`${h}\`\n\n| ${h} | ${g} |\n|---|---|\n| ${g} | ${h} |\n\`\`\`${h}\n${g}\n\`\`\``,
      `@@ ${h} @@\n+${g}\n-${h}\n ${g}`, `<${h.replace(/\W/g, '') || 'x'}>${g}</${h.replace(/\W/g, '') || 'x'}>`,
      { o: `${h}\n${g}`, n: `${g}\n${h}`, p: `*** ${h}\n+${g}`, d: PNG, m: h, cmd: [h, g], note: g, sig: h, [h]: g })
    out.push({ d: Buffer.from(`<svg>${h}</svg>`).toString('base64'), m: 'image/svg+xml' }, { d: 'JVBER' + h, m: 'application/pdf' },
      { d: Buffer.from(h).toString('base64'), m: 'application/' + h })
  }
  return out
}
// render specs: every `as`, with hostile titles, tones, f paths and kids
function specs() {
  const out = []
  const AS = ['text', 'markdown', 'code', 'shell', 'diff', 'json', 'kv', 'media', 'sections', 'opaque', 'parts', '<b>', 'x" y']
  AS.forEach((as, k) => {
    const h = hs(k), g = hs(k + 5)
    out.push({ as }, { as, title: h, tone: g, kids: { [h]: { as: g, title: h }, 0: { as: 'markdown', title: g } } },
      { as, title: g, f: { body: [h], cmd: h, note: [g], old: ['o'], new: ['n'], patch: ['p'], data: ['d'], mime: ['m'], sig: [h], gutter: true },
        kids: [{ as: 'code', title: h }, { as: 'json' }, { as: h }] },
      { as, f: { old: ['o'], new: ['n'], data: ['d'], mime: ['m'], cmd: ['cmd'], note: ['note'], sig: ['sig'] }, kids: h })
  })
  return out
}

test('every kind over hostile content emits only allowed elements and attributes, never src or href', () => {
  const vals = values()
  for (const r of specs()) {
    for (const [k, v] of vals.entries()) {
      const what = `${JSON.stringify(r).slice(0, 80)} × value ${k}`
      let out = renderKind(r, v, { bid: hs(k) })
      const html = `<div class="cellread ${out.cls}">${out.html}</div>`
      check(html, what)
      if (out.more != null) check(renderKind(r, v, { from: out.more, bid: hs(k) }).html, what + ' (continued)')
      for (const m of out.html.matchAll(/data-path="([^"]*)"/g)) {
        check(jsonNodeHtml(v, JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))), what + ' (opened)')
        break
      }
    }
  }
})

test('the Raw layout over hostile content emits only its own span', () => {
  for (const [k, v] of values().entries()) {
    const text = typeof v === 'string' ? v : JSON.stringify(v, null, k % 2 ? 2 : 0)
    let at = 0, state = null
    for (let n = 0; at !== null && n < 1000; n++) {
      const out = layout(text, at, 20000, state)
      check(out.html, `layout value ${k}`)
      at = out.next; state = out.state
    }
  }
})
