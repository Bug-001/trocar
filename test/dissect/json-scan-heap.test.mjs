// test/dissect/json-scan-heap.test.mjs — a scan tree never holds the text it was scanned from alive: what it keeps once the text is
// dropped is proportional to its keys and nodes, not to the text (3.5 §内存有界: the fold keeps per-row scans and locators of
// multi-MB request bodies; a key that were a slice of its body would keep the whole body).
//
// Each case in a process of its own (forced GC before and after), so nothing another case left behind is counted or freed in it;
// single-threaded, so no concurrent compile job of the hot scanner still holds a handle to its closures (and their text) when measured.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const SCAN = new URL('../../src/dissect/json-scan.mjs', import.meta.url).href
const BIG = 20 * 1024 * 1024
// keys of every length around V8's sliced-string threshold (13), repeated, escaped and not, beside one long string value
const CHILD = `
const { scanJson, pruned } = await import(${JSON.stringify(SCAN)})
const [keep, big] = process.argv.slice(1)
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
function body() {
  const items = []
  for (let i = 0; i < 400; i++) items.push({ cache_control: { type: 'ephemeral' }, tool_use_id: 't' + i, input_schema_definition: i,
    ['k\\\\ey_with_escape_' + (i % 7)]: null, ['distinct_key_number_' + i]: [i] })
  return JSON.stringify({ system: 'x'.repeat(Number(big)), messages: items })
}
// in a frame of its own that has returned, so no interpreter register still holds the text
function scan() { const tree = scanJson(body()); return keep === 'tree' ? tree : pruned(tree, 3) }
const before = heap()
const kept = scan()
const retained = heap() - before
console.log(JSON.stringify({ keys: kept.props.get('messages').items.length && [...(kept.props.get('messages').items[0].props.keys())].length, retained }))`

for (const keep of ['tree', 'pruned']) {
  test(`a ${keep} scan kept after its text is dropped retains heap for its keys and nodes, not for the text`, () => {
    const out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--single-threaded', '--input-type=module', '-e', CHILD, keep, String(BIG)],
      { encoding: 'utf8' }))
    assert.equal(out.keys, 5)
    assert.ok(out.retained < BIG / 8, `${Math.round(out.retained / 1048576)} MiB retained by a scan of a ${BIG / 1048576} MiB text`)
  })
}

// Keys are not only the short repeated names of the API: a tool's input or schema may carry any key, of any length. What a scan keeps
// of them once every text and tree is dropped is not proportional to their bytes (a table of copied keys that outlives the scans
// would hold them for the life of the process, outside the heap budget's accounting).
const LONG = `
const { scanJson } = await import(${JSON.stringify(SCAN)})
const [bodies, keys, len] = process.argv.slice(1).map(Number)
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
function scanOne(b) {
  const o = {}
  for (let k = 0; k < keys; k++) o[String(b * keys + k).padStart(len, 'k')] = k
  return scanJson(JSON.stringify({ input: o })).props.get('input').props.size
}
const before = heap()
let seen = 0
for (let b = 0; b < bodies; b++) seen += scanOne(b)
console.log(JSON.stringify({ seen, retained: heap() - before }))`

test('scans of bodies with long distinct keys, all dropped, retain heap that is small beside the keys bytes', () => {
  const bodies = 4, keys = 256, len = 64 * 1024
  const out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--single-threaded', '--input-type=module', '-e', LONG,
    String(bodies), String(keys), String(len)], { encoding: 'utf8' }))
  assert.equal(out.seen, bodies * keys)
  const bytes = bodies * keys * len
  assert.ok(out.retained < bytes / 8, `${Math.round(out.retained / 1048576)} MiB retained after scans of ${bytes / 1048576} MiB of keys were dropped`)
})
