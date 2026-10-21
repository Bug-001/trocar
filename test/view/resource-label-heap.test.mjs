// test/view/resource-label-heap.test.mjs — a resource the fold keeps (a link, a skill, a file a Bash command reads) holds its own
// label, never the block text it was found in (3.5 §内存有界: the spine keeps a call's lightweight meta and lets its body go; a
// label that were a regex match or a split piece of a multi-MB text or command would keep that whole text for the life of the spine).
//
// Calls folded the way a session query folds them (records built afresh, pushed, dropped), each adding one large block that names a
// distinct resource, against the same calls whose blocks name none. In a process of its own each (forced GC, single-threaded): what
// the fold holds beyond the plain run is proportional to the resources, not to the texts they were found in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const BOARD = new URL('../../src/view/board.mjs', import.meta.url).href
const HELPERS = new URL('../helpers/cc-threads.mjs', import.meta.url).href
const CALLS = 40, BIG = 1024 * 1024
const CHILD = `
const { sessionFold } = await import(${JSON.stringify(BOARD)})
const { record, replyOf, user } = await import(${JSON.stringify(HELPERS)})
const [kind, calls, big] = process.argv.slice(1).map((v, i) => i ? Number(v) : v)
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
const fill = (i) => ('filler' + i + ' ').repeat(Math.ceil(big / 8)).slice(0, big)
// the turns before call i, short (a main thread's history: what is new in call i is its last turn)
const history = (i) => Array.from({ length: i }, (_, j) => [user('turn ' + j), { role: 'assistant', content: [{ type: 'text', text: 'ok ' + j }] }]).flat()
function messages(i) {
  if (kind === 'bash' || kind === 'bash-plain') {
    const command = (kind === 'bash' ? 'cat /work/src/a-distinct-file-number-' + i + '.mjs && ' : '') + 'echo ' + fill(i)
    return [...history(i), user('go ' + i), { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_' + i, name: 'Bash', input: { command } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_' + i, content: 'ok' }] }]
  }
  const head = kind === 'link' ? 'see https://docs.example-number-' + i + '.com/a/long/page/path here\\n'
    : kind === 'skill' ? 'Base directory for this skill: /home/u/.claude/skills/a-distinct-skill-' + i + '\\n' : ''
  return [...history(i), user(head + fill(i))]
}
const make = (i) => record('r' + i, new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString(),
  { model: 'claude-opus-x', max_tokens: 1000, stream: true, metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: 'sess-threads' }) },
    tools: [{ name: 'Bash', description: 'Bash tool', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    system: [{ type: 'text', text: 'You are Claude Code, the main agent.' }], messages: messages(i) },
  replyOf('msg_' + i, [{ type: 'text', text: 'ok ' + i }]))
function fold() { const f = sessionFold('s'); for (let i = 0; i < calls; i++) f.push(make(i), 'r' + i); return f }
const before = heap()
const kept = fold()
const retained = heap() - before
const resources = (kept.view(Array.from({ length: calls }, (_, i) => 'r' + i)).analyzed.lanes || []).reduce((n, l) => n + (l.resources || []).length, 0)
console.log(JSON.stringify({ resources, retained }))`
const held = (kind) => JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--single-threaded', '--input-type=module',
  '-e', CHILD, kind, String(CALLS), String(BIG)], { encoding: 'utf8', maxBuffer: 1 << 20 }))

for (const [kind, plain] of [['link', 'plain'], ['skill', 'plain'], ['bash', 'bash-plain']]) {
  test(`a fold of calls whose large blocks each name a distinct ${kind} keeps the labels, not the blocks`, () => {
    const named = held(kind), none = held(plain)
    assert.ok(named.resources >= CALLS, `the fold found ${named.resources} resources in ${CALLS} calls (else this test proves nothing)`)
    const grew = named.retained - none.retained
    assert.ok(grew < (CALLS * BIG) / 8, `${Math.round(grew / 1048576)} MiB more held for ${CALLS} ${kind} resources found in ${BIG / 1048576} MiB blocks`)
  })
}
