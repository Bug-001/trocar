// socktable.mjs — which process of a form owns the connection that just reached the hop (RFC 4.8 §5.3, W4).
//
// On Windows the engine's peer is the VPN (or the own forwarder), not the agent, so the owner pid is worked out from the TCP owner table
// the helper reads (GetExtendedTcpTable: no CIM, no elevation, ~5 ms [E6]): of the processes the form can have, the ones that hold a
// connection (any state, any age) whose remote port is the hop's. Exactly one → it. Never a guess: a wrong pid makes the engine decrypt a
// process that does not trust asight's CA and breaks it, so more than one, none, a slow table or an unreadable one all give null, and the
// caller judges by form (4.8 §5.4). There is no "unclaimed" bookkeeping: a connection opened before `on` would never be claimed and the
// judgement would go stale (review 2026-10-07). Node built-ins only; imports nothing of asight.

const OVER = Symbol('over budget')

/** ownerOf({ helper, hop: {port, address?}, candidates: pid[], budgetMs = 250, now, onFailure }) → { pid, source, ms }
 *  source = 'single-process' (one candidate: no table read) · 'socket-table' · null (pid null). `ms` is what the question cost; a table that is
 *  not back inside the budget gives null with ms ≥ budgetMs and is not a failure (it is slow, not unavailable; the call is not waited for).
 *  A table that cannot be read at all — the helper is down, the native code is blocked, the answer is not a table — gives null and ONE
 *  `socktable-unavailable` failure record per call (4.8 §12) to `onFailure`; the recorder folds repeats. A helper the daemon closed itself
 *  (`helper-closed`: a lookup in flight when `off` or a stop closed it) is null and no record: an operator's close is not a failure. `hop.address`, when the caller knows
 *  it, narrows the rows to that remote address; without it the remote port alone decides (the real owner's row is always in the table, so a
 *  stray row can only make the answer ambiguous, never wrong). The helper is asked for the candidates' rows only, and the answer is filtered
 *  again here, so a helper that ignores the filter changes nothing. */
export async function ownerOf({ helper, hop, candidates, budgetMs = 250, now = Date.now, onFailure = () => {} }) {
  if (!hop || !Number.isInteger(hop.port)) throw new TypeError('ownerOf: hop.port is required')
  const t0 = now()
  const cands = new Set((candidates || []).filter(Number.isInteger))
  const none = (ms = now() - t0) => ({ pid: null, source: null, ms: Math.max(0, ms) })
  if (cands.size === 0) return none()
  if (cands.size === 1) return { pid: [...cands][0], source: 'single-process', ms: Math.max(0, now() - t0) }

  let timer
  const over = new Promise((resolve) => { timer = setTimeout(() => resolve(OVER), budgetMs); if (timer.unref) timer.unref() })
  const asked = helper.call('tcp-table', { pids: [...cands], remotePort: hop.port }, { timeoutMs: budgetMs })
  asked.catch(() => {}) // when the budget wins, the table's own failure or late answer is nobody's to handle
  let answer
  try { answer = await Promise.race([asked, over]) } catch (e) {
    if (e && e.code === 'helper-timeout') answer = OVER
    else if (e && e.code === 'helper-closed') return none() // the daemon stopped its own helper (off, stop): not an unreadable table, nothing to record
    else return unavailable(e && e.message ? e.message : String(e))
  } finally { clearTimeout(timer) }
  if (answer === OVER) return none(Math.max(budgetMs, now() - t0))
  if (!answer || !Array.isArray(answer.rows)) return unavailable('the helper\'s answer has no rows')

  const holders = new Set()
  for (const row of answer.rows) {
    if (cands.has(row.pid) && row.remotePort === hop.port && (hop.address == null || row.remoteAddr === hop.address)) holders.add(row.pid)
  }
  return holders.size === 1 ? { pid: [...holders][0], source: 'socket-table', ms: Math.max(0, now() - t0) } : none()

  function unavailable(why) {
    onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the TCP owner table could not be read (${why}); the connection's owner is not worked out, the form is judged as a whole` })
    return none()
  }
}
