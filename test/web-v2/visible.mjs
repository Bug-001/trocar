// test/web-v2/visible.mjs — what a reader sees in a rendered block (K-29): the markup with every collapsed disclosure body
// (`<div class="disc-b" … hidden>`, the technical details) cut out, and the reasons a failed read may carry. Exports only.

import assert from 'node:assert/strict'
import { esc } from '../../src/web/v2/core/fmt.mjs'

// the markup outside every collapsed disclosure body, cut by counting <div> depth (a body holds nested divs)
export function outsideCollapsed(html) {
  const open = /<div class="disc-b"[^>]*\shidden>/g
  const tag = /<(\/?)div\b[^>]*>/g
  let out = '', i = 0
  for (;;) {
    open.lastIndex = i
    const m = open.exec(html)
    if (!m) return out + html.slice(i)
    out += html.slice(i, m.index)
    let depth = 1, j = m.index + m[0].length
    tag.lastIndex = j
    while (depth > 0) {
      const t = tag.exec(html)
      if (!t) { j = html.length; break }
      depth += t[1] ? -1 : 1
      j = t.index + t[0].length
    }
    i = j
  }
}
// the visible text: outside the collapsed bodies, tags stripped
export const visibleOf = (html) => outsideCollapsed(html).replace(/<[^>]*>/g, '')

// the reasons a server or a thrown error may hand the board, each carrying `tok` (the empty one carries nothing)
export const reasonsWith = (tok) => [
  `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory ${tok}\n    at f (/x/a.mjs:1:2)\n    at g (/x/b.mjs:3:4)`,
  `<b>${tok}</b> & "quoted" 'single'`,
  '',
  'x'.repeat(5000) + tok,
]

// the K-29 invariant over one rendered block: `token` never outside the collapsed details; when a reason was given, present
// there (escaped)
export function hidesReason(html, token, given, where) {
  assert.ok(!outsideCollapsed(html).includes(token), `${where}: reason outside the technical details`)
  assert.ok(!visibleOf(html).includes(token), `${where}: reason in the visible text`)
  if (given) assert.ok(html.includes(esc(token)), `${where}: reason not kept in the technical details`)
}
