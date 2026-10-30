// socktable.mjs — which process owns the connection the engine just accepted, read from the sockets of this user's processes at accept time (RFC 4.9 §5.3, D47).
//
// The agent connects to the engine's own listener (there is no kernel between them any more), so the engine's peer 4-tuple IS the agent's
// outbound socket. The native `socktable` helper (native/socktable.c) lists every TCP socket of this user's processes in one pass of the
// kernel's per-process socket info (~5 ms on a macOS machine), one row per holder: `<pid> <state> <laddr> <lport> <faddr> <fport>`. A row whose
// LOCAL end is the peer address.port is the agent's own socket: it wrote the CONNECT the door is answering. The engine's accepted socket of
// the same connection shows the peer as its FOREIGN end and never matches the local-end filter (and the engine's own pid is excluded beside
// that, belt and braces). `netstat -anv -p tcp` read this from the pcblist sysctl until macOS 27 stopped handing that table to a caller
// under an ad-hoc-signed node (a macOS machine 2026-10-20: netstat printed nothing, every connection was spliced `pid-unresolved`); the helper
// reads what a process may always read about its own user's processes, and an agent is always one of them (4.9 §5.3 ① other-user).
//
// The answer is a fact, not a race: the peer just connected and is waiting for the door's answer, so its socket is in the table, and the lookup
// is waited for however long it takes. (Until 2026-10-17 a targeted `lsof` raced a 250 ms budget and "slow" meant untracked: lsof walks every
// process's file table, 274 ms on a macOS machine while OpenCode opened its connections, and that one miss spliced a 292 s connection carrying every
// turn of the session.) A wrong pid must never happen (4.8 W4): it would make the engine decrypt a process that does not trust trocar's CA and
// break it, so no row (`no-row`), several pids on the row's end that persist across a few re-reads (a socket a child really inherited: `shared`),
// or a table that cannot be read (`unreadable`) all give null, and the connection is judged untracked and spliced. Several holders on ONE read
// are mostly a child between fork and exec (a CLOEXEC copy of its parent's socket, gone within ms; e.g. Claude Code's start-up
// burst races the children it spawns), so they are read again, bounded, and the one holder left is the answer. A table that cannot be read — the helper failed, or hung past `timeoutMs` and was killed — gives
// null and ONE `socktable-unavailable` record (4.8 §12) to `onFailure`, which the recorder folds. Imports nothing of trocar but native.mjs.
import { NATIVE, nativePath } from './native.mjs'

/** How long a hung helper may hold the connection before it is killed and the table counts as unreadable: a hang guard, never a verdict. */
const TABLE_HANG_MS = 10_000
/** Several holders on the peer's end: up to this many more reads, this far apart (4.9 §5.3 step 1; a fork-window co-holder is gone within ms). */
const REREADS = 4, REREAD_MS = 10

/** The helper's answer → [{ pid, state, laddr, lport, faddr, fport }]; a line that is not six fields of that shape is skipped. */
export function parseSockTable(text) {
  const out = []
  for (const line of String(text == null ? '' : text).split('\n')) {
    const t = line.trim().split(/\s+/)
    if (t.length !== 6 || !/^\d+$/.test(t[0]) || !/^\d+$/.test(t[3]) || !/^\d+$/.test(t[5])) continue
    out.push({ pid: Number(t[0]), state: t[1], laddr: t[2], lport: Number(t[3]), faddr: t[4], fport: Number(t[5]) })
  }
  return out
}

/** ownerOfSocket({ exec, peer: {address, port}, socktablePath, timeoutMs, now, onFailure }) → { pid, source, ms, why?, sameUser? }
 *  `peer` is the accepted socket's remote end as the engine sees it ({address, port} — `socket.remoteAddress` / `remotePort`): the AGENT's
 *  socket local end. `exec` is the injected runner of the OS's read-only CLIs (`execTool`'s shape on an async runner, so the event loop stays
 *  free while the table is read), asked as `exec(socktablePath, [], { timeoutMs })` → Promise<{ code, out, err }>: `code: 0`
 *  with the table in `out`, `code: null` when the runner killed it at `timeoutMs`, anything else a failure, and a rejection when the tool could
 *  not be asked at all (or the runner's own exec-closed, which is an operator's close and not a failure). source = 'socket-table' when a pid is
 *  answered, null with the pid. `ms` is what the question cost. A null pid says `why` ('no-row' · 'shared' · 'unreadable'). An answered pid and
 *  'shared' also say `sameUser: true`: the helper lists only this user's processes, so every holder it names is this user's (4.11 P10) — a
 *  proof that stands when the pid's own `ps` cannot answer (a few-second DarkWake). A peer address that is not an IPv4 literal is answered null at once (the
 *  engine's doors bind 127.0.0.1 only, D47: an IPv6 peer cannot be one of the agents' entries). */
export async function ownerOfSocket({ exec, peer, socktablePath = nativePath(NATIVE.socktable), timeoutMs = TABLE_HANG_MS, now = Date.now, onFailure = () => {} }) {
  if (!exec || typeof exec !== 'function') throw new TypeError('ownerOfSocket needs the injected exec runner (execTool\'s shape, async)')
  if (!peer || !Number.isInteger(peer.port)) throw new TypeError('ownerOfSocket: peer.port is required')
  const t0 = now()
  const none = (ms = now() - t0) => ({ pid: null, source: null, ms: Math.max(0, ms) })
  const addr = String((peer && peer.address) || '')
  if (addr === '' || addr.includes(':')) return none(0) // not an IPv4 loopback peer: the doors never see one (the fail-safe answer)

  // several holders on the peer's end is mostly a child between fork and exec (it holds a CLOEXEC copy of its parent's socket for a few ms):
  // read again, bounded, and answer the one holder left; holders that persist are a socket a child really inherited (null, `shared`)
  for (let read = 0; ; read++) {
    let answer
    try { answer = await exec(socktablePath, [], { timeoutMs }) } catch (e) {
      if (e && e.code === 'exec-closed') return none() // the collector's own stop closed the runner: an operator's close, nothing to record
      return unavailable(e && e.message ? e.message : String(e))
    }
    if (answer == null || typeof answer !== 'object') return unavailable('the runner answered nothing')
    if (answer.code === null) return unavailable(`socktable did not answer within ${timeoutMs} ms and was killed`)
    if (answer.code !== 0) return unavailable(`socktable exited with ${answer.code}${answer.err ? `: ${answer.err}` : ''}`)
    const holders = new Set()
    for (const r of parseSockTable(answer.out)) if (r.laddr === addr && r.lport === peer.port && r.pid > 0 && r.pid !== process.pid) holders.add(r.pid) // the engine's accepted socket names the peer as its FOREIGN end and is never a holder; the pid exclusion is belt and braces
    if (holders.size === 1) return { pid: [...holders][0], source: 'socket-table', ms: Math.max(0, now() - t0), sameUser: true } // this user's: the helper lists no other
    if (holders.size === 0) return { ...none(), why: 'no-row' }
    if (read >= REREADS) return { ...none(), why: 'shared', sameUser: true } // the helper lists only this user's processes: every holder is this user's
    await new Promise((resolve) => setTimeout(resolve, REREAD_MS)) // awaited and 10 ms: kept ref'd, an unref'd wait would let a caller with nothing else open end mid-question
  }

  function unavailable(why) {
    onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the TCP owner table could not be read (${why}); the connection's owner is not worked out, it is spliced untracked` })
    return { ...none(), why: 'unreadable' }
  }
}
