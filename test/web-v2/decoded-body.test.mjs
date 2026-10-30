// 2.3 §block 卡 体: an opened body is the verbatim bytes (AC-1). A body that is one JSON value whose text form differs from those
// bytes gets a control to show that text, marked as decoded; the default stays the bytes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { blockBodyHtml, clipText, decodedText } from '../../src/web/v2/replay/blocks.mjs'

const entities = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#13;': '\r', '&amp;': '&' }
const unesc = (s) => s.replace(/&(lt|gt|quot|#39|#13|amp);/g, (m) => entities[m])
const pres = (html) => [...html.matchAll(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/g)].map((m) => ({ attrs: m[1], text: unesc(m[2].startsWith('\n') ? m[2].slice(1) : m[2]) }))

const lsOut = '\n-rw-------   1 u  staff  30611988 a.ndjson\r\n-rw-------   1 u  staff  12 <b> & "c"\n'
// the axis: block shapes a wire body can take, and whether the spec's rule gives it a text form different from its bytes
const AXIS = [
  ['tool_result, string content', JSON.stringify({ tool_use_id: 'toolu_1', type: 'tool_result', content: lsOut }), true],
  ['tool_result, text-part array', JSON.stringify({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'a\nb' }, { type: 'text', text: 'c' }] }), true],
  ['tool_use, input object', JSON.stringify({ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls -la\nwc -l' } }), true],
  ['JSON string literal', JSON.stringify('line one\nline two\t"q"'), true],
  ['plain text', 'just words\nand a second line', false],
  ['invalid JSON', '{"type":"tool_result","content":"cut', false],
  ['JSON number', '42', false],
]
const B = { sec: 'messages', text_ref: 'f:1:0:10' }

test('A1: the default opened body is exactly the verbatim bytes; the decode control shows only when there is a different text form', () => {
  for (const [name, text, decodes] of AXIS) {
    const html = blockBodyHtml({ status: 'ok', text, fidelity: 'verbatim' }, B)
    const ps = pres(html)
    assert.equal(ps.length, 1, name)
    assert.equal(ps[0].text, text, name)
    assert.equal(decodedText(text) != null, decodes, name)
    assert.equal(/data-decode\b/.test(html), decodes, name)
  }
})

test('A2: the decoded view shows the text form, marked as decoded, never as verbatim', () => {
  for (const [name, text, decodes] of AXIS) {
    if (!decodes) continue
    const html = blockBodyHtml({ status: 'ok', text, fidelity: 'verbatim' }, B, { decoded: true })
    const ps = pres(html)
    assert.equal(ps.length, 1, name)
    assert.match(ps[0].attrs, /data-view="decoded"/, name)
    assert.equal(ps[0].text, clipText(decodedText(text)), name)
    assert.ok(!/data-ff="verbatim"/.test(html), name)
  }
})
