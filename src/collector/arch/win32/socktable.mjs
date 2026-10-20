// socktable.mjs — which process owns the connection the engine just accepted, read from the socket itself at accept time (RFC 4.9 §5.3, D47; the win32 twin
// of the darwin socktable, the backend the shared door core asks).
//
// The agent connects to the engine's own listener (there is no kernel between them any more), so the engine's peer 4-tuple IS the agent's outbound socket:
// the one question that answers its owner is a TARGETED read of the TCP owner table filtered to that local end — the resident helper's `tcp-table` verb,
// GetExtendedTcpTable through raw P/Invoke (E6: no CIM, no Get-NetTCPConnection, no elevation, ~5 ms measured), asked as
// `{ localPort: <peer port>, states: ['established'] }` so the helper answers only the rows that can be the agent's socket. A row whose LOCAL end is the
// peer address:port is the agent's own socket; the engine's accepted socket of the same connection shows the peer as its REMOTE end and never matches the
// local-end filter (and the engine's own pid is excluded beside that, belt and braces). Rows with pid 0 are left out (Windows gives a TIME_WAIT row no
// owner, it is the end of a connection and no process is connecting).
//
// A wrong pid must never happen (4.8 W4): it would make the engine decrypt a process that does not trust trocar's CA and break it, so no row, several rows
// (the pid was reused mid-query, or a twin of the socket), a slow table or an unreadable one all give null, and the connection is judged untracked and
// spliced. There is no candidates set, no `known` table, no debounce and no demand poll (that machinery went with the kernel): the peer process is alive
// by definition — it just connected — so one query per connection is the whole cost. `budgetMs` stays generous (250 ms): a table that is not back inside
// it is SLOW, not unavailable — null with the cost said, and no failure record; a table that cannot be read at all gives null and ONE
// `socktable-unavailable` record (4.8 §12) to `onFailure`, which the recorder folds. A helper the daemon closed itself (`helper-closed`: a lookup in
// flight when `off` or a stop closed it) is null and no record: an operator's close is not a failure.
// The budget is the TABLE's: it counts from the moment the single-threaded helper is on this read (helper.mjs `onStart`), not from the ask. A read
// queued behind a `ps` the helper is still working on waits for it (at most `waitMs`, then `helper-busy`: null, no record) instead of being spliced
// for a slowness that is not its own (a burst of connections after a cold ps was spliced one by one).
import { HELPER_WAIT_MS } from './helper.mjs'

const OVER = Symbol('over budget')

/** ownerOfSocket({ helper, peer: {address, port}, budgetMs = 250, waitMs, now, onFailure }) → { pid, source, ms }
 *  `peer` is the accepted socket's remote end as the engine sees it ({address, port} — `socket.remoteAddress` / `remotePort`): the AGENT's socket local
 *  end. `helper` is the resident read-only helper's client (helper.mjs), whose `tcp-table` verb is the GetExtendedTcpTable read above. source =
 *  'socket-table' when a pid is answered, null with the pid. `ms` is what the question cost. A peer address that is not an IPv4 literal is answered null
 *  at once (the engine's doors bind 127.0.0.1 only, D47: an IPv6 peer cannot be one of the agents' entries — a fail-safe null, never a guess). */
export async function ownerOfSocket({ helper, peer, budgetMs = 250, waitMs = HELPER_WAIT_MS, now = Date.now, onFailure = () => {} }) {
  if (!helper || typeof helper.call !== 'function') throw new TypeError('ownerOfSocket needs the helper client (helper.mjs)')
  if (!peer || !Number.isInteger(peer.port)) throw new TypeError('ownerOfSocket: peer.port is required')
  const t0 = now()
  const none = (ms = now() - t0) => ({ pid: null, source: null, ms: Math.max(0, ms) })
  const addr = String((peer && peer.address) || '')
  if (addr === '' || addr.includes(':')) return none(0) // not an IPv4 loopback peer: the doors never see one (the fail-safe answer)

  let timer, overNow
  const over = new Promise((resolve) => { overNow = () => resolve(OVER) })
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(overNow, ms); if (timer.unref) timer.unref() }
  arm(waitMs + budgetMs) // until the helper says it is on this read; a helper that never says so gets the whole wait at most
  const asked = helper.call('tcp-table', { localPort: peer.port, states: ['established'] }, { timeoutMs: budgetMs, waitMs, onStart: () => arm(budgetMs) })
  asked.catch(() => {}) // when the budget wins, the table's own failure or late answer is nobody's to handle
  let answer
  try { answer = await Promise.race([asked, over]) } catch (e) {
    if (e && (e.code === 'helper-timeout' || e.code === 'helper-busy')) answer = OVER // slow (its own read, or the helper busy before it): not unavailable
    else if (e && e.code === 'helper-closed') return none() // the daemon stopped its own helper (off, stop): not an unreadable table, nothing to record
    else return unavailable(e && e.message ? e.message : String(e))
  } finally { clearTimeout(timer) }
  if (answer === OVER) return none(Math.max(budgetMs, now() - t0))
  if (!answer || !Array.isArray(answer.rows)) return unavailable('the helper\'s answer has no rows')

  const holders = new Set()
  for (const row of answer.rows) {
    if (row && row.pid !== 0 && Number.isInteger(row.pid) && row.localPort === peer.port && row.localAddr === addr) holders.add(row.pid)
  }
  const mine = [...holders].filter((p) => p !== process.pid) // the engine's accepted socket names the peer as its REMOTE end and is not in `holders`; the pid exclusion is belt and braces
  return mine.length === 1 ? { pid: mine[0], source: 'socket-table', ms: Math.max(0, now() - t0) } : none()

  function unavailable(why) {
    onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the TCP owner table could not be read (${why}); the connection's owner is not worked out, it is spliced untracked` })
    return none()
  }
}
