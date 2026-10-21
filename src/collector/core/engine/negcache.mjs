// negcache.mjs — the negative cache (RFC 4.6 §引擎 5, D37). A (pid, host) in it is never decrypted
// again: the engine splices it and says so in flows/. It does NOT tell the redirector: the kernel can
// only stop steering a whole process, and that would lose the hosts the process does trust.
// Two ways in:
//   observe — what a decrypted connection showed about our leaf (flow.mjs judges it, RFC 4.6 §引擎 5): rejected = the client
//     closed or reset with zero application data before or within the rejection window after our handshake; accepted = its
//     first byte of data, or still open when the window elapsed (counted then, not at close). An unused connection can still be
//     closed inside the window (Go drops an extra dial at once when its idle pool is full), so only `threshold` consecutive
//     rejections (default 2) make the key negative; an acceptance resets the count.
//   mark — the upstream's certificate did not verify (cause 'upstream-cert'): negative at once.
// Entries live in memory only, with no TTL. forgetPid drops a process's entries and half-way counts
// when it exits (the daemon calls engine.forgetPid on the exit event), so a reused pid inherits nothing.
// The key is (who, host). Who is the pid; a connection that came through the proxy ingress and whose pid could not be found says
// "<route>.<group>" itself, in meta.negKey (4.8 §5.5, W17): two forms with no pid never poison each other's hosts, and forgetKey drops
// one form's entries when the last process of it has gone.
const whoOf = (meta) => String(meta.negKey ?? meta.pid)
export const negKey = (meta, host) => `${whoOf(meta)}|${host}`

export function createNegativeCache({ threshold = 2, now = () => Date.now() } = {}) {
  const strikes = new Map()   // key → {negKey, n}: consecutive rejections so far
  const negative = new Map()  // key → {pid, negKey, agent, host, key, cause, rejections, at}
  const add = (key, cause, meta, host, rejections) => {
    negative.set(key, { pid: meta.pid, negKey: whoOf(meta), agent: meta.agent ?? null, host, key, cause, rejections, at: now() })
    return true
  }
  function forgetKey(who) {
    who = String(who)
    let dropped = 0
    for (const [k, e] of negative) if (e.negKey === who) { negative.delete(k); dropped++ }
    for (const [k, st] of strikes) if (st.negKey === who) strikes.delete(k)
    return dropped
  }
  return {
    has: (key) => negative.has(key),
    get: (key) => negative.get(key) ?? null,
    /** observe(key, {rejected, meta, host}) → true when this observation made the key negative. */
    observe(key, { rejected, meta, host }) {
      if (!rejected) { strikes.delete(key); return false }
      const n = (strikes.get(key)?.n || 0) + 1
      strikes.set(key, { negKey: whoOf(meta), n })
      if (n < threshold || negative.has(key)) return false
      return add(key, 'client-rejected-leaf', meta, host, n)
    },
    /** mark(key, {cause, meta, host}) → true when the key was not negative before. */
    mark(key, { cause, meta, host }) {
      if (negative.has(key)) return false
      return add(key, cause, meta, host, 1)
    },
    /** forgetKey(who) → how many negative entries were dropped (that key's half-way counts go too). `who` is "<pid>" or "<route>.<group>". */
    forgetKey,
    /** holds(who) → does the cache keep anything under `who`: an entry or a strike below the threshold (the daemon's sweep watches only such keys, 4.8 §5.5). */
    holds: (who) => { who = String(who); for (const e of negative.values()) if (e.negKey === who) return true; for (const st of strikes.values()) if (st.negKey === who) return true; return false },
    /** forgetPid(pid) → how many negative entries were dropped (that pid's half-way counts go too). */
    forgetPid: (pid) => forgetKey(pid),
    list: () => [...negative.values()],
    strikes: (key) => strikes.get(key)?.n || 0,
  }
}
