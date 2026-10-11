// socktable.mjs — which process of a form owns the connection that just reached the hop (RFC 4.9 §1 · §5.3; the judgement and its reasons are 4.8 §5.3, acceptance W4).
//
// The darwin port of `arch/win32/socktable.mjs`: the judgement is carried over verbatim (the budget race, a single candidate or null, a holder outside the caller's table → null);
// what is darwin's is the data source (4.9 §1). There is no resident helper on this OS — ps, lsof, scutil, security, route are plain CLIs asked one question at a time — so the table
// is `lsof -nP -Fpcn -iTCP`: a record stream where `p` records carry the pid of the process whose files follow, `c` its command (skipped: the judgement is by pid) and `n` one socket's
// addresses as `local->foreign` (a listening or unconnected socket has no `->`: it holds no connection to anything). The engine's peer is the own forwarder (asight's kernel), not the
// agent, and the connection that just reached the hop is the agent's outbound one, so a holder is a process whose `n` names the hop as its FOREIGN end — port equal, and address equal
// when the caller knows it, the narrowing the Windows rows' remotePort/remoteAddr do; lsof brackets IPv6 literals and the brackets come off before the compare. Rows of other ports are
// ignored here, so a runner that answers more than was asked changes nothing. Darwin has no pid-0 rows (lsof lists process-owned sockets, and a TIME_WAIT leftover owns no process,
// 4.9 §1), so the pid-0 clause of the Windows table has no counterpart; a row whose pid does not read as an integer is an unknown holder. A wrong pid must never happen (4.8 W4): it
// would make the engine decrypt a process that does not trust asight's CA and break it, so more than one candidate, none, an UNSEEN holder, a slow table or an unreadable one all give
// null, and the caller judges by form (4.8 §5.4). The process table the caller keeps lags the real world by a poll (about 2 s): a process that started a moment ago connects before
// anybody has a row for it, so a holder outside the caller's table may be the very process whose connection this is, and the known ones holding a tunnel of their own must not be taken
// for it. There is no "unclaimed" bookkeeping: a connection opened before `on` would never be claimed and the judgement would go stale (review 2026-10-07). Node built-ins only;
// imports nothing of asight.

const OVER = Symbol('over budget')

/** The foreign end of an `n` record's `local->foreign` — the hop's end of the agent's connection. A listening or unconnected socket has no `->` and holds no connection to anything;
 *  a foreign end without a readable `host:port` is not one either. */
function remoteEnd(name) {
  const arrow = name.lastIndexOf('->')
  if (arrow < 0) return null
  const remote = name.slice(arrow + 2)
  const colon = remote.lastIndexOf(':')
  if (colon < 1) return null
  const port = Number.parseInt(remote.slice(colon + 1), 10)
  if (!Number.isInteger(port)) return null
  let host = remote.slice(0, colon)
  if (host.length > 2 && host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1) // lsof brackets IPv6 literals; the caller names the address unbracketed
  return { host, port }
}

/** ownerOf({ exec, hop: {port, address?}, candidates: pid[], known?: pid[], budgetMs = 250, now, onFailure }) → { pid, source, ms }
 *  `candidates` = the processes the connection can be from (the form's, and the ones whose command line is not known yet); `known` = every process the
 *  caller has a row for (the candidates and the others), default the candidates: a holder that is not in it is an unseen process and the answer is null. A
 *  known holder that is not a candidate is another form's (or no agent's) and is left out, which is how two forms of one group, sharing a port, are told apart.
 *  `exec` = the injected on-demand runner of the OS's read-only CLIs (the machine stays injected: nothing here runs anything itself), asked as
 *  `exec('lsof', ['-nP', '-Fpcn', '-iTCP'], { timeoutMs: budgetMs })` → Promise<{ code, out, err }>: `execTool`'s return shape (src/off/exec.mjs) on an async
 *  runner, async because the budget race has to leave the event loop alive. It resolves `{ code: 0, out }` when lsof answered (out = the record stream; an empty
 *  one is an empty table), `{ code: null, out, err }` when the runner killed it at `timeoutMs` (slow, not unavailable) and `{ code, err }` when lsof ran and failed,
 *  and it rejects when the tool could not be asked at all (absent, the runner broken) — or with the runner's own closed code (exec.mjs's exec-closed, when the collector's own stop closed it,
 *  which is an operator's close and not a failure. lsof is asked for the whole table, not a port-targeted read: both measured the same (~28 ms each on this
 *  machine, 4.9 [本机] experiment ②, 2026-10-08, macOS 26.6.2 arm64), well inside the 250 ms budget, and the whole table is what shows an unseen process.
 *  source = 'single-process' (the form has one candidate and it is the holder: the table is still read, to rule an unseen process out) · 'socket-table' · null (pid null).
 *  `ms` is what the question cost; a table that is not back inside the budget gives null with ms ≥ budgetMs and is not a failure (it is slow, not unavailable; the
 *  call is not waited for). A table that cannot be read at all gives null and ONE `socktable-unavailable` failure record per call (4.8 §12) to `onFailure`
 *  (`where: 'helper'` is the closed set's name for the socket-table questioner, src/health/codes.mjs; on this OS it names no resident process); the recorder folds repeats. */
export async function ownerOf({ exec, hop, candidates, known = null, budgetMs = 250, now = Date.now, onFailure = () => {} }) {
  if (!hop || !Number.isInteger(hop.port)) throw new TypeError('ownerOf: hop.port is required')
  const t0 = now()
  const cands = new Set((candidates || []).filter(Number.isInteger))
  const accounted = new Set([...cands, ...(known || []).filter(Number.isInteger)])
  const none = (ms = now() - t0) => ({ pid: null, source: null, ms: Math.max(0, ms) })
  if (cands.size === 0) return none()

  let timer
  const over = new Promise((resolve) => { timer = setTimeout(() => resolve(OVER), budgetMs); if (timer.unref) timer.unref() })
  const asked = exec('lsof', ['-nP', '-Fpcn', '-iTCP'], { timeoutMs: budgetMs })
  asked.catch(() => {}) // when the budget wins, the table's own failure or late answer is nobody's to handle
  let answer
  try { answer = await Promise.race([asked, over]) } catch (e) {
    if (e && e.code === 'exec-closed') return none() // the collector's own stop closed the runner: an operator's close is not an unreadable table, nothing to record
    else return unavailable(e && e.message ? e.message : String(e))
  } finally { clearTimeout(timer) }
  if (answer === OVER) return none(Math.max(budgetMs, now() - t0))
  if (answer == null || typeof answer !== 'object') return unavailable('the runner answered nothing')
  if (answer.code === null) return none(Math.max(budgetMs, now() - t0)) // the runner killed lsof at the budget: slow, not unavailable
  if (answer.code !== 0) return unavailable(`lsof exited with ${answer.code}${answer.err ? `: ${answer.err}` : ''}`)

  const holders = new Set()
  let pid = null
  for (const line of String(answer.out == null ? '' : answer.out).split('\n')) {
    if (!line) continue
    if (line[0] === 'p') pid = Number.parseInt(line.slice(1), 10) // the pid whose files follow; a NaN is an unknown holder the moment it holds a connection
    else if (line[0] === 'n') {
      const remote = remoteEnd(line.slice(1))
      if (remote != null && remote.port === hop.port && (hop.address == null || remote.host === hop.address)) holders.add(pid)
    } // every other record (`c` the command, `f` the descriptor) is skipped: the judgement is by pid
  }
  for (const holder of holders) if (!accounted.has(holder)) return none() // a process the caller has no row for holds a connection to the hop: it may be the one that just connected
  const mine = [...holders].filter((p) => cands.has(p))
  return mine.length === 1 ? { pid: mine[0], source: cands.size === 1 ? 'single-process' : 'socket-table', ms: Math.max(0, now() - t0) } : none()

  function unavailable(why) {
    onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the TCP owner table could not be read (${why}); the connection's owner is not worked out, the form is judged as a whole` })
    return none()
  }
}
