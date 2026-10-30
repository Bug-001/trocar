// negcache.mjs — the negative cache (RFC 4.6 §引擎 5, D37). A (pid, host) in it is not decrypted until its retry time: the
// engine splices it and says so in flows/. It does NOT tell the redirector: the kernel can only stop steering a whole process,
// and that would lose the hosts the process does trust.
// Two ways in:
//   observe — what a decrypted connection showed about our leaf (flow.mjs judges it, RFC 4.6 §引擎 5): rejected = the client
//     closed or reset with zero application data before or within the rejection window after our handshake; accepted = its
//     first byte of data (used), or still open when the window elapsed (counted then, not at close). An unused connection can
//     still be closed inside the window (Go drops an extra dial at once when its idle pool is full), so only `threshold`
//     consecutive rejections (default 2) make the key negative; an acceptance resets the count.
//   mark — a single decisive answer (the upstream's certificate did not verify, a certificate alert): negative at once.
// Lifetime: entries live in memory only. Each carries retry_at = at + min(retryMs · 2^renewals, retryMaxMs); renewals = how
// many times this key was made negative before. Expiry is lazy (has / get / list drop an entry at retry_at; no timer) and
// leaves the key on probation: its strikes stand at threshold − 1, so one rejection renews it with the doubled backoff.
// Application data on the key clears its history (the next entry starts at retryMs again) and records the key as one whose
// client has accepted our leaf (trusts). forgetPid drops a process's entries, counts, history and trusted marks when it exits
// (the daemon calls engine.forgetPid on the exit event), so a reused pid inherits nothing.
// The key is (who, host). Who is the pid; a connection that came through the proxy ingress and whose pid could not be found says
// "<route>.<group>" itself, in meta.negKey (4.8 §5.5, W17): two forms with no pid never poison each other's hosts, and forgetKey drops
// one form's entries when the last process of it has gone.
const whoOf = (meta) => String(meta.negKey ?? meta.pid)
export const negKey = (meta, host) => `${whoOf(meta)}|${host}`
export const NEG_RETRY_MS = 600_000
export const NEG_RETRY_MAX_MS = 3_600_000

export function createNegativeCache({ threshold = 2, now = () => Date.now(), retryMs = NEG_RETRY_MS, retryMaxMs = NEG_RETRY_MAX_MS, trustedMax = 4096 } = {}) {
  const strikes = new Map()   // key → {negKey, n}: consecutive rejections so far
  const negative = new Map()  // key → entry (see add)
  const history = new Map()   // key → {negKey, n}: how many times the key was made negative; outlives expiry
  const trusted = new Map()   // key → who, insertion order, at most trustedMax
  const live = (key) => {
    const e = negative.get(key)
    if (!e || now() < e.retry_at) return e ?? null
    negative.delete(key); strikes.set(key, { negKey: e.negKey, n: threshold - 1 })
    return null
  }
  const add = (key, cause, meta, host, rejections, alert = null) => {
    const who = whoOf(meta), renewals = history.get(key)?.n || 0, at = now()
    history.set(key, { negKey: who, n: renewals + 1 })
    negative.set(key, { pid: meta.pid, negKey: who, agent: meta.agent ?? null, host, key, cause, rejections, at,
      retry_at: at + Math.min(retryMs * 2 ** renewals, retryMaxMs), renewals, ...(alert ? { alert } : {}) })
    return true
  }
  function forgetKey(who) {
    who = String(who)
    let dropped = 0
    for (const [k, e] of negative) if (e.negKey === who) { negative.delete(k); dropped++ }
    for (const m of [strikes, history]) for (const [k, st] of m) if (st.negKey === who) m.delete(k)
    for (const [k, w] of trusted) if (w === who) trusted.delete(k)
    return dropped
  }
  return {
    has: (key) => live(key) !== null,
    get: live,
    /** observe(key, {rejected, meta, host, used}) → true when this observation made the key negative. used = application data was seen. */
    observe(key, { rejected, meta, host, used = false }) {
      if (!rejected) {
        strikes.delete(key)
        if (used) {
          history.delete(key)
          trusted.delete(key); trusted.set(key, whoOf(meta))
          if (trusted.size > trustedMax) trusted.delete(trusted.keys().next().value)
        }
        return false
      }
      if (live(key)) return false
      const n = (strikes.get(key)?.n || 0) + 1
      strikes.set(key, { negKey: whoOf(meta), n })
      return n >= threshold && add(key, 'client-rejected-leaf', meta, host, n)
    },
    /** mark(key, {cause, meta, host, alert}) → true when the key was not negative before. */
    mark(key, { cause, meta, host, alert = null }) {
      if (live(key)) return false
      return add(key, cause, meta, host, 1, alert)
    },
    /** trusts(key) → has this (who, host) sent application data on a decrypted connection (it accepted our leaf there). */
    trusts: (key) => trusted.has(key),
    /** forgetKey(who) → how many negative entries were dropped (that who's half-way counts, history and trusted marks go too). `who` is "<pid>" or "<route>.<group>". */
    forgetKey,
    /** holds(who) → does the cache keep anything under `who`: an entry, a strike below the threshold or renewal history (the daemon's sweep watches only such keys, 4.8 §5.5). */
    holds: (who) => { who = String(who); for (const m of [negative, strikes, history]) for (const e of m.values()) if (e.negKey === who) return true; return false },
    /** forgetPid(pid) → how many negative entries were dropped (that pid's half-way counts go too). */
    forgetPid: (pid) => forgetKey(pid),
    list: () => [...negative.keys()].map(live).filter(Boolean),
    strikes: (key) => strikes.get(key)?.n || 0,
  }
}
