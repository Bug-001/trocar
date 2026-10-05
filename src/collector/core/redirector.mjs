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
//   events: 'exec' | 'exit' | 'flow-meta' | 'down'  — process + redirector lifecycle (Plan 2).
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
 * @param {FlowMeta|null} [defaultMeta] fallback returned when a peer's port has no override.
 * @returns {{ lookup: (peer: {address: string, port: number}) => Promise<FlowMeta|null>, set: (port: number, meta: FlowMeta) => void, lookups: number }}
 */
export function createStaticRedirector(defaultMeta = null) {
  const byPort = new Map()
  const r = {
    lookups: 0,
    set(port, meta) { byPort.set(port, meta) },
    async lookup({ port }) { r.lookups++; return byPort.get(port) ?? defaultMeta ?? null },
  }
  return r
}
