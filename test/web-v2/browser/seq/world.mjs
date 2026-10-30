// test/web-v2/browser/seq/world.mjs — the world the sequence harness drives: a temp trocar home holding the demo session and four
// generated sessions shaped like real ones (Claude Code over http with subagents running side by side, late lines, a compaction,
// huge tool results, images and failed calls; Claude Code on Message Threads; Codex over WebSocket; dsh over Chat Completions), all
// four appending to ONE segment — the live one — so grow() is what the daemon does between two of the reader's steps.
// mainCount() reads the cross-layer truth (the main lane's call count) off the real server's `session` document.
// Exports only: node --test runs every .mjs, so nothing here runs at import. No CJK in what it writes (bigSession's syllables).
import { boardHome } from '../../real-face.mjs'
import { bigSession } from '../../../query/big-session.mjs'

export const LIVE_SEGMENT = '20261020T164737Z'
const HUGE = 30_000
// Claude Code's requests carry their tool definitions (a call with ≤ 2 messages and none reads as a utility call, not the main lane)
const TOOLS = ['Read', 'Edit', 'Bash'].map((name) => ({ name, description: `${name} a file or run a command.`, input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }))

/** The session id of wire `w` in world `seed` (uuid-shaped, distinct per wire and seed). */
const idOf = (seed, k) => `5e9${String(seed).padStart(5, '0').slice(-5)}-0000-4a1b-9c2d-${String(k + 1).padStart(12, '0')}`

/**
 * makeWorld({seed, big}) → { userHome, home, sessions:[{id, wire}], live:[id], hugeBytes, grow(k), late(k), fresh(n) }.
 * Tens of calls per session by default (a cold fold stays fast); `big` grows the http session to hundreds of calls / several MB.
 * grow(k) appends the next k calls of every live session → { calls, main, by: {id: {calls, main}} }, `main` = the main-lane calls among
 * them, counted by the generator. late(k) grows only the sessions whose subagent calls end late, by k calls past their late bound,
 * so the lines held back land before the tip (late rows, relanes). fresh(n) starts one more session (never read yet) in the live
 * segment with n calls → its id; grow() grows it from then on.
 */
export function makeWorld({ seed = 1, big = false } = {}) {
  const { userHome, home } = boardHome()
  const base = { home, segment: LIVE_SEGMENT, growth: 1_200, tools: TOOLS }
  const specs = [
    { wire: 'http', subEvery: 3, subLanes: 3, late: 3, compactAt: big ? 80_000 : 50_000, hugeEvery: 7, hugeBytes: HUGE, imageEvery: 5, failEvery: 6, n: big ? 300 : 40 },
    { wire: 'threads', subEvery: 4, compactAt: 25_000, n: 24 },
    { wire: 'ws', subEvery: 4, compactAt: 25_000, n: 24 },
    { wire: 'chat', subEvery: 4, failEvery: 9, n: 24 },
  ]
  const start = ({ n, ...o }, k) => {
    const w = bigSession({ ...base, ...o, id: idOf(seed, k), seed: seed * 101 + k * 7 })
    w.append(n)
    return Object.assign(w, { late: o.late || 0 })
  }
  const writers = specs.map(start)
  const sessions = writers.map((w, k) => ({ id: w.id, wire: specs[k].wire }))
  const live = sessions.map((s) => s.id)
  const growOf = (list, k) => {
    const by = {}
    let calls = 0, main = 0
    for (const w of list) {
      const c0 = w.calls, m0 = w.mains
      w.append(k)
      by[w.id] = { calls: w.calls - c0, main: w.mains - m0 }
      calls += by[w.id].calls; main += by[w.id].main
    }
    return { calls, main, by }
  }
  return {
    userHome, home, sessions, live, hugeBytes: HUGE,
    grow: (k = 1) => growOf(writers, k),
    late: (k = 1) => growOf(writers.filter((w) => w.late), k + Math.max(...writers.map((w) => w.late))),
    fresh(n = 12) {
      const w = start({ ...specs[0], n }, writers.length)
      writers.push(w); sessions.push({ id: w.id, wire: specs[0].wire }); live.push(w.id)
      return w.id
    },
  }
}

/** The `session` answer of `id` once the reduction has caught up (no `pending`, 3.5 §会话读 #25); throws past `ms`. */
export async function settled(get, id, ms = 20_000) {
  for (const t0 = Date.now(); ;) {
    const { status, doc } = await get('session', { id })
    if (status !== 200 || !Array.isArray(doc?.lanes)) throw new Error(`session ${id}: ${status} ${String(doc?.error ?? "").slice(0, 400)}`)
    if (!doc.pending) return doc
    if (Date.now() - t0 > ms) throw new Error(`session ${id}: still pending ${JSON.stringify(doc.pending)} after ${ms} ms`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** The main lane's call count of session `id`: its lane header's `count` in a settled `session` answer (3.5 §会话读 车道头). */
export async function mainCount(get, id) {
  const doc = await settled(get, id)
  return (doc.lanes.find((l) => l.kind === 'main') || doc.lanes[0])?.count ?? 0
}
