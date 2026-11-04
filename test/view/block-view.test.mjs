// test/view/block-view.test.mjs — the seam between the read path and the cell (spec 2.3 #36, 3.1 #9): real records go through extraction,
// the real `lane` and `block` answers and the real cell, on every wire shape and block type. Each side used to be tested on a shape
// written by hand, so nothing ever crossed. No markdown renderer is registered in Node: markdown draws as text, word for word.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CALL_WIRES, INTERLEAVED, PRE_D40, SENTINEL, V0_RECORD, WIRES } from '../helpers/wire-records.mjs'
import { homeWith, query } from '../helpers/session-doc.mjs'
import { cellOf, rOf } from '../../web/legacy/replay/cell.mjs'
import { renderKind } from '../../web/legacy/replay/kinds.mjs'
import { FF_WORD } from '../../web/legacy/labels/replay.mjs'

// what a thinking block's view gives up on purpose: the provider's encrypted reasoning, which nobody can read
const ENCRYPTED = new Set(['S_think_enc', 'S_think_enc_only', 'S_r_enc', 'S_r_enc_only'])
const sentinels = (s) => [...new Set(s.match(SENTINEL) || [])]
const FRAME = /^(?:event|data):/m
const textOf = (html) => html.replace(/<[^>]*>/g, '\n')

// A wire's blocks as the board reads them: every definition of every lane, its `block` answer, its cell and what the cell draws.
const held = new Map()
const seam = (records) => { if (!held.has(records)) held.set(records, read(records)); return held.get(records) }
async function read(records) {
  const home = homeWith(records), out = []
  for (const { session_id: id } of (await query(home, 'sessions')).sessions) {
    const { calls } = await query(home, 'session', { id })
    for (const lane of new Set(calls.map((c) => c.lane))) {
      const { defs, steps } = await query(home, 'lane', { id, lane }), replies = new Set(steps.flatMap((s) => s.reply))
      const ref = defs.map((d) => d.ref).filter(Boolean), answer = ref.length ? await query(home, 'block', { ref }) : { blocks: [], errors: [] }
      assert.deepEqual(answer.errors, [])
      const at = new Map(answer.blocks.map((b) => [b.ref, b]))
      for (const def of defs) {
        const got = at.get(def.ref), cell = cellOf(def), view = got?.view ?? cell.view
        const r = view ? rOf(cell, view) : null
        out.push({ def, got, view, cell, r, reply: replies.has(def.bid), html: r ? renderKind(r, view.body).html : '', what: `${def.kind} ${def.preview}` })
      }
    }
  }
  return out
}
const ALL = { ...WIRES, ...PRE_D40 }
const onEveryWire = (wires, name, check) => test(name, async () => {
  for (const [wire, records] of Object.entries(wires)) for (const b of await seam(records)) check(b, `${wire}: ${b.what}`)
})

onEveryWire(ALL, 'a block with a ref has a view, unless the capture kept only its metadata', ({ def, got }, at) => {
  assert.ok(def.ref, at)
  assert.ok(got.view || def.ff.faithfulness === 'metadata', at)
})

onEveryWire(ALL, 'every sentinel in a block\'s bytes is in its view, encrypted fields apart', ({ got, view }, at) => {
  const body = JSON.stringify(view.body)
  for (const s of sentinels(got.bytes)) assert.ok(ENCRYPTED.has(s) || body.includes(s), `${at}: ${s}`)
})

test('nothing planted in a record falls outside every block', async () => {
  for (const [wire, records] of Object.entries(ALL)) {
    const seen = (await seam(records)).map(({ view }) => JSON.stringify(view.body)).join('\n')
    for (const s of sentinels(JSON.stringify(records))) assert.ok(ENCRYPTED.has(s) || seen.includes(s), `${wire}: ${s}`)
  }
})

onEveryWire(ALL, 'a block draws without the failure line, and a reply block with no stream frames', ({ html, reply }, at) => {
  assert.ok(!html.includes('kd-fail'), at)
  if (reply) assert.ok(!FRAME.test(textOf(html)), at)
})

onEveryWire(ALL, 'a tool definition reaches its description and its Parameters', ({ def, got, html }, at) => {
  if (def.sec !== 'tools' && def.kind !== 'tool_addition') return
  for (const s of sentinels(got.bytes).filter((x) => /_(?:desc|param)$/.test(x))) assert.ok(html.includes(s), `${at}: ${s}`)
})

onEveryWire(ALL, 'a server tool shows its configuration, not a metadata-only note', ({ def, got, html }, at) => {
  if (def.sec !== 'tools') return
  const tool = JSON.parse(got.bytes)
  if (tool.description !== undefined || tool.input_schema !== undefined || tool.parameters !== undefined || tool.function !== undefined) return
  assert.notEqual(def.ff.faithfulness, 'metadata', at)
  assert.ok(!html.includes(FF_WORD.metadata), at)
  for (const k of Object.keys(tool)) assert.ok(html.includes(k), `${at}: ${k}`)
})

onEveryWire(ALL, 'image bytes draw as media; a remote image is its URL and is never loaded', ({ def, got, html }, at) => {
  if (!/^(?:image|document|tool_result)$/.test(def.kind)) return
  if (got.bytes.includes('Sb64')) assert.ok(html.includes('data-media'), at)
  if (got.bytes.includes('S_img_url')) { assert.ok(html.includes('S_img_url'), at); assert.ok(!html.includes('<img'), at) }
})

onEveryWire(ALL, 'a run of stream events says how many it holds; a JSON node has no such count', ({ got, view, reply }, at) => {
  if (reply && FRAME.test(got.bytes)) assert.ok(Number.isInteger(view.events) && view.events > 0, at)
  else assert.equal(view.events, undefined, at)
})

onEveryWire(ALL, 'a truncated tool call shows what arrived, under no internal key', ({ got, html }, at) => {
  if (!got.bytes.includes('S_use_trunc')) return
  assert.ok(html.includes('S_use_trunc'), at)
  assert.ok(!html.includes('_unparsed'), at)
})

onEveryWire(CALL_WIRES, 'an edit is a diff and a Markdown read reads as Markdown, however the keys are spelled', ({ def, got, r, html }, at) => {
  if (got.bytes.includes('S_edit_old')) {
    assert.equal(r.as, 'diff', at)
    for (const s of ['S_edit_old', 'S_edit_new']) assert.ok(html.includes(s), `${at}: ${s}`)
  }
  if (got.bytes.includes('S_read_md')) { assert.equal(def.reads, 'markdown', at); assert.equal(r.as, 'markdown', at) }
})

test('the JSON replies of every wire shape are read back as blocks, with or without the D40 mark', async () => {
  for (const [wires, verbatim] of [[WIRES, true], [PRE_D40, false]]) for (const [wire, records] of Object.entries(wires)) {
    const blocks = (await seam(records)).filter((b) => b.reply)
    assert.ok(blocks.length, wire)
    for (const { got, what } of blocks) assert.equal(got.fidelity.verbatim, verbatim, `${wire}: ${what}`)
  }
})

test('a block\'s bytes stay the record\'s own, beside its view', async () => {
  for (const [wire, records] of Object.entries(WIRES)) for (const { got, reply, what } of await seam(records)) {
    if (!reply) assert.ok(records.some((r) => r.req_body.includes(got.bytes)), `${wire}: ${what}`)
  }
  const blocks = (await seam([V0_RECORD])).filter((b) => b.got)
  assert.ok(blocks.length)
  for (const { got, what } of blocks) {
    assert.ok(got.bytes.length, what)
    assert.equal(got.fidelity.verbatim, false, what)
  }
})

test('a block with no run of its own draws from the definition, its stored parse in Raw', async () => {
  for (const [wire, records] of Object.entries(INTERLEAVED)) {
    const blocks = (await seam(records)).filter((b) => b.reply)
    assert.ok(blocks.length, wire)
    for (const { def, cell, html, what } of blocks) {
      const at = `${wire}: ${what}`, s = sentinels(JSON.stringify(def.inline))
      assert.equal(def.ref, null, at)
      assert.ok(def.r && s.length, at)
      for (const x of s) { assert.ok(cell.inline.includes(x), `${at}: ${x}`); assert.ok(html.includes(x), `${at}: ${x}`) }
      assert.ok(!html.includes('kd-fail'), at)
    }
  }
})
