// test/view/render-kind.test.mjs — the render spec of a block. Expected kinds come from the rule tables
// (wire kind → tool input keys → content sniff), generated along each rule's axes; r never depends on where the block sits.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderOf, inheritedRender } from '../../src/view/render-kind.mjs'

const msg = (kind, block, extra = {}) => ({ sec: 'messages', role: 'user', kind, mi: 0, bi: 0, block, ...extra })
const txt = (text) => msg('text', { type: 'text', text })
const use = (input) => msg('tool_use', { type: 'tool_use', id: 'u1', name: 'n', input }, { role: 'assistant' })
const asOf = (f) => renderOf(f).as
const pad = (n) => 'x'.repeat(n)
const K64 = 64 * 1024, K256 = 256 * 1024

test('a · layer 1: the wire kind decides first', () => {
  const rows = [
    [msg('image', { type: 'image', source: {} }), 'media'],
    [msg('document', { type: 'document', source: {} }), 'media'],
    [msg('thinking', { type: 'thinking', thinking: '# a\n- b\n- c' }, { role: 'assistant' }), 'text'],
    [msg('thinking', { type: 'thinking', thinking: '', signature: 's' }, { faithfulness: 'opaque' }), 'opaque'],
    [msg('thinking', { type: 'thinking', thinking: '', signature: 's' }), 'opaque'],
    [msg('redacted_thinking', { type: 'redacted_thinking', data: 'd' }), 'opaque'],
    [{ sec: 'tools', kind: 'tool', role: 'tool', desc: 'plain', schema: { type: 'object' } }, 'kv'],
    [msg('tool_addition', { type: 'tool_addition', tool: { definition: { name: 'n', description: 'd', input_schema: {} } } }), 'kv'],
    [msg('tool_reference', { type: 'tool_reference', tool_name: 'n' }), 'kv'],
    [msg('item_reference', { type: 'item_reference', id: 'i' }), 'kv'],
    [msg('json', { type: 'json', value: { type: 'x' } }), 'json'],
    [msg('tool_result', { type: 'tool_result', tool_use_id: 'u', content: [{ type: 'text', text: 'a' }] }), 'parts'],
    [msg('web_search_tool_result', { type: 'web_search_tool_result', content: [{ type: 'web_search_result' }] }), 'parts'],
  ]
  for (const [f, as] of rows) assert.equal(asOf(f), as, f.kind)
})

test('a · a tool definition: the description is sniffed, the schema is a json child', () => {
  const md = '# T\n- a\n- b\n- c'
  for (const r of [renderOf({ sec: 'tools', desc: md, schema: { type: 'object' } }),
    renderOf(msg('tool_addition', { type: 'tool_addition', tool: { definition: { description: md, input_schema: { type: 'object' } } } }))]) {
    assert.equal(r.as, 'kv')
    assert.deepEqual(r.parts.map((p) => p.as).sort(), ['json', 'markdown'])
  }
})

test('a · is_error adds the error tone to whatever the content is', () => {
  for (const content of ['plain', '{"a":1}', [{ type: 'text', text: 'x' }]]) {
    const ok = renderOf(msg('tool_result', { type: 'tool_result', content }))
    const bad = renderOf(msg('tool_result', { type: 'tool_result', content, is_error: true }))
    assert.equal(ok.tone, undefined)
    assert.deepEqual(bad, { ...ok, tone: 'error' })
  }
})

test('a · a parts array: each child takes its own r', () => {
  const r = renderOf(msg('tool_result', { type: 'tool_result', content: [{ type: 'text', text: '[1,2]' }, { type: 'image', source: {} }, { type: 'text', text: 'hi' }] }))
  assert.deepEqual(r.parts.map((p) => p.as), ['json', 'media', 'text'])
})

test('a · layer 2: tool input keys, generated over key presence and value type', () => {
  const values = { string: 'ls -la', argv: ['ls', '-la'], object: { a: 1 } }
  for (const [vt, v] of Object.entries(values)) {
    assert.equal(asOf(use({ command: v })), vt === 'object' ? 'kv' : 'shell', `command ${vt}`)
    assert.equal(asOf(use({ cmd: v })), vt === 'string' ? 'shell' : 'kv', `cmd ${vt}`)
  }
  for (const pk of ['file_path', 'path', null]) {
    const at = pk ? { [pk]: '/p/a.txt' } : {}
    const edit = renderOf(use({ ...at, old_string: 'a', new_string: 'b' }))
    assert.equal(edit.as, 'diff')
    assert.equal(edit.title, pk ? '/p/a.txt' : undefined)
    assert.equal(edit.f.old, 'old_string'); assert.equal(edit.f.new, 'new_string')
    const write = renderOf(use({ ...at, content: 'body' }))
    assert.equal(write.as, pk ? 'code' : 'kv', `content with ${pk}`)
    if (pk) { assert.equal(write.title, '/p/a.txt'); assert.equal(write.f.path, pk); assert.equal(write.f.content, 'content') }
    assert.equal(asOf(use({ ...at, old_string: 'a' })), 'kv', 'half an edit pair')
  }
  for (const p of ['*** Begin Patch\n*** Update File: a\n', 'diff --git a/x b/x\n', 'x\n@@ -1,2 +1,3 @@\n a']) {
    const r = renderOf(use({ input: p, note: 'n' }))
    assert.deepEqual([r.as, r.f.patch], ['diff', 'input'])
    assert.equal(asOf(use(p)), 'diff', 'a raw string input is sniffed')
  }
  assert.equal(asOf(use({ text: '@@ not a hunk' })), 'kv')
  const r = renderOf(use({ q: 'plain', n: 3, obj: { a: 1 }, js: '{"a":1}' }))
  assert.deepEqual([r.as, r.parts.map((p) => [p.k, p.as])], ['kv', [['obj', 'json'], ['js', 'json']]])
  assert.deepEqual(renderOf(use({ command: 'x' })).f, { command: 'command' })
  assert.deepEqual(renderOf(use({ cmd: 'x' })).f, { command: 'cmd' })
})

test('a · layer 3: JSON only when whole, ≤ 256 KB and led by { or [', () => {
  const big = (n) => '{"a":"' + pad(n - 8) + '"}'
  for (const ws of ['', '  \n\t']) {
    assert.equal(asOf(txt(ws + '{"a":[1,2]}')), 'json', `lead ${JSON.stringify(ws)}`)
    assert.equal(asOf(txt(ws + '[1,2]')), 'json')
  }
  assert.equal(big(K256).length, K256)
  assert.equal(asOf(txt(big(K256))), 'json')
  assert.equal(asOf(txt(big(K256 + 1))), 'text')
  assert.equal(asOf(txt('{"a":1} trailing')), 'text')
  assert.equal(asOf(txt('"a"')), 'text')
})

test('a · layer 3: patch markers count only inside the first 64 KB', () => {
  const marker = '\ndiff --git a/x b/x\n'
  assert.equal(asOf(txt(pad(K64 - marker.length) + marker)), 'diff')
  assert.equal(asOf(txt(pad(K64) + marker)), 'text')
})

test('a · layer 3: line numbers on ≥ 80 % of the first 50 lines make gutter code', () => {
  for (const sep of ['→', '\t']) {
    const lines = (k, n = 50) => Array.from({ length: n }, (_, i) => (i < k ? `${String(i + 1).padStart(6)}${sep}line` : 'plain line')).join('\n')
    assert.deepEqual(renderOf(txt(lines(40))), { as: 'code', f: { gutter: true } })
    assert.equal(asOf(txt(lines(39))), 'text')
    assert.equal(asOf(txt(lines(40, 50) + '\n' + Array(200).fill('plain').join('\n'))), 'code', 'only the first 50 lines count')
  }
})

test('a · layer 3: a top-level tag pair makes sections, each body sniffed one level deep', () => {
  const r = renderOf(txt('<system-reminder>\n{"a":1}\n</system-reminder>\nhello'))
  assert.equal(r.as, 'sections')
  assert.deepEqual(r.parts.map((p) => [p.tag, p.as]), [['system-reminder', 'json'], [undefined, 'text']])
  const v = '<a>\n<b>\nx\n</b>\n</a>'
  assert.deepEqual(renderOf(txt(v)).parts.map((p) => [p.tag, p.as]), [['a', 'text']], 'one level deep')
  for (const p of renderOf(txt(v)).parts) assert.ok(v.slice(...p.span).includes('<b>'))
  assert.equal(asOf(txt('<a>\nonly an opening tag')), 'text')
  assert.equal(asOf(txt('inline <b>bold</b> word')), 'text')
})

test('a · layer 3: three markdown line markers make markdown', () => {
  for (const mk of ['# h', '- i', '* i', '1. i', '```', '> q', '| a | b |']) {
    assert.equal(asOf(txt(Array(3).fill(mk).join('\nplain\n'))), 'markdown', mk)
    assert.equal(asOf(txt(Array(2).fill(mk).join('\nplain\n'))), 'text', mk)
  }
})

test('b · r does not depend on where the block sits or what surrounds it', () => {
  const block = { type: 'tool_result', tool_use_id: 'u', content: '<x>\n- a\n- b\n- c\n</x>' }
  const base = msg('tool_result', block)
  const want = renderOf(base)
  const axes = [{ mi: 7 }, { bi: 3 }, { si: 2 }, { role: 'tool' }, { cc: { type: 'ephemeral' } }, { key: 'M:other' }, { resKey: 'file::/a' },
    { toolName: 'other' }, { call: 'c2', path: ['input', 9] }]
  for (const ax of axes) assert.deepEqual(renderOf({ ...base, ...ax }), want, JSON.stringify(ax))
  assert.deepEqual(renderOf(msg('tool_result', structuredClone(block))), want, 'a copy in another call')
})

test('inheritedRender: shell output is code without gutter, an edit or write ack is text, others inherit nothing', () => {
  assert.deepEqual(inheritedRender({ as: 'shell', f: { command: 'cmd' } }), { as: 'code' })
  for (const as of ['diff', 'code']) assert.deepEqual(inheritedRender({ as }), { as: 'text' })
  for (const as of ['kv', 'json', 'text', 'markdown']) assert.equal(inheritedRender({ as }), null)
  assert.equal(inheritedRender(null), null)
})
