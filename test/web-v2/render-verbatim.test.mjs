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
// the Raw cell's text as a browser reads it: one leading newline after <pre> dropped, the inserted layout spans removed (jsonlay's
// contract), character references read back
function shown(html) {
  const m = /<pre class="cellraw">([\s\S]*?)<\/pre>/.exec(html)
  assert.ok(m, 'a <pre class="cellraw"> body')
  const t = m[1].startsWith('\n') ? m[1].slice(1) : m[1]
  return unesc(t.replace(/<span class="lay" aria-hidden="true">[^<]*<\/span>/g, ''))
}
const cellAttr = (html, k) => Number(new RegExp(`<div class="cell"[^>]* data-${k}="(\\d+)"`).exec(html)[1])
const ok = (text, fidelity = 'verbatim') => ({ status: 'ok', text, fidelity })

test('hostile text survives the display unchanged: markup, entities, quotes, CRLF, a leading newline, CJK, emoji', () => {
  const samples = ['<script>alert(1)</script> & &amp; &lt;b&gt; "q" \'s\'', '\nstarts with a newline', '\n\nstarts with two', 'a\r\nb\rc\n', '中文 · 混排 text 😀 end', '</pre><b>x</b>', '', ' ', '&#13; literal reference text']
  for (const t of samples) assert.equal(shown(blockBodyHtml(ok(t), { text_ref: 'r' })), t, JSON.stringify(t))
})

test('a text over DISPLAY_CLIP chars is clipped to a prefix of the source and says the full length', () => {
  assert.equal(DISPLAY_CLIP, 20000) // 1.5 #3 / 2.3: the display clip is 20 000 chars
  const letters = (n) => Array.from({ length: n }, (_, i) => (i % 100 === 99 ? '\n' : String.fromCharCode(97 + (i % 26)))).join('')
  // the axis: plain lines, one JSON value; every display path: a resolved body, an inline body as an opened row paints it
  for (const src of [letters(30000), JSON.stringify({ a: letters(30000) })]) {
    for (const html of [blockBodyHtml(ok(src), { text_ref: 'r' }), bodyFor({ sec: 'system', text: src })]) {
      const cut = cellAttr(html, 'shown')
      assert.equal(cellAttr(html, 'chars'), src.length, 'the full length N rides on the cell')
      assert.ok(cut >= DISPLAY_CLIP && cut < src.length, `clipped at the display budget: ${cut}`)
      assert.equal(shown(html), src.slice(0, cut), 'the first slice is a prefix of the source')
    }
  }
  // the raw clip of the raw panel and the pinned view
  const src = letters(30000)
  assert.ok(clipText(src).startsWith(src.slice(0, DISPLAY_CLIP)) && !src.startsWith(clipText(src)))
  assert.match(clipText(src).slice(DISPLAY_CLIP), /(^|\D)30000(\D|$)/, 'the full length N is said as a number')
  // exactly at the cap: shown whole, nothing appended
  assert.equal(clipText(src.slice(0, 20000)), src.slice(0, 20000))
  const whole = blockBodyHtml(ok(src.slice(0, 20000)), { text_ref: 'r' })
  assert.equal(shown(whole), src.slice(0, 20000))
  assert.equal(cellAttr(whole, 'shown'), 20000)
  assert.match(clipText(src.slice(0, 20001)).slice(20000), /(^|\D)20001(\D|$)/)
})

test('the clip never splits a surrogate pair', () => {
  const emoji = 'a'.repeat(19999) + '😀' + 'tail'
  const cut = clipText(emoji)
  const body = cut.slice(0, cut.indexOf('\n', 19990))
  assert.ok(emoji.startsWith(body))
  assert.ok(!/[\uD800-\uDBFF]$/.test(body), 'no lone high surrogate at the cut')
})
