// test/dissect/cc-threads-heap.test.mjs — a Message Threads planner holds locators for what each call resends, not a copy of it
// per call (src/dissect/chain.mjs: a session's chains cost locators, not stored bytes; 3.5 §内存有界). Claude Code resends its
// system and tools with every call of a thread; a plan keeps its context's system and tools items (a continuation inherits them),
// so items that are the same bytes in every call must be held once, not once per call.
//
// One chain of calls, each resending the same tool definitions (and a fresh billing block), planned the way the board's assembler
// folds a session (one record at a time, records read back by id, never held), with short and with long tool descriptions. In a
// process of its own each (forced GC, single-threaded so no concurrent compile job holds a frame): what the planner still holds
// once the records are gone grows with the calls' locators, not with the size of what they resend.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const THREADS = new URL('../../src/dissect/cc-threads.mjs', import.meta.url).href
const HELPERS = new URL('../helpers/cc-threads.mjs', import.meta.url).href
const CALLS = 200, TOOLS = 40
const CHILD = `
const { CC_THREADS } = await import(${JSON.stringify(THREADS)})
const { record, replyOf, user } = await import(${JSON.stringify(HELPERS)})
const [calls, tools, desc] = process.argv.slice(1).map(Number)
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
const toolDefs = () => Array.from({ length: tools }, (_, i) => ({ name: 'tool_' + i, description: 'd'.repeat(desc) + i,
  input_schema: { type: 'object', properties: { path: { type: 'string', description: 'where' } } } }))
// call i: built afresh whenever it is asked for (a record read back by id is a new object, as from disk)
const make = (i) => record('c' + i, new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString(), {
  model: 'claude-opus-x', thread: i ? { type: 'continue', previous_message_id: 'msg_' + (i - 1) } : { type: 'create' }, stream: true,
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=' + i + ';' }, { type: 'text', text: 'You are Claude Code.' }],
  tools: toolDefs(), messages: [user('turn ' + i)] }, replyOf('msg_' + i, [{ type: 'text', text: 'ok ' + i }]))
const read = function* (ids) { for (const id of ids) yield make(Number(String(id).slice(1))) }
function plan() { const p = CC_THREADS.prepare(read); for (let i = 0; i < calls; i++) { const c = p.context(make(i)); if (!c || c.req.tools.length !== tools) throw new Error('no context') } return p }
const before = heap()
const kept = plan()
const retained = heap() - before
console.log(JSON.stringify({ kept: typeof kept.get, retained }))`
const held = (desc) => JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--single-threaded', '--input-type=module',
  '-e', CHILD, String(CALLS), String(TOOLS), String(desc)], { encoding: 'utf8', maxBuffer: 1 << 20 }))

test('a thread planner holds the system and tools every call resends once, not once per call', () => {
  const short = held(100), long = held(10_000)
  assert.equal(long.kept, 'function')
  const grew = long.retained - short.retained, perCall = CALLS * TOOLS * (10_000 - 100)
  assert.ok(grew < perCall / 10, `${Math.round(grew / 1048576)} MiB more held for ${CALLS} calls whose tools are ${Math.round(perCall / CALLS / 1024)} KiB longer each`)
})
