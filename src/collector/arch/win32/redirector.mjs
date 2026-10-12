// redirector.mjs — the Windows adapter of the Redirector contract (RFC 4.9 §1 · §5, D47's twin conversion — the kernel route this file used to carry is
// deleted with it). The ENGINE is the only local proxy on this machine: it listens on one loopback door per entry group (ingress.json's group ports,
// engine.mjs `listen({groups})`), the agents' entries point straight at those doors, and the engine dials each connection's upstream itself — no forwarder
// process, no kernel config, no read-back (asight-forwarder.exe, its download and its lock are gone).
//
// The contract's OS-neutral half — the doors' lifecycle, the accept-time socket identity, the splice/decrypt decision, the tracker's announce-and-wait
// seam — lives in ONE shared core with the darwin twin: core/engine/door-redirector.mjs (`createDoorRedirector`). What this adapter adds is Windows's
// three backends and nothing else:
//   · `matchForm` — the Windows forms table (forms.mjs): the helper's `ps` row carries a `cmdlineState`, so a form that needs the command line it does not
//     have yet can still answer `pending` (forms.mjs's own rule; on the accept-time seam nothing waits for it — the ask is simply not that form's, the
//     fail-safe answer, never a wrong one);
//   · the facts' shape is Windows's own (procinfo.mjs `factsOfPid`, bound to the helper by the wiring): one targeted helper `ps` ask per process life;
//   · `directCount` — the helper's `tcp-table` read below, the one `status` shows as "still going direct".
// The resident read-only helper (helper.mjs) stays — it is the reader of the registry, the roots, the process snapshot and the TCP table, and nothing else
// on Windows reads those without it. This file names no harness (arch/ never imports harness/: the daemon hands the groups in). Node built-ins only;
// nothing here execs anything itself.
import { createDoorRedirector, VERDICT_WAIT_MS as CORE_VERDICT_WAIT_MS } from '../../core/engine/door-redirector.mjs'
import { HELPER_PROTO } from './helper.mjs'
import { matchForm } from './forms.mjs'

/** The shared core's verdict wait (core/engine/door-redirector.mjs), re-exported for the tests that pin it. */
export const VERDICT_WAIT_MS = CORE_VERDICT_WAIT_MS

/**
 * createWin32Redirector({ helper, groups, home, ownerOf, factsOf, routes, ingress, authOf, onFailure, doors, entries, gate, carried, now }) → the Redirector
 * (an EventEmitter) — the shared door core dressed with Windows's backends. See core/engine/door-redirector.mjs for the contract and every argument's
 * meaning; the Windows-specific ones:
 *   helper   the started helper client (helper.mjs `startHelper`): its `ready` line and `pid` answer `start()` / `helperInfo()`, its protocol is
 *            `expectedProto` (the daemon's check), and `close()` (the redirector's own) closes it
 *   ownerOf  `({ peer: { address, port } }) → { pid, source, ms } | null` (socktable.mjs `ownerOfSocket`, bound to the helper by the wiring): the owner of
 *            the accepted socket's peer end — the AGENT's own socket — read targeted at accept time from the GetExtendedTcpTable the helper holds
 *   factsOf  `(pid) → ProcFacts | null` (procinfo.mjs `factsOfPid`, bound the same way): the pid's facts — its real executable, command line and start
 *            time — for the form match and the tracker's judgement; null = the pid is gone (not an error)
 */
export function createWin32Redirector({ helper, groups, home = null, ownerOf = null, factsOf = null, routes = () => ({}), ingress = () => ({}), authOf = () => null, onFailure = () => {}, doors = null, entries = null, gate = null, carried = () => null, hostsOf = () => null, now = Date.now } = {}) {
  if (!helper || typeof helper.call !== 'function') throw new TypeError('createWin32Redirector needs the helper client (helper.mjs startHelper)')
  if (!Array.isArray(groups)) throw new TypeError('createWin32Redirector needs the groups (route-plan.mjs groupsOf)')
  return createDoorRedirector({
    groups, home, ownerOf, factsOf, routes, ingress, authOf, onFailure, doors, entries, gate, carried, hostsOf, now,
    matchForm,
    companion: { // the resident read-only helper: the core's start() waits for its ready line, its close() runs on the redirector's own
      ready: async () => { const r = helper && helper.ready ? await helper.ready : null; return r ? { pid: helper.pid ?? r.pid ?? null, proto: r.proto ?? null, build: r.ps ?? null } : { pid: helper.pid ?? null, proto: null, build: null } },
      close: async () => { if (helper && typeof helper.close === 'function') await helper.close() },
      proto: HELPER_PROTO,
    },
    /** How many of the process's established connections do not go to a group's door on loopback — what `status` shows as "still going direct" (4.6 §开关
     *  语义); the table is read through the helper. `{ count, error }`: a table that cannot be read is `count: null` and why, never 0. */
    directCount: async (pid) => {
      const ports = new Set(Object.values((ingress() || {}).groupPorts || {}))
      try {
        const t = await helper.call('tcp-table', { pids: [pid], states: ['established'] }, { timeoutMs: 2000 })
        if (!t || !Array.isArray(t.rows)) return { count: null, error: 'no-rows' }
        const toAsight = (row) => (row.remoteAddr === '127.0.0.1' || row.remoteAddr === '::1') && ports.has(row.remotePort)
        return { count: t.rows.filter((row) => row.pid === pid && row.state === 'established' && !toAsight(row)).length, error: null }
      } catch (e) { return { count: null, error: (e && e.code) || String((e && e.message) || e) } }
    },
  })
}
