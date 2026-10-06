// redirector.mjs — the ONLY seam between the platform-independent engine (src/collector/core/)
// and the per-OS redirector (src/collector/arch/<os>/). The engine never branches on
// process.platform (RFC 4.6 §结构); it talks to whatever object satisfies the `Redirector`
// contract below. Plan 1 (this engine) uses only `lookup`; the platform methods are documented
// here so Plan 2's arch/linux redirector implements the same shape.
//
// Types
//   FlowMeta = {
//     dst:     { address: string, port: number, family: 4|6 },  // original destination (pre-redirect)
//     pid:     number|null,       // owning process id, or null when unknown
//     agent:   string|null,       // harness name (e.g. 'claude-code'), or null for an unmatched proc
//     decrypt: boolean,           // the kernel-side verdict: should this flow be TLS-decrypted?
//   }
//
// Contract (what arch/<os> exposes to core)
//   lookup(peer: {address, port}): Promise<FlowMeta|null>
//       The ONLY method the engine calls. Given the accepted socket's remote {address, port}
//       (the client source), return the flow's metadata, or null if the peer is unknown
//       (the engine then closes the socket — it was redirected by mistake or raced).
//   attach(): Promise<void>        — load kernel programs / start the OS redirector (Plan 2).
//   detach(): Promise<void>        — unload them; fail-open leaves agent traffic direct (Plan 2).
//   status(): Promise<object>      — expected vs actual kernel state (RFC 4.6 §开关语义) (Plan 2).
//   watch(pid, verdict): void      — mark a pid decrypt/observe-only (Plan 2).
//   unwatch(pid): void             — stop managing a pid (Plan 2).
//   heartbeat(): void              — liveness the kernel gates redirection on (Plan 2).
//   events: 'exec' | 'exit' | 'flow-meta' | 'down'  — process + redirector lifecycle (Plan 2); 'helper-error' {reason}
//           (the helper reported an error) and 'heartbeat-error' {reason} (a heartbeat failed) — failures the daemon
//           records (D38).
//
// What the daemon (src/collector/daemon.mjs, Plan 3a) also needs from an arch adapter — the Linux one is
// arch/linux/redirector.mjs; a later OS implements the same names:
//   start() / close()              — spawn / stop the OS helper; close() leaves agent traffic direct.
//   configure(enginePort)          — the port the kernel steers decrypt-verdict connections to.
//   scan(): Promise<ProcFacts[]>   — this user's live processes (startup and every `on`).
//   directCount(pid): {count, error} — the process's connections still going direct (status only); count null +
//                                    the errno when it cannot be told (never 0, D-17).
//   'facts-error' {os, pid, code, comm, argv, reason} — a process of this user whose exe could not be read, so never judged
//                                    (D-30); comm and argv are what is still readable, for "could this be an agent".
//   unreadable(): [{pid, comm, errno, argv}] — those of this user still there since the last scan (not the helper's own).
//   helperInfo() → {pid, proto, build}; expectedProto — the helper protocol this build speaks.
//   restart() / linger()           — respawn a dead helper; whether the OS keeps the daemon after logout (Plan 3a).
//   'exec' carries ProcFacts = { os, pid, ppid, uid, exe, argv, env (Map, read lazily), cwd, startedAt,
//   startTicks (Plan 3a), source:'exec'|'scan' } — OS-neutral; `os` picks the harness signature key.
//
// createStaticRedirector is the test/dev implementation: no kernel, metadata set by hand and
// keyed by the client source port (the Linux redirector keys by source port too — sockops writes
// the by_port entry before accept() returns).

/**
 * @typedef {Object} FlowMeta
 * @property {{address: string, port: number, family: 4|6}} dst
 * @property {number|null} pid
 * @property {string|null} agent
 * @property {boolean} decrypt
 */

/**
 * In-memory Redirector for tests and local dev.
 *
 * lookup races accept: a client's source port can be registered (set) a tick after the engine
 * accepts and calls lookup — exactly as the Linux redirector's sockops entry is written before
 * accept returns. So, with no default and no entry yet, lookup polls briefly (up to waitMs) for the
 * port to appear before giving up; a configured defaultMeta is returned immediately (no wait).
 *
 * @param {FlowMeta|null} [defaultMeta] fallback returned when a peer's port has no override.
 * @returns {{ lookup: (peer: {address: string, port: number}) => Promise<FlowMeta|null>, set: (port: number, meta: FlowMeta) => void, lookups: number }}
 */
export function createStaticRedirector(defaultMeta = null, { waitMs = 200, pollMs = 5 } = {}) {
  const byPort = new Map()
  const r = {
    lookups: 0,
    set(port, meta) { byPort.set(port, meta) },
    async lookup({ port }) {
      r.lookups++
      if (byPort.has(port)) return byPort.get(port)
      if (defaultMeta) return defaultMeta
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, pollMs))
        if (byPort.has(port)) return byPort.get(port)
      }
      return defaultMeta ?? null
    },
  }
  return r
}
