// socktable.mjs — which process owns the connection the engine just accepted, read from the socket itself at accept time (RFC 4.9 §5.3, D47).
//
// The agent connects to the engine's own listener (there is no kernel between them any more), so the engine's peer 4-tuple IS the agent's
// outbound socket: the one question that answers its owner is a TARGETED `lsof -nP -Fpcn -iTCP@<addr>:<port>` — the record stream carries the
// pid (`p`), the command (`c`, skipped) and one `n` per socket as `local->foreign`. A row whose LOCAL end is the peer address:port is the
// agent's own socket; the engine's accepted socket of the same connection shows the peer as its FOREIGN end and never matches the local-end
// filter (and the engine's own pid is excluded beside that, belt and braces). A wrong pid must never happen (4.8 W4): it would make the engine
// decrypt a process that does not trust asight's CA and break it, so no row, several rows (the pid was reused mid-query, or an IPv6 twin), an
// unreadable or slow table all give null, and the connection is judged untracked and spliced. There is no candidates set, no `known` table, no
// debounce and no demand poll (D47 deleted that machinery): the peer process is alive by definition — it just connected — so one query per
// connection is the whole cost (~30 ms measured, 4.9 [本机] experiment ②; this file re-measured the targeted form at the same figure).
// `budgetMs` stays generous (250 ms): a table that is not back inside it is SLOW, not unavailable — null with the cost said, and no failure
// record; a table that cannot be read at all gives null and ONE `socktable-unavailable` record (4.8 §12) to `onFailure`, which the recorder
// folds. Node built-ins only; imports nothing of asight.

const OVER = Symbol('over budget')

/** The local end of an `n` record's `local->foreign` — the side that process owns. A listening or unconnected socket has no `->` and owns no
 *  connection; a local end without a readable `host:port` is not one either. */
function localEnd(name) {
  const arrow = name.lastIndexOf('->')
  if (arrow < 0) return null
  const local = name.slice(0, arrow)
  const colon = local.lastIndexOf(':')
  if (colon < 1) return null
  const port = Number.parseInt(local.slice(colon + 1), 10)
  if (!Number.isInteger(port)) return null
  let host = local.slice(0, colon)
  if (host.length > 2 && host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1) // lsof brackets IPv6 literals; the caller names the address unbracketed
  return { host, port }
}

/** ownerOfSocket({ exec, peer: {address, port}, budgetMs = 250, now, onFailure }) → { pid, source, ms }
 *  `peer` is the accepted socket's remote end as the engine sees it ({address, port} — `socket.remoteAddress` / `remotePort`): the AGENT's
 *  socket local end. `exec` is the injected on-demand runner of the OS's read-only CLIs (`execTool`'s shape on an async runner, because the
 *  budget race has to leave the event loop alive), asked as `exec('lsof', ['-nP', '-Fpcn', '-iTCP@addr:port'], { timeoutMs: budgetMs })` →
 *  Promise<{ code, out, err }>: `code: 0` with the record stream in `out`, `code: null` when the runner killed it at the budget (slow, not
 *  unavailable), anything else a failure, and a rejection when the tool could not be asked at all (or the runner's own exec-closed, which is
 *  an operator's close and not a failure). source = 'socket-table' when a pid is answered, null with the pid. `ms` is what the question cost.
 *  A peer address that is not an IPv4 literal is answered null at once (the engine's doors bind 127.0.0.1 only, D47: an IPv6 peer cannot be
 *  one of the agents' entries, and lsof's @-syntax for a bracketed literal is its own dialect — a fail-safe null, never a guess). */
export async function ownerOfSocket({ exec, peer, budgetMs = 250, now = Date.now, onFailure = () => {} }) {
  if (!exec || typeof exec !== 'function') throw new TypeError('ownerOfSocket needs the injected exec runner (execTool\'s shape, async)')
  if (!peer || !Number.isInteger(peer.port)) throw new TypeError('ownerOfSocket: peer.port is required')
  const t0 = now()
  const none = (ms = now() - t0) => ({ pid: null, source: null, ms: Math.max(0, ms) })
  const addr = String((peer && peer.address) || '')
  if (addr === '' || addr.includes(':')) return none(0) // not an IPv4 loopback peer: the doors never see one (the fail-safe answer)

  let timer
  const over = new Promise((resolve) => { timer = setTimeout(() => resolve(OVER), budgetMs); if (timer.unref) timer.unref() })
  const asked = exec('lsof', ['-nP', '-Fpcn', `-iTCP@${addr}:${peer.port}`], { timeoutMs: budgetMs })
  asked.catch(() => {}) // when the budget wins, the table's own failure or late answer is nobody's to handle
  let answer
  try { answer = await Promise.race([asked, over]) } catch (e) {
    if (e && e.code === 'exec-closed') return none() // the collector's own stop closed the runner: an operator's close, nothing to record
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
    if (line[0] === 'p') pid = Number.parseInt(line.slice(1), 10) // the pid whose files follow; a NaN holds nothing
    else if (line[0] === 'n') {
      const local = localEnd(line.slice(1))
      if (local != null && local.port === peer.port && local.host === addr && Number.isInteger(pid)) holders.add(pid)
    } // every other record (`c` the command, `f` the descriptor) is skipped: the judgement is by pid
  }
  const mine = [...holders].filter((p) => p !== process.pid) // the engine's accepted socket names the peer as its FOREIGN end and is not in `holders`; the pid exclusion is belt and braces
  return mine.length === 1 ? { pid: mine[0], source: 'socket-table', ms: Math.max(0, now() - t0) } : none()

  function unavailable(why) {
    onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the TCP owner table could not be read (${why}); the connection's owner is not worked out, it is spliced untracked` })
    return none()
  }
}
