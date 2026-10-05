// negcache.mjs — the negative cache (RFC 4.6 §引擎 5, D37). A (pid, host) in it is never decrypted
// again: the engine splices it and says so in flows/. It does NOT tell the redirector: the kernel can
// only stop steering a whole process, and that would lose the hosts the process does trust.
// Two ways in:
//   observe — a decrypted connection ended. The client refused our leaf when it closed or reset with
//     zero application data, alert or not (Node / Bun send none: under TLS 1.3 we see a reset, under
//     TLS 1.2 the handshake completes and the client hangs up). A pooled connection that was never
//     used looks the same, so only `threshold` consecutive rejections (default 2) make the key
//     negative; a connection that carried data resets the count.
//   mark — the upstream's certificate did not verify (cause 'upstream-cert'): negative at once.
// Entries live in memory only, with no TTL. forgetPid drops a process's entries and half-way counts
// when it exits (the daemon calls engine.forgetPid on the exit event), so a reused pid inherits nothing.
export const negKey = (meta, host) => `${meta.pid}|${host}`

export function createNegativeCache({ threshold = 2, now = () => Date.now() } = {}) {
  const strikes = new Map()   // key → {pid, n}: consecutive rejections so far
  const negative = new Map()  // key → {pid, agent, host, key, cause, rejections, at}
  const add = (key, cause, meta, host, rejections) => {
    negative.set(key, { pid: meta.pid, agent: meta.agent ?? null, host, key, cause, rejections, at: now() })
    return true
  }
  return {
    has: (key) => negative.has(key),
    get: (key) => negative.get(key) ?? null,
    /** observe(key, {rejected, meta, host}) → true when this observation made the key negative. */
    observe(key, { rejected, meta, host }) {
      if (!rejected) { strikes.delete(key); return false }
      const n = (strikes.get(key)?.n || 0) + 1
      strikes.set(key, { pid: meta.pid, n })
      if (n < threshold || negative.has(key)) return false
      return add(key, 'client-rejected-leaf', meta, host, n)
    },
    /** mark(key, {cause, meta, host}) → true when the key was not negative before. */
    mark(key, { cause, meta, host }) {
      if (negative.has(key)) return false
      return add(key, cause, meta, host, 1)
    },
    /** forgetPid(pid) → how many negative entries were dropped (that pid's half-way counts go too). */
    forgetPid(pid) {
      let dropped = 0
      for (const [k, e] of negative) if (e.pid === pid) { negative.delete(k); dropped++ }
      for (const [k, s] of strikes) if (s.pid === pid) strikes.delete(k)
      return dropped
    },
    list: () => [...negative.values()],
    strikes: (key) => strikes.get(key)?.n || 0,
  }
}
