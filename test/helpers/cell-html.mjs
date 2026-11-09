// test/helpers/cell-html.mjs — what a cell may emit (spec 2.3 §两种模式): only the allowed elements and attributes, no src,
// `style` only as `--cl:<digits>`, `href` only to http, https or mailto, and no attribute value or text run that leaves its
// quotes or its tag. `check` asserts it over one piece of markup.
import assert from 'node:assert/strict'

const ELEMENTS = new Set(['pre', 'code', 'span', 'div', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'details', 'summary',
  'img', 'button', 'a', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 's', 'br', 'hr'])
// the allowed cell attributes (RFC 2.3 §两种模式), plus `open`: the boolean state of the allowed <details>
const ATTR = /^(?:class|data-[a-z0-9-]+|aria-[a-z]+|role|title|type|tabindex|width|height|alt|decoding|style|open|href|target|rel|value|start)$/
const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z][a-z0-9-]*(?:="[^"<>]*")?)*)\s*>/y

export function check(html, what) {
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
      if (name === 'href') assert.match(val ?? '', /^(?:https?:|mailto:)/i, `${what}: href`)
    }
    i = TAG.lastIndex
  }
}
