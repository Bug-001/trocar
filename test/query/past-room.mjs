// test/query/past-room.mjs — a session past a small reader's room for its spine (RFC 3.5 §内存有界), grown and extracted in a
// process with a large heap: growing and extracting it is not what the cut tests measure, and a reader with a heap that small
// would spend minutes extracting it a 50 ms slice at a time. Nothing is reduced while it grows; the reader reduces it cold.
//
// The room is what the plan reckons (src/query/named/session.mjs fitting): the reader's budget less the work, the steady caches and
// the distinct blocks (SPINE_PER_BLOCK each), each counted in whole steps of a tenth of the budget. The blocks are the projection's
// `d` lines, so the session is extracted as it grows (as the worker extracts it) and they are counted as they are written.
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { heapFlags } from '../../src/query/warm.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)

/** A reader with a heap of `heapMb`, started as the service starts the worker (heapFlags), stands in for the worker. */
export const readerFlags = (heapMb) => ['--require', NO_REAL_OS, '--expose-gc', ...heapFlags(heapMb)]

const BUDGET = `const { heapBudget } = await import(${at('../../src/query/warm.mjs')}); console.log(heapBudget())`
/** growPast(s, {home, budget}) → grows the bigSession `s` (test/query/big-session.mjs, writing into `home`) 500 calls at a time,
 *  extracting it as the worker does, until it holds a quarter more rows than a reader whose heap budget is `budget` has room for,
 *  each at SPINE_PER_ROW. In-process: the query modules' caches of this process hold the session. */
export async function growPast(s, { home, budget }) {
  const fs = await import('node:fs')
  await import('../../src/query/named/index.mjs') // first: the registry imports session.mjs
  const { SPINE_PER_ROW, SPINE_PER_BLOCK, working, extendSession } = await import('../../src/query/named/session.mjs')
  const { steadyBytes } = await import('../../src/query/warm.mjs')
  const { projectionFile } = await import('../../src/query/projection.mjs')
  const { indexRows, sessionGroups } = await import('../../src/query/rows.mjs')
  const step = budget / 10
  const room = (rows, blocks) => budget - working(rows) - Math.ceil(steadyBytes() / step) * step - Math.ceil(blocks * SPINE_PER_BLOCK / step) * step
  // the projection's definition lines, counted over the bytes appended since the last count
  let blocks = 0, read = 0, tail = ''
  const count = () => {
    const fd = fs.openSync(projectionFile(home, s.id), 'r'), size = fs.fstatSync(fd).size, b = Buffer.alloc(size - read)
    fs.readSync(fd, b, 0, b.length, read); fs.closeSync(fd); read = size
    const lines = (tail + b.toString('latin1')).split('\n'); tail = lines.pop()
    for (const l of lines) if (l.startsWith('{"d":')) blocks++
  }
  for (let rows = []; rows.length * SPINE_PER_ROW <= 1.25 * room(rows, blocks);) {
    s.append(500)
    while (await extendSession({ home, writer: true }, s.id, Infinity));
    rows = sessionGroups(await indexRows({ home, errors: [] })).get(s.id); count()
  }
}
const GROW = `
const { bigSession } = await import(${at('./big-session.mjs')})
const { growPast } = await import(${at('./past-room.mjs')})
const [home, shape, budget] = [process.argv[1], JSON.parse(process.argv[2]), Number(process.argv[3])]
const s = bigSession({ home, ...shape })
await growPast(s, { home, budget })
console.log(JSON.stringify({ id: s.id }))
// one call more for each line read (grower)
for await (const _ of (await import('node:readline')).createInterface({ input: process.stdin })) { s.append(1); console.log('{}') }`

/** readerBudget(heapMb) → the heap budget of a reader of readerFlags(heapMb). */
export const readerBudget = (heapMb) => Number(execFileSync(process.execPath, [...readerFlags(heapMb), '--input-type=module', '-e', BUDGET], { encoding: 'utf8' }))
// a process of its own, with a large heap: the steady caches it reckons the room with hold this home's index rows only
const growArgs = ({ home, shape, heapMb }) => ['--require', NO_REAL_OS, ...heapFlags(2048), '--input-type=module', '-e', GROW, home, JSON.stringify(shape), String(readerBudget(heapMb))]
/** pastRoom({home, shape, heapMb}) → the id of a bigSession of `shape` in `home`, grown past the room of a reader of
 *  readerFlags(heapMb) (growPast). */
export const pastRoom = (o) => JSON.parse(execFileSync(process.execPath, growArgs(o), { encoding: 'utf8', input: '', maxBuffer: 1 << 20 })).id
/** grower(o) → {id, more(), stop()}: pastRoom's session, in a process kept to grow it one call at a time (`more()`). */
export async function grower(o) {
  const p = spawn(process.execPath, growArgs(o), { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: p.stdout })[Symbol.asyncIterator]()
  const line = async () => { const { value, done } = await lines.next(); if (done) throw new Error('the grower ended'); return JSON.parse(value) }
  try {
    const { id } = await line()
    return { id, more: () => { p.stdin.write('\n'); return line() }, stop: () => { p.stdin.end(); p.kill() } }
  } catch (e) { p.kill(); throw e }
}
