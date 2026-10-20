// test/web-v2/ac1-real-server.test.mjs — 1.4 验收 #7, AC-1 on the real server: for the demo session and every session of the
// generated multi-harness set, every request block a session document names (every page, followed to the end) reads back
// through `GET /api/block` as exactly the bytes its text_ref spans in the record on disk, and the board displays those bytes
// (the <pre> read the way a browser parses it). The slice is taken here from the segment file itself, not through the query
// code under test. The generated set is the seven harnesses' wire shapes (scripts/gen-dataset.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { boardHome, serveBoard } from './real-face.mjs'
import { parseTextRef } from '../../src/raw/refs.mjs'
import { blockBodyHtml } from '../../src/web/v2/replay/blocks.mjs'

const entities = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#13;': '\r', '&amp;': '&' }
const shown = (html) => {
  const m = /<pre class="cbpre">([\s\S]*?)<\/pre>/.exec(html)
  assert.ok(m, 'a <pre class="cbpre"> body')
  return (m[1].startsWith('\n') ? m[1].slice(1) : m[1]).replace(/&(lt|gt|quot|#39|#13|amp);/g, (e) => entities[e])
}

test('1.4 #7 · AC-1: every request block of every session, every page, is the source record\'s bytes in /api/block and on screen', { timeout: 120_000 }, async () => {
  const { userHome, home } = boardHome({ bytes: 4e5 })
  const lines = new Map() // segment → its lines, read once from the file on disk
  const recordOf = (recordId) => {
    const [seg, n] = [recordId.slice(0, recordId.lastIndexOf(':')), Number(recordId.slice(recordId.lastIndexOf(':') + 1))]
    if (!lines.has(seg)) lines.set(seg, fs.readFileSync(path.join(home, 'raw', `${seg}.ndjson`), 'utf8').split('\n'))
    return JSON.parse(lines.get(seg)[n - 1])
  }
  const face = await serveBoard({ userHome, home })
  try {
    const sessions = (await face.get('sessions')).doc.sessions
    assert.ok(new Set(sessions.map((s) => s.harness)).size >= 7, `the set covers the seven harnesses: ${[...new Set(sessions.map((s) => s.harness))]}`)
    let checked = 0
    for (const { session_id: id } of sessions) {
      let after = null, doc
      do {
        doc = (await face.get('session', { id, ...(after != null ? { after } : {}) })).doc
        const refs = new Set([...JSON.stringify(doc.analyzed).matchAll(/"text_ref":"((?:[^"\\]|\\.)+)"/g)].map((m) => JSON.parse(`"${m[1]}"`)))
        for (const ref of refs) {
          const { field, start, end, recordId } = parseTextRef(ref)
          if (field != null || start == null) continue // a reply field or a whole record: not a request block span
          const rec = recordOf(recordId)
          if (typeof rec.req_body !== 'string') continue // a body stored compressed or parsed: /api/block says decoded / reserialized (block.mjs), not verbatim
          const block = (await face.get('block', { ref })).doc
          const want = rec.req_body.slice(start, end)
          assert.equal(block.bytes, want, `${ref}: /api/block bytes = the record's span`)
          assert.equal(block.fidelity.verbatim, true, `${ref}: a span of the stored request is verbatim`)
          if (want.length <= 20000) assert.equal(shown(blockBodyHtml({ status: 'ok', text: block.bytes }, { text_ref: ref })), want, `${ref}: displayed as captured`)
          checked++
        }
        after = doc.page.next
      } while (doc.page.has_more)
    }
    assert.ok(checked > 100, `request blocks checked: ${checked}`)
  } finally { await face.close() }
})
