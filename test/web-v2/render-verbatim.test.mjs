// test/web-v2/render-verbatim.test.mjs — what the board DISPLAYS for a block body is the source text byte for byte, and a
// body over DISPLAY_CLIP chars is clipped to a prefix with the full length said (1.5 验收 #3). The check un-escapes the
// <pre> content the way a browser's HTML parser reads it (one leading newline after <pre> is dropped; character
// references become characters). The half that ran the server's view code on the sample returns in PR 4b over the
// query layer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { blockBodyHtml } from '../../src/web/v2/replay/ctxwin.mjs'
import { DISPLAY_CLIP, bodyFor, clipText } from '../../src/web/v2/replay/blocks.mjs'

const entities = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#13;': '\r', '&amp;': '&' }
const unesc = (s) => s.replace(/&(lt|gt|quot|#39|#13|amp);/g, (m) => entities[m])
function shown(html) {
  const m = /<pre class="cbpre">([\s\S]*?)<\/pre>/.exec(html)
  assert.ok(m, 'a <pre class="cbpre"> body')
  return unesc(m[1].startsWith('\n') ? m[1].slice(1) : m[1])
}
const ok = (text, fidelity = 'verbatim') => ({ status: 'ok', text, fidelity })

test('hostile text survives the display unchanged: markup, entities, quotes, CRLF, a leading newline, CJK, emoji', () => {
  const samples = ['<script>alert(1)</script> & &amp; &lt;b&gt; "q" \'s\'', '\nstarts with a newline', '\n\nstarts with two', 'a\r\nb\rc\n', '中文 · 混排 text 😀 end', '</pre><b>x</b>', '', ' ', '&#13; literal reference text']
  for (const t of samples) assert.equal(shown(blockBodyHtml(ok(t), { text_ref: 'r' })), t, JSON.stringify(t))
})

test('a text over DISPLAY_CLIP chars is clipped to a prefix of the source and says the full length', () => {
  assert.equal(DISPLAY_CLIP, 20000) // 1.5 #3 / 2.3: the display clip is 20 000 chars
  const src = Array.from({ length: 30000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
  // every display path: the raw clip, a resolved body, an inline body as an opened row paints it
  for (const out of [clipText(src), shown(blockBodyHtml(ok(src), { text_ref: 'r' })), shown(bodyFor({ sec: 'system', text: src }))]) {
    assert.ok(out.startsWith(src.slice(0, DISPLAY_CLIP)))
    const rest = out.slice(DISPLAY_CLIP)
    assert.ok(!src.startsWith(out), 'clipped, not the whole text')
    assert.match(rest, /(^|\D)30000(\D|$)/, 'the full length N is said as a number')
  }
  // exactly at the cap: shown whole, nothing appended
  assert.equal(clipText(src.slice(0, 20000)), src.slice(0, 20000))
  assert.equal(shown(blockBodyHtml(ok(src.slice(0, 20000)), { text_ref: 'r' })), src.slice(0, 20000))
  assert.match(clipText(src.slice(0, 20001)).slice(20000), /(^|\D)20001(\D|$)/)
})

test('the clip never splits a surrogate pair', () => {
  const emoji = 'a'.repeat(19999) + '😀' + 'tail'
  const cut = clipText(emoji)
  const body = cut.slice(0, cut.indexOf('\n', 19990))
  assert.ok(emoji.startsWith(body))
  assert.ok(!/[\uD800-\uDBFF]$/.test(body), 'no lone high surrogate at the cut')
})
