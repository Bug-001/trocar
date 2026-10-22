// test/query/past-room.mjs — a session past a small reader's room for its spine (RFC 3.5 §内存有界), grown and extracted in a
// process of its own with a large heap: growing and extracting it is not what the cut tests measure, and a reader with a heap that
// small would spend minutes extracting it a 50 ms slice at a time.
//
// The room is what the plan reckons (src/query/named/session.mjs fitting): the reader's budget less the work, the steady caches and
// the distinct blocks (SPINE_PER_BLOCK each), each counted in whole steps of a tenth of the budget. The blocks are the projection's
// `d` lines, so the session is extracted as it grows (as the worker extracts it) and they are counted as they are written.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)

/** A reader with an old space of `heapMb` stands in for the worker (src/query/warm.mjs heapBudget: two thirds of the smaller of V8's
 *  heap limit and the worker's old space). V8's limit is the old space and the young generation (48 MB by default), so a small old
 *  space gets a small young generation, else its budget is reckoned on more heap than its old space holds. */
export const readerFlags = (heapMb) => ['--require', NO_REAL_OS, '--expose-gc', `--max-old-space-size=${heapMb}`, '--max-semi-space-size=1']

const BUDGET = `const { heapBudget } = await import(${at('../../src/query/warm.mjs')}); console.log(heapBudget())`
/** growPast(s, {home, budget, dear}) → grows the bigSession `s` (test/query/big-session.mjs, writing into `home`) 500 calls at a
 *  time, extracting it as the worker does, until it holds half again as many rows as a reader whose heap budget is `budget` has
 *  room for, each at SPINE_PER_ROW × `dear`. In-process: the query modules' caches of this process hold the session. */
export async function growPast(s, { home, budget, dear = 1 }) {
  const fs = await import('node:fs')
  const { runQuery } = await import('../../src/query/named/index.mjs') // first: the registry imports session.mjs
  const { SPINE_PER_ROW, SPINE_PER_BLOCK, working } = await import('../../src/query/named/session.mjs')
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
  for (let rows = []; rows.length * SPINE_PER_ROW * dear <= 1.5 * room(rows, blocks);) {
    s.append(500)
    let doc
    do doc = await runQuery('session', { id: s.id, limit: '1' }, { home, writer: true }); while (doc.pending)
    rows = sessionGroups(await indexRows({ home, errors: [] })).get(s.id); count()
  }
}
const GROW = `
const { bigSession } = await import(${at('./big-session.mjs')})
const { growPast } = await import(${at('./past-room.mjs')})
const [home, shape, dear, budget] = [process.argv[1], JSON.parse(process.argv[2]), Number(process.argv[3]), Number(process.argv[4])]
const s = bigSession({ home, ...shape })
await growPast(s, { home, budget, dear })
console.log(JSON.stringify({ id: s.id }))`

/** readerBudget(heapMb) → the heap budget of a reader of readerFlags(heapMb). */
export const readerBudget = (heapMb) => Number(execFileSync(process.execPath, [...readerFlags(heapMb), '--input-type=module', '-e', BUDGET], { encoding: 'utf8' }))
/** pastRoom({home, shape, dear, heapMb}) → the id of a bigSession of `shape` in `home`, grown past the room of a reader of
 *  readerFlags(heapMb) (growPast), in a process of its own with a large heap. */
export function pastRoom({ home, shape, dear = 1, heapMb }) {
  return JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--max-old-space-size=2048', '--input-type=module', '-e', GROW, home, JSON.stringify(shape), String(dear), String(readerBudget(heapMb))],
    { encoding: 'utf8', maxBuffer: 1 << 20 })).id
}
