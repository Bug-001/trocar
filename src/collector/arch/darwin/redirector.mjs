// redirector.mjs — the macOS adapter of the Redirector contract (RFC 4.9 §1 · §5, as D47 rewrote it). The ENGINE is the only local proxy on this machine: it
// listens on one loopback door per entry group (ingress.json's group ports, engine.mjs `listen({groups})`), the agents' entries point straight at those
// doors, and the engine dials each connection's upstream itself — no forwarder process, no kernel config, no read-back.
//
// The contract's OS-neutral half — the doors' lifecycle, the accept-time socket identity, the splice/decrypt decision, the tracker's announce-and-wait seam
// — lives in ONE shared core since the win32 twin conversion closed 4.9 OPEN 9: core/engine/door-redirector.mjs (`createDoorRedirector`). What this adapter
// adds is darwin's three backends and nothing else:
//   · `matchForm` — darwin's forms table (forms.mjs): `ps` gives the whole command line in the same shot as the image, so a form that needs it either has it
//     or there is none (no `pending`, 4.9 §1);
//   · the facts' shape is darwin's own (procinfo.mjs `factsOfPid`, bound by the wiring): one targeted `ps -p <pid>` plus one targeted `lsof -p <pid>` for the
//     real executable, cached per process life by the core;
//   · `directCount` — the lsof established-connections table below, the one `status` shows as "still going direct".
// There is NO resident helper (4.9 §1): ps, lsof and scutil are plain CLIs, run on demand through execTool by the wiring. This file names no harness
// (arch/ never imports harness/: the daemon hands the groups in). Node built-ins only; nothing here execs anything itself.
import { createDoorRedirector, VERDICT_WAIT_MS as CORE_VERDICT_WAIT_MS } from '../../core/engine/door-redirector.mjs'
import { matchForm } from './forms.mjs'

/** The shared core's verdict wait (core/engine/door-redirector.mjs), re-exported for the tests that pin it. */
export const VERDICT_WAIT_MS = CORE_VERDICT_WAIT_MS

/**
 * createDarwinRedirector({ groups, home, ownerOf, factsOf, routes, ingress, authOf, onFailure, doors, entries, gate, exec, carried, now }) → the Redirector
 * (an EventEmitter) — the shared door core dressed with darwin's backends. See core/engine/door-redirector.mjs for the contract and every argument's
 * meaning; the two darwin-specific ones:
 *   ownerOf  `({ peer: { address, port } }) → { pid, source, ms } | null` (socktable.mjs `ownerOfSocket`, bound to the exec runner by the wiring): the
 *            owner of the accepted socket's peer end — the AGENT's own socket — read targeted at accept time; no candidates, no known table (D47)
 *   exec     the on-demand runner of the OS's read-only CLIs, `exec('lsof', args, { timeoutMs }) → Promise<{ code, out, err }>` (socktable.mjs's shape):
 *            what `directCount(pid)` asks through; without it there is no answer, only `{ count: null, error: 'no-exec' }` — unknown, never 0 (D-17)
 */
export function createDarwinRedirector({ groups, home = null, ownerOf = null, factsOf = null, routes = () => ({}), ingress = () => ({}), authOf = () => null, onFailure = () => {}, doors = null, entries = null, gate = null, exec = null, carried = () => null, hostsOf = () => null, now = Date.now } = {}) {
  if (!Array.isArray(groups)) throw new TypeError('createDarwinRedirector needs the groups (route-plan.mjs groupsOf)')
  return createDoorRedirector({
    groups, home, ownerOf, factsOf, routes, ingress, authOf, onFailure, doors, entries, gate, carried, hostsOf, now,
    matchForm,
    /** How many of the process's established connections do not go to a group's door on loopback — what `status` shows as "still going direct" (4.6 §开关
     *  语义). The table is `lsof -nP -Fpcn -iTCP -sTCP:ESTABLISHED` — the same record stream socktable.mjs reads, with the state in the command so the
     *  stream holds established connections only. `exec` is the injected on-demand runner (socktable.mjs's shape); one that is not there is
     *  `{ count: null, error: 'no-exec' }` — unknown, never 0 (D-17). A row with no foreign end (a listening or unconnected socket: no `->`) holds no
     *  connection and is not counted; a read that fails, is killed at its timeout or answers nothing is `{ count: null, error }`, never 0. */
    directCount: async (pid) => {
      if (!exec || typeof exec !== 'function') return { count: null, error: 'no-exec' }
      const ports = new Set(Object.values((ingress() || {}).groupPorts || {}))
      try {
        const t = await exec('lsof', ['-nP', '-Fpcn', '-iTCP', '-sTCP:ESTABLISHED'], { timeoutMs: 2000 })
        if (!t || typeof t !== 'object') return { count: null, error: 'no-rows' }
        if (t.code === null) return { count: null, error: 'lsof-timeout' }
        if (t.code !== 0) return { count: null, error: `lsof exited with ${t.code}${t.err ? `: ${t.err}` : ''}` }
        let count = 0
        let pidOf = null
        for (const line of String(t.out == null ? '' : t.out).split('\n')) {
          if (!line) continue
          if (line[0] === 'p') pidOf = Number.parseInt(line.slice(1), 10) // the pid whose files follow; a NaN holds nothing
          else if (line[0] === 'n') {
            const end = remoteEndOf(line.slice(1)) // socktable.mjs's parse, copied for the same stream: `local->foreign`, IPv6 literals unbracketed
            if (pidOf === pid && end && !((end.host === '127.0.0.1' || end.host === '::1') && ports.has(end.port))) count++
          } // every other record (`c` the command, `f` the descriptor) is skipped: the count is by pid and foreign end
        }
        return { count, error: null }
      } catch (e) { return { count: null, error: (e && e.code) || String((e && e.message) || e) } }
    },
  })
}

/** The foreign end of an `n` record's `local->foreign` — the hop's end of a connection. Socktable.mjs's parse, copied for the same record stream this
 *  adapter's `directCount` reads (not exported there; the two parses are the same words on the same bytes, and a change to the stream's shape is a change
 *  to both). A listening or unconnected socket has no `->` and holds no connection; a foreign end without a readable `host:port` is not one either. */
function remoteEndOf(name) {
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
