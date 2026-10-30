// test/query/past-room.mjs — a session past a small reader's heap budget for real (RFC 3.5 §内存有界「截断只是兜底,按实测的堆截」),
// grown and extracted in a process of its own: growing and extracting it is not what the cut tests measure, and a reader with a heap
// that small would spend minutes extracting it a 50 ms slice at a time. It is extracted as it grows, never folded: the reader folds
// it from scratch and is cut by what its fold measures.
//
// Past the budget for real: every call of the shape uses a tool no call before it did, its name `names` characters long, which the
// fold's tool map keeps for as long as the fold lives (test/query/big-session.mjs), so a fold of N calls holds at least N × names
// bytes; the session is grown until that is twice the reader's budget.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { heapFlags } from '../../src/query/warm.mjs'
import { TICK, child } from '../helpers/ticking.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)

/** A reader with a heap of `heapMb`, started as the service starts the worker (heapFlags), stands in for the worker. */
export const readerFlags = (heapMb) => ['--require', NO_REAL_OS, '--expose-gc', ...heapFlags(heapMb)]

const BUDGET = `const { heapBudget } = await import(${at('../../src/query/warm.mjs')}); console.log(heapBudget())`
/** growPast(s, {home, budget, names, tick}) → grows the bigSession `s` (test/query/big-session.mjs, writing into `home`, its calls
 *  each keeping `names` bytes in a fold) 500 calls at a time, extracting it as the worker's background does, until a fold of it holds
 *  twice `budget`; `tick()` as it goes. In-process: the query modules' caches of this process hold the session. */
export async function growPast(s, { home, budget, names, tick = () => {} }) {
  if (!(names > 0)) throw new Error('growPast: a shape whose calls are dear for real (names > 0)')
  const { openProjection } = await import('../../src/query/projection.mjs')
  const { extractMembers } = await import('../../src/view/extract.mjs')
  const { recordsAt } = await import('../../src/query/records.mjs')
  const { indexRows, sessionGroups } = await import('../../src/query/rows.mjs')
  const store = openProjection({ home, key: s.id, write: true, errors: [] })
  try {
    for (let calls = 0; calls * names <= 2 * budget;) {
      s.append(500); tick()
      const members = sessionGroups(await indexRows({ home, errors: [] })).get(s.id)
      if (!(members && members.length > calls)) throw new Error(`growPast: 500 calls appended and the session's members did not grow (${calls})`)
      calls = members.length
      tick()
      extractMembers({ store, members, sessionId: s.id, recordsAt: (rs) => { tick(); return recordsAt({ home, rows: rs.filter(Boolean), errors: [], remember: false }) } })
    }
  } finally { store.close() }
}
const GROW = `${TICK}
const { bigSession } = await import(${at('./big-session.mjs')})
const { growPast } = await import(${at('./past-room.mjs')})
const [home, shape, budget] = [process.argv[1], JSON.parse(process.argv[2]), Number(process.argv[3])]
const s = bigSession({ home, ...shape })
await growPast(s, { home, budget, names: shape.names, tick })
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
/** grower(o) → {id, more(), stop()}: pastRoom's session, in a process kept to grow it one call at a time (`more()`), each wait on it
 *  lasting while it makes progress (test/helpers/ticking.mjs). `stop()` waits until it is gone. */
export async function grower(o) {
  const p = child(growArgs(o), 'the session grown past the room')
  try {
    const { id } = await p.next()
    return { id, more: () => { p.send(''); return p.next() }, stop: () => p.stop() }
  } catch (e) { await p.stop(); throw e }
}
