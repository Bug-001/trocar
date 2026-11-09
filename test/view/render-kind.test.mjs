// test/view/render-kind.test.mjs — the render spec of a block (2.3 #16). Inputs are generated along block class × generic input keys
// × key spelling, each with a sentinel in it: whatever the rule chose, its paths must reach the sentinel on viewOf's body. Expected kinds
// come from the rule tables (wire kind → tool input keys → content sniff); r never depends on where the block sits.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderOf, viewOf, readsOf } from '../../src/view/render-kind.mjs'
import { linearContext } from '../../src/view/analyze.mjs'

const AS = new Set(['text', 'markdown', 'code', 'shell', 'diff', 'json', 'kv', 'media', 'opaque', 'parts', 'tool'])
const S = 'S3NT1NEL'
const msg = (kind, block, extra = {}) => ({ sec: 'messages', role: 'user', kind, mi: 0, bi: 0, block, ...extra })
const txt = (text) => msg('text', { type: 'text', text })
const use = (input, kind = 'tool_use') => msg(kind, { type: kind, id: 'u1', name: 'n', input }, { role: 'assistant' })
const result = (content, extra = {}) => msg('tool_result', { type: 'tool_result', tool_use_id: 'u', content, ...extra })
const asOf = (f) => renderOf(f).as
const pad = (n) => 'x'.repeat(n)
const K64 = 64 * 1024, K256 = 256 * 1024
const at = (v, p) => p.reduce((x, k) => (x == null ? x : x[k]), v)
const reaches = (v, p, why) => assert.ok(JSON.stringify(at(v, p) ?? null).includes(S), `${why}: ${JSON.stringify(p)} misses the sentinel`)

const SPELLINGS = [(k) => k, (k) => k.replace(/_(\w)/g, (_, c) => c.toUpperCase()), (k) => k.replaceAll('_', '-')]
const PROSE = [S, `# ${S}\n- a\n- b`, `{"a":"${S}"}`, `{"a":"${S}"}\n{"b":2}`, `diff --git a/x b/x\n+${S}`, `     1→${S}\n     2→b`, `<a>${S}</a>`]
const INPUTS = [
  { command: S }, { command: [S, '-la'], description: 'why' }, { cmd: S }, { q: S, n: 3 }, { q: `{"a":"${S}"}` }, { input: `*** Begin Patch\n+${S}` }, S,
  { _unparsed: `{"command":"${S}` },
  ...SPELLINGS.flatMap((k) => [{ [k('old_string')]: S, [k('new_string')]: 'b' }, { [k('file_path')]: '/p/a.txt', [k('old_string')]: 'a', [k('new_string')]: S },
    { [k('file_path')]: '/p/a.txt', content: S }, { [k('file_path')]: '/p/a.md', content: S }, { [k('notebook_path')]: `/p/${S}.ipynb` }]),
]
const BLOCKS = [
  ...PROSE.flatMap((t) => [txt(t), msg('text', t), { sec: 'system', role: 'system', kind: 'text', text: t }, msg('thinking', { type: 'thinking', thinking: t }, { role: 'assistant' }),
    result(t), result([{ type: 'text', text: t }]), result([{ type: 'text', text: t }, { type: 'text', text: 'b' }])]),
  ...INPUTS.flatMap((i) => ['tool_use', 'server_tool_use', 'mcp_tool_use'].map((k) => use(i, k))),
  result({ a: S }),
  { sec: 'tools', kind: 'tool', role: 'tool', desc: S }, { sec: 'tools', kind: 'tool', role: 'tool', schema: { type: 'object', title: S } },
  msg('tool_addition', { type: 'tool_addition', tool: { definition: { name: 'n', description: S, input_schema: {} } } }),
  msg('tool_addition', { type: 'tool_addition', tool: { definition: { name: S } } }), msg('tool_removal', { type: 'tool_removal', tool: { name: S } }),
  msg('tool_reference', { type: 'tool_reference', tool_name: S }), msg('item_reference', { type: 'item_reference', id: S }), msg('json', { type: 'json', value: { a: S } }),
  msg('image', { type: 'image', source: { type: 'base64', media_type: 'image/png', data: S } }), msg('document', { type: 'document', source: { type: 'url', url: S } }),
]

test('every generated block: r.as is in the closed set, a top-level r has f.body, and its paths reach the content on the view\'s body', () => {
  for (const flat of BLOCKS) {
    const why = JSON.stringify(flat).slice(0, 120), v = viewOf(flat)
    assert.ok(AS.has(v.r.as), `${why}: as ${v.r.as}`)
    assert.ok(Array.isArray(v.r.f.body), `${why}: f.body`)
    for (const [k, p] of Object.entries(v.r.f)) if (k !== 'body' && !['gutter', 'wrap', 'file'].includes(k)) assert.ok(Array.isArray(p), `${why}: f.${k} is a path`)
    const paths = ['cmd', 'old', 'new', 'patch', 'desc', 'schema', 'data', 'url'].map((k) => v.r.f[k]).filter(Boolean)
    if (!paths.length) reaches(v.body, v.r.f.body, why)
    else assert.ok(paths.concat([v.r.f.body]).some((p) => JSON.stringify(at(v.body, p) ?? null).includes(S)), `${why}: no path of f reaches the sentinel`)
    for (const k of ['cmd', 'old', 'new', 'patch', 'data', 'url']) if (v.r.f[k]) assert.notEqual(at(v.body, v.r.f[k]), undefined, `${why}: f.${k}`)
  }
})

test('kids are read from the child value: a child path never starts at the block', () => {
  const kv = renderOf(use({ q: `{"a":"${S}"}`, notes: `# ${S}\n- a\n- b\n- c`, plain: 'word', n: 3 }))
  assert.deepEqual(Object.keys(kv.kids).sort(), ['notes', 'q'], 'plain text children have no r')
  assert.deepEqual([kv.kids.q.as, kv.kids.notes.as], ['json', 'markdown'])
  const b = result([{ type: 'text', text: `${S}-text` }, { type: 'image', source: { media_type: 'image/png', data: S } }, 'bare'])
  const r = renderOf(b), content = viewOf(b).body.block.content
  assert.equal(r.as, 'parts')
  reaches(content[0], r.kids[0].f.body, 'text part')
  assert.equal(r.kids[1].as, 'media'); reaches(content[1], r.kids[1].f.data, 'image part')
  assert.equal(r.kids[2], undefined, 'a bare string is plain text')
})

test('layer 1: the wire kind decides first', () => {
  const rows = [
    [msg('image', { type: 'image', source: {} }), 'media'],
    [msg('document', { type: 'document', source: {} }), 'media'],
    [msg('thinking', { type: 'thinking', thinking: '', signature: 's' }, { faithfulness: 'opaque' }), 'opaque'],
    [msg('thinking', { type: 'thinking', thinking: 'seen', signature: 's' }, { faithfulness: 'opaque' }), 'opaque'],
    [msg('thinking', { type: 'thinking', thinking: '', signature: 's' }), 'opaque'],
    [msg('redacted_thinking', { type: 'redacted_thinking', data: 'd' }), 'opaque'],
    [{ sec: 'tools', kind: 'tool', role: 'tool', desc: 'plain', schema: { type: 'object' } }, 'tool'],
    [{ sec: 'tools', kind: 'tool', role: 'tool' }, 'kv'],
    [msg('tool_addition', { type: 'tool_addition', tool: { definition: { name: 'n', description: 'd', input_schema: {} } } }), 'tool'],
    [msg('tool_reference', { type: 'tool_reference', tool_name: 'n' }), 'kv'],
    [msg('item_reference', { type: 'item_reference', id: 'i' }), 'kv'],
    [msg('json', { type: 'json', value: { type: 'x' } }), 'json'],
    [result([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'parts'],
    [msg('web_search_tool_result', { type: 'web_search_tool_result', content: [{ type: 'web_search_result' }] }), 'parts'],
  ]
  for (const [f, as] of rows) assert.equal(asOf(f), as, f.kind)
})

test('thinking with plaintext reads like any human text and is quiet', () => {
  for (const [t, as] of [['plain', 'markdown'], ['{"a":1}', 'json']]) {
    const r = renderOf(msg('thinking', { type: 'thinking', thinking: t }, { role: 'assistant' }))
    assert.deepEqual([r.as, r.tone], [as, 'quiet'], t)
  }
})

test('is_error adds the error tone to whatever the content is', () => {
  for (const content of ['plain', '{"a":1}', [{ type: 'text', text: 'x' }]]) {
    assert.equal(renderOf(result(content)).tone, undefined)
    assert.deepEqual(renderOf(result(content, { is_error: true })), { ...renderOf(result(content)), tone: 'error' })
  }
})

test('a tool result: one text part reads as the string would; anything else is parts', () => {
  for (const t of ['plain', '{"a":1}', '     1→a\n     2→b']) {
    const one = renderOf(result([{ type: 'text', text: t }])), s = renderOf(result(t))
    assert.deepEqual([one.as, one.guess, one.f.gutter], [s.as, s.guess, s.f.gutter], t)
  }
  assert.equal(asOf(result([{ type: 'image', source: {} }])), 'parts')
  assert.equal(asOf(result([])), 'parts')
})

test('layer 2: tool input keys, generated over key presence, value type and key spelling', () => {
  const values = { string: 'ls -la', argv: ['ls', '-la'], object: { a: 1 } }
  for (const [vt, v] of Object.entries(values)) {
    assert.equal(asOf(use({ command: v })), vt === 'object' ? 'kv' : 'shell', `command ${vt}`)
    assert.equal(asOf(use({ cmd: v })), vt === 'string' ? 'shell' : 'kv', `cmd ${vt}`)
  }
  for (const sp of SPELLINGS) {
    const path = sp('file_path'), oldK = sp('old_string'), newK = sp('new_string')
    for (const pk of [path, 'path', null]) {
      const on = pk ? { [pk]: '/p/a.txt' } : {}
      const edit = renderOf(use({ ...on, [oldK]: 'a', [newK]: 'b' }))
      assert.equal(edit.as, 'diff')
      assert.equal(edit.title, pk ? '/p/a.txt' : undefined)
      assert.deepEqual([edit.f.old, edit.f.new], [['block', 'input', oldK], ['block', 'input', newK]], 'f names the real key')
      const write = renderOf(use({ ...on, content: 'body' }))
      assert.equal(write.as, pk ? 'code' : 'kv', `content with ${pk}`)
      if (pk) { assert.equal(write.title, '/p/a.txt'); assert.deepEqual(write.f.body, ['block', 'input', 'content']) }
      assert.equal(asOf(use({ ...on, [oldK]: 'a' })), 'kv', 'half an edit pair')
    }
    for (const ext of ['md', 'markdown', 'mdx', 'MD']) {
      const r = renderOf(use({ [path]: `/p/a.${ext}`, content: 'body' }))
      assert.deepEqual([r.as, r.title, r.f.file, r.guess], ['markdown', `/p/a.${ext}`, true, undefined])
    }
  }
  for (const p of ['*** Begin Patch\n*** Update File: a\n', 'diff --git a/x b/x\n', 'x\n@@ -1,2 +1,3 @@\n a']) {
    const r = renderOf(use({ input: p, note: 'n' }))
    assert.deepEqual([r.as, r.f.patch], ['diff', ['block', 'input', 'input']])
    assert.equal(asOf(use(p)), 'diff', 'a raw string input is sniffed')
  }
  assert.equal(asOf(use({ text: '@@ not a hunk' })), 'kv')
  const shell = renderOf(use({ command: 'x', description: 'why' }))
  assert.deepEqual([shell.f.cmd, shell.f.note], [['block', 'input', 'command'], ['block', 'input', 'description']])
  assert.equal(renderOf(use({ cmd: 'x' })).f.note, undefined)
})

test('an input that did not parse is code that wraps, whatever else the object holds', () => {
  const r = renderOf(use({ _unparsed: '{"command":"ls' }))
  assert.deepEqual([r.as, r.f.wrap, r.f.body], ['code', true, ['block', 'input', '_unparsed']])
  assert.equal(r.kids, undefined)
})

test('layer 3: JSON only when whole, ≤ 256 KB and led by { or [; never a guess', () => {
  const big = (n) => '{"a":"' + pad(n - 8) + '"}'
  for (const ws of ['', '  \n\t']) {
    assert.equal(asOf(txt(ws + '{"a":[1,2]}')), 'json', `lead ${JSON.stringify(ws)}`)
    assert.equal(asOf(txt(ws + '[1,2]')), 'json')
  }
  assert.equal(big(K256).length, K256)
  assert.equal(asOf(txt(big(K256))), 'json')
  assert.equal(asOf(txt(big(K256 + 1))), 'markdown')
  assert.equal(asOf(result(big(K256 + 1))), 'text')
  assert.equal(asOf(txt('{"a":1} trailing')), 'markdown')
  assert.equal(asOf(txt('"a"')), 'markdown')
  assert.equal(renderOf(txt('[1]')).guess, undefined)
})

test('layer 3: a value per line is code that wraps, judged on the first 64 KB', () => {
  for (const eol of ['\n', '\n\n', '\r\n']) {
    const r = renderOf(txt(['{"a":1}', '[2]', '{"b":{}}'].join(eol)))
    assert.deepEqual([r.as, r.f.wrap, r.guess], ['code', true, true], JSON.stringify(eol))
  }
  assert.equal(asOf(txt('{"a":1}\nprose\n{"b":2}')), 'markdown')
  assert.equal(asOf(txt('1\n2\n3')), 'markdown', 'a column of numbers is no record stream')
  const row = `{"a":"${pad(1000)}"}\n`, long = row.repeat(100)
  assert.ok(long.length > K64 && long.length < K256)
  assert.equal(asOf(txt(long)), 'code', 'the line the head cuts is not judged')
  assert.equal(asOf(txt(long.slice(0, K64 - row.length * 2) + 'prose\n' + long)), 'markdown')
  assert.equal(asOf(txt(row.repeat(70) + 'prose after the head\n')), 'code', 'only the head counts')
})

test('layer 3: patch markers count only inside the first 64 KB; a patch is never a guess', () => {
  const marker = '\ndiff --git a/x b/x\n'
  assert.equal(asOf(result(pad(K64 - marker.length) + marker)), 'diff')
  assert.equal(asOf(result(pad(K64) + marker)), 'text')
  assert.equal(renderOf(txt('diff --git a/x b/x\n')).guess, undefined)
})

test('layer 3: line numbers on ≥ 80 % of the first 50 lines make gutter code', () => {
  for (const sep of ['→', '\t']) {
    const lines = (k, n = 50) => Array.from({ length: n }, (_, i) => (i < k ? `${String(i + 1).padStart(6)}${sep}line` : 'plain line')).join('\n')
    const r = renderOf(result(lines(40)))
    assert.deepEqual([r.as, r.f.gutter, r.guess], ['code', true, true])
    assert.equal(asOf(result(lines(39))), 'text')
    assert.equal(asOf(result(lines(40, 50) + '\n' + Array(200).fill('plain').join('\n'))), 'code', 'only the first 50 lines count')
  }
})

test('layer 3: human text defaults to markdown; a tool result needs three markdown or tag lines, else text', () => {
  for (const flat of [txt('plain'), msg('text', 'plain'), { sec: 'system', text: 'plain' }]) assert.deepEqual([asOf(flat), renderOf(flat).guess], ['markdown', true])
  for (const mk of ['# h', '- i', '* i', '1. i', '```', '> q', '| a | b |', '<tag>', '<tag a="1">', '<k>value</k>']) {
    assert.equal(asOf(result(Array(3).fill(mk).join('\nplain\n'))), 'markdown', mk)
    assert.equal(asOf(result(Array(2).fill(mk).join('\nplain\n'))), 'text', mk)
  }
  for (const line of ['Foo<T>', 'inline <b>bold</b> word', '<a>x</b>']) assert.equal(asOf(result(Array(5).fill(line).join('\n'))), 'text', line)
  assert.equal(renderOf(result('plain')).guess, true)
})

test('media: the paths that exist, and only those', () => {
  const b = (source) => renderOf(msg('image', { type: 'image', source })).f
  assert.deepEqual(b({ type: 'base64', media_type: 'image/png', data: 'x' }), { body: ['block'], data: ['block', 'source', 'data'], mime: ['block', 'source', 'media_type'] })
  assert.deepEqual(b({ type: 'url', url: 'https://x/y.png' }), { body: ['block'], url: ['block', 'source', 'url'] })
})

test('a tool definition: description and schema are paths; one with neither reads its own definition', () => {
  const r = renderOf({ sec: 'tools', desc: 'd', schema: {} })
  assert.deepEqual(r, { as: 'tool', f: { body: [], desc: ['desc'], schema: ['schema'] } })
  const add = renderOf(msg('tool_addition', { type: 'tool_addition', tool: { definition: { description: 'd', input_schema: {} } } }))
  assert.deepEqual([add.as, add.f.desc, add.f.schema], ['tool', ['block', 'tool', 'definition', 'description'], ['block', 'tool', 'definition', 'input_schema']])
  const server = { sec: 'tools', kind: 'tool', role: 'tool', verbatim: true }
  assert.equal(viewOf(server), null, 'no body: the definition is not at hand')
  Object.defineProperty(server, 'src', { value: { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }, enumerable: false })
  const v = viewOf(server)
  assert.equal(v.r.as, 'kv')
  assert.equal(at(v.body, v.r.f.body).max_uses, 5)
})

test('verbatim: a server tool\'s few fields are its whole definition; the old counts are metadata only', () => {
  const [server, old] = linearContext({ messages: [], system: [], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }, { name: 'Old', input_schema_props: ['a'], description_chars: 9 }] })
  assert.equal(server.verbatim, true)
  assert.equal(old.verbatim, false)
  assert.equal(viewOf(old), null, 'metadata only is read Raw')
  assert.equal(viewOf(server).body.schema.max_uses, 5)
})

test('viewOf: the body is the block\'s body keys and nothing of its place', () => {
  assert.equal(viewOf(msg('text', undefined)), null)
  assert.equal(viewOf(null), null)
  assert.deepEqual(Object.keys(viewOf({ ...txt('a'), cc: {}, key: 'k', label: 'l' }).body), ['block'])
})

test('readsOf: a shell call reads as code, a path call on a Markdown file as markdown, a call that carries its content as nothing', () => {
  const call = (input, type = 'tool_use') => ({ type, id: 'u', name: 'n', input })
  assert.equal(readsOf(call({ command: 'ls' })), 'code')
  assert.equal(readsOf(call({ cmd: 'ls' }, 'server_tool_use')), 'code')
  for (const sp of SPELLINGS) {
    for (const ext of ['md', 'markdown', 'mdx']) assert.equal(readsOf(call({ [sp('file_path')]: `/a.${ext}` })), 'markdown', ext)
    assert.equal(readsOf(call({ [sp('file_path')]: '/a.txt' })), undefined)
    assert.equal(readsOf(call({ [sp('file_path')]: '/a.md', [sp('old_string')]: 'a', [sp('new_string')]: 'b' })), undefined, 'an edit')
    assert.equal(readsOf(call({ [sp('file_path')]: '/a.md', content: 'body' })), undefined, 'a write')
  }
  for (const b of [{ type: 'text', text: 'x' }, { type: 'tool_result', content: 'x' }, null, 'x']) assert.equal(readsOf(b), undefined)
})

test('r does not depend on where the block sits or what surrounds it', () => {
  const block = { type: 'tool_result', tool_use_id: 'u', content: '<x>\n- a\n- b\n- c\n</x>' }
  const base = msg('tool_result', block)
  const want = renderOf(base)
  const axes = [{ mi: 7 }, { bi: 3 }, { si: 2 }, { role: 'tool' }, { cc: { type: 'ephemeral' } }, { key: 'M:other' }, { resKey: 'file::/a' },
    { toolName: 'other' }, { call: 'c2', path: ['input', 9] }]
  for (const ax of axes) assert.deepEqual(renderOf({ ...base, ...ax }), want, JSON.stringify(ax))
  assert.deepEqual(renderOf(msg('tool_result', structuredClone(block))), want, 'a copy in another call')
})
