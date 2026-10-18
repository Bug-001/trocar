// socktable.mjs — which process owns the connection the engine just accepted, read from the kernel's TCP table at accept time (RFC 4.9 §5.3, D47).
//
// The agent connects to the engine's own listener (there is no kernel between them any more), so the engine's peer 4-tuple IS the agent's
// outbound socket. `netstat -anv -p tcp` is one read of the kernel's TCP table (the pcblist sysctl): every TCP socket with the process that
// last used it (`process:pid`; plain `pid` on older releases) — about 10 ms on a busy Mac. A row whose LOCAL end is the peer address.port is the
// agent's own socket: it wrote the CONNECT the door is answering, so the last process to use it is the one speaking to the door. The engine's
// accepted socket of the same connection shows the peer as its FOREIGN end and never matches the local-end filter (and the engine's own pid is
// excluded beside that, belt and braces).
//
// The answer is a fact, not a race: the peer just connected and is waiting for the door's answer, so its socket is in the table, and the lookup
// is waited for however long it takes. (Until 2026-10-17 a targeted `lsof` raced a 250 ms budget and "slow" meant untracked: lsof walks every
// process's file table, 274 ms on a macOS machine while OpenCode opened its connections, and that one miss spliced a 292 s connection carrying every
// turn of the session.) A wrong pid must never happen (4.8 W4): it would make the engine decrypt a process that does not trust asight's CA and
// break it, so no row, several pids on the row's end, or a table that cannot be read all give null, and the connection is judged untracked and
// spliced. A table that cannot be read — the tool failed, or hung past `timeoutMs` and was killed — gives null and ONE `socktable-unavailable`
// record (4.8 §12) to `onFailure`, which the recorder folds. Node built-ins only; imports nothing of asight.

/** How long a hung netstat may hold the connection before it is killed and the table counts as unreadable: a hang guard, never a verdict. */
const TABLE_HANG_MS = 10_000

/** Where the owner is in a row, from the header: `process:pid` (a name that may hold spaces, then `:<pid>`) or a plain `pid` column. */
export function ownerColumn(header) {
  const cols = header.replace('Local Address', 'Local').replace('Foreign Address', 'Foreign').trim().split(/\s+/)
  const named = cols.indexOf('process:pid')
  if (named >= 0) return { at: named, named: true }
  const plain = cols.indexOf('pid')
  return plain >= 0 ? { at: plain, named: false } : null
}

/** The owner on one row: { pid, name } — `name` is the program of a `process:pid` column (its spaces kept, as the kernel cut it to 16
 *  characters), null where the column is a plain `pid`. Both null when the row names no owner. */
export function ownerAt(tokens, col) {
  if (!col.named) return { pid: /^\d+$/.test(tokens[col.at] || '') ? Number(tokens[col.at]) : null, name: null }
  for (let k = col.at; k < tokens.length; k++) { // the name ends at its `:<pid>`
    const m = /^(.*):(\d+)$/.exec(tokens[k])
    if (m) return { pid: Number(m[2]), name: [...tokens.slice(col.at, k), m[1]].join(' ') || null }
  }
  return { pid: null, name: null }
}

/** ownerOfSocket({ exec, peer: {address, port}, timeoutMs, now, onFailure }) → { pid, source, ms }
 *  `peer` is the accepted socket's remote end as the engine sees it ({address, port} — `socket.remoteAddress` / `remotePort`): the AGENT's
 *  socket local end. `exec` is the injected runner of the OS's read-only CLIs (`execTool`'s shape on an async runner, so the event loop stays
 *  free while the table is read), asked as `exec('netstat', ['-anv', '-p', 'tcp'], { timeoutMs })` → Promise<{ code, out, err }>: `code: 0`
 *  with the table in `out`, `code: null` when the runner killed it at `timeoutMs`, anything else a failure, and a rejection when the tool could
 *  not be asked at all (or the runner's own exec-closed, which is an operator's close and not a failure). source = 'socket-table' when a pid is
 *  answered, null with the pid. `ms` is what the question cost. A peer address that is not an IPv4 literal is answered null at once (the
 *  engine's doors bind 127.0.0.1 only, D47: an IPv6 peer cannot be one of the agents' entries). */
export async function ownerOfSocket({ exec, peer, timeoutMs = TABLE_HANG_MS, now = Date.now, onFailure = () => {} }) {
  if (!exec || typeof exec !== 'function') throw new TypeError('ownerOfSocket needs the injected exec runner (execTool\'s shape, async)')
  if (!peer || !Number.isInteger(peer.port)) throw new TypeError('ownerOfSocket: peer.port is required')
  const t0 = now()
  const none = (ms = now() - t0) => ({ pid: null, source: null, ms: Math.max(0, ms) })
  const addr = String((peer && peer.address) || '')
  if (addr === '' || addr.includes(':')) return none(0) // not an IPv4 loopback peer: the doors never see one (the fail-safe answer)

  let answer
  try { answer = await exec('netstat', ['-anv', '-p', 'tcp'], { timeoutMs }) } catch (e) {
    if (e && e.code === 'exec-closed') return none() // the collector's own stop closed the runner: an operator's close, nothing to record
    return unavailable(e && e.message ? e.message : String(e))
  }
  if (answer == null || typeof answer !== 'object') return unavailable('the runner answered nothing')
  if (answer.code === null) return unavailable(`netstat did not answer within ${timeoutMs} ms and was killed`)
  if (answer.code !== 0) return unavailable(`netstat exited with ${answer.code}${answer.err ? `: ${answer.err}` : ''}`)

  const lines = String(answer.out == null ? '' : answer.out).split('\n')
  const header = lines.find((l) => /^Proto\s/.test(l))
  const col = header ? ownerColumn(header) : null
  if (!col) return unavailable('netstat printed no owner column (process:pid or pid)')
  const local = `${addr}.${peer.port}`
  const holders = new Set()
  for (const line of lines) {
    const t = line.trim().split(/\s+/)
    if (!/^tcp4/.test(t[0] || '') || t[3] !== local) continue
    const pid = ownerAt(t, col).pid
    if (pid != null && pid > 0) holders.add(pid) // pid 0: a row no process holds (TIME_WAIT) is nobody's
  }
  const mine = [...holders].filter((p) => p !== process.pid) // the engine's accepted socket names the peer as its FOREIGN end and is not in `holders`; the pid exclusion is belt and braces
  return mine.length === 1 ? { pid: mine[0], source: 'socket-table', ms: Math.max(0, now() - t0) } : none()

  function unavailable(why) {
    onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the TCP owner table could not be read (${why}); the connection's owner is not worked out, it is spliced untracked` })
    return none()
  }
}
