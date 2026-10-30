// engine.mjs — the collector's TCP listener (RFC 4.6 §引擎). It accepts connections the platform
// redirector steered to it, asks the redirector who the peer is, and hands each known flow to
// handleFlow; unknown peers are dropped. close({graceMs}) is the stop barrier (RFC 1.6 §5.2): it stops accepting, closes each
// connection at a boundary within the grace, cuts the rest (`cut-by-stop`), and resolves once no flow is left.
//   drain({agents, now}) / relayed({agents}) / drained({agents}): what `off` asks of the connections still relayed (RFC 1.6 §1.3,
// engine/drain.mjs): close each at the boundary the engine can see, count what is still on its way out or waiting for its
// own close, cut everything on `now`, and say when none is left.
//   retention(proc, host, method, path) → {class, level} (D40, RFC 4.6 §记录「保存级别」): the daemon's callback — which
// traffic class a call is and how much of it to keep (`full` | `log`); sampled when the request starts. The core knows no
// harness and no pattern; absent = every call `full`.
//   describe(meta) → FlowExtras {wsTerminal, proxies} (Plan 3c §2): the daemon's per-process data
// (harness WS terminal patterns, the process's own proxies), merged into the flow's meta. Core knows no
// harness; it only reads that data.
import net from 'node:net'
import { handleFlow, writeRefusal } from './flow.mjs'
import { createIngress } from './ingress.mjs'
import { createNegativeCache } from './negcache.mjs'
import { createUpstreamTrust, systemRoots } from '../tls/roots.mjs'

// upstreamCa: extra CAs the engine trusts upstream (test seam); systemCa: stands in for the OS store
// (tests; undefined = read it): PEM text / array, or a systemRoots()-shaped {certs, errors}. The upstream trust set is built once (RFC 4.6 §引擎 5, tls/roots.mjs).
// timing (tests): {firstByteTimeoutMs, upstreamSlowMs, preludeStallMs} — the engine's waits, 5 s each by default; rejectWindowMs — the leaf
// rejection window (flow.mjs REJECT_WINDOW_MS, 10 s); slowEngineMs — past it from accepting a connection to our TLS server, a zero-data close before our
// handshake completes is recorded as engine-slow and counts toward the entry without trust-rejected (flow.mjs SLOW_ENGINE_MS, 2 s); now — the negative cache's clock (negcache.mjs retry_at).
// ingressToken: the install's ingress token (4.8 §3), required for listen({ingress}).
export function createEngine({ redirector, issuer, store, connectUpstream, upstreamCa, systemCa, policy = () => true, isRecording = () => true, retention = null, describe = () => ({}), onError = () => {}, onFailure = null, onHeld = () => {}, timing = {}, drainTimeoutMs, ingressToken = null }) {
  const counters = { active: 0, total: 0, decrypted: 0, spliced: 0, lookupMisses: 0, notCaptured: { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 0, leafError: 0 } }
  const servers = []
  const active = new Set()
  // every connection past the lookup: {agent, handle}; the handle is the flow's own (flow.mjs registers it), for drain() / relayed()
  const flows = new Set()
  const waiters = new Set() // drained() promises, checked whenever a flow ends
  // (pid, host) pairs the engine no longer tries to decrypt (RFC 4.6 §引擎 5). A hit is spliced and
  // labelled in flows/; the redirector is never told (the kernel can only stop a whole process).
  // Every write into it is a failure event (D-12, 4.6 §记录 负缓存写入): from then on this (pid, host) is spliced, not
  // captured, until its retry_at (negcache.mjs), or until the process exits (the daemon calls forgetPid and records the clearing).
  const neg = createNegativeCache({ now: timing.now })
  // neg_key: what the entry is keyed by — "<pid>", or "<route>.<group>" for a connection with no pid (4.8 §5.5)
  const negWritten = (made, key, o) => { if (made) { const e = neg.get(key); failure({ code: 'negative-cache', pid: e.pid ?? null, neg_key: e.negKey, agent: e.agent, host: e.host, cause: e.cause, retry_at: new Date(e.retry_at).toISOString(), reason: `${e.host} is no longer decrypted for ${e.pid != null ? `pid ${e.pid}` : e.negKey} (${e.cause}${e.rejections > 1 ? `, ${e.rejections} times in a row` : ''}); its connections there are passed through until ${new Date(e.retry_at).toISOString()}, then decrypted again` }) } return made }
  // onHeld(negKey): the cache now holds something under this key — a strike below the threshold or an entry — so whoever clears keys when their
  // process or door is gone (the daemon's sweep, 4.8 §5.5) watches it from the first rejection, not only from the first record
  const held = (o) => { try { onHeld(String(o.meta.negKey ?? o.meta.pid)) } catch (e) { onError(e) } }
  const negCache = { ...neg, observe: (key, o) => { if (o.rejected) held(o); return negWritten(neg.observe(key, o), key, o) }, mark: (key, o) => { held(o); return negWritten(neg.mark(key, o), key, o) } }
  let flowSeq = 0
  const defaultConnect = (dst) => net.connect(dst.port, dst.address)
  // A capture failure is never silent (D38, 4.6 §记录): one shaped record {event:'failure', where:'engine', code,
  // reason, …} the moment it happens, handed to onFailure — the daemon's failure recorder, which writes it to flows/
  // with its own descriptor, folded per where + code (core/events.mjs). The WebSocket recorder's go the same way
  // (where:'ws'). No sink wired is a wiring fault, reported through onError (stderr) instead of being dropped.
  function failure(rec) {
    const r = { event: 'failure', where: 'engine', ...rec }
    try {
      if (typeof onFailure !== 'function') throw Object.assign(new Error(`capture failure with nowhere to be recorded: ${r.where} ${r.code}: ${r.reason}`), { code: r.code })
      onFailure(r)
    } catch (e) { onError(e) }
  }
  const upstreamTrust = createUpstreamTrust({
    system: systemCa === undefined ? systemRoots()
      : Array.isArray(systemCa.certs) ? { sources: ['option:systemCa'], errors: [], ...systemCa }
        : { certs: [].concat(systemCa).map(String).filter((p) => p.includes('BEGIN CERTIFICATE')), sources: ['option:systemCa'], errors: [] },
    extra: upstreamCa,
  })
  // a trust-store source that is there but unreadable, or no OS store at all: the engine still verifies
  // against what it has, but upstreams signed by a CA only the missing part holds will step aside (D38)
  for (const error of upstreamTrust.errors) { onError(new Error(error)); failure({ code: 'trust-store-error', reason: error }) }
  if (upstreamTrust.missingSystem) {
    const error = 'no OS trust store found: upstreams signed by a system-only CA will step aside'
    onError(new Error(error)); failure({ code: 'system-roots-unavailable', reason: error })
  }

  // accepted sockets still in their redirector lookup (not flows yet): drained() waits for them too, and the stop destroys the ones its grace leaves
  const lookups = new Map() // promise → socket
  function onConnection(socket) {
    const p = accept(socket).finally(() => { lookups.delete(p); for (const w of [...waiters]) w() })
    lookups.set(p, socket)
  }
  async function accept(socket) {
    const acceptedAt = Date.now() // before the owner question: a slow lookup is the engine being slow (flow.mjs SLOW_ENGINE_MS)
    counters.total++
    // The accepted socket is ours from here. Until handleFlow attaches its own listeners (after the
    // lookup), a client reset would be an uncaughtException that takes the collector down (RFC 4.6
    // fail-open). handleFlow then sees the socket already destroyed and finalizes the flow.
    const duringLookup = () => {}
    socket.on('error', duringLookup)
    const peer = { address: socket.remoteAddress, port: socket.remotePort }
    let meta = null
    try { meta = await redirector.lookup(peer) }
    catch (e) { // the helper could not be asked: not a miss (4.6 §引擎 1, D38) — loader-timeout, or loader-down with its error
      const code = e && e.code === 'loader-timeout' ? 'loader-timeout' : 'loader-down'
      const detail = `${e && e.code && e.code !== code ? `${e.code}: ` : ''}${String((e && e.message) || e)}` // the helper's own errno stays in the text
      const reason = `looking up the original destination of ${peer.address}:${peer.port} failed (${detail}); the steered connection was closed`
      socket.destroy()
      failure({ code, peer, reason })
      onError(Object.assign(new Error(reason), { code }))
      return
    }
    // RFC 4.6 §引擎 1: no envelope, no connection row — but the connection is closed, so it is not silent (D38)
    if (!meta) {
      counters.lookupMisses++
      const reason = `no original destination for ${peer.address}:${peer.port}; the steered connection was closed`
      failure({ code: 'lookup-miss', peer, reason })
      socket.destroy()
      onError(Object.assign(new Error(reason), { code: 'lookup-miss' }))
      return
    }
    runFlow(socket, { ...meta, acceptedAt }, connectUpstream || defaultConnect, duringLookup)
  }

  // FlowExtras from the daemon, merged into the meta. A throw must not cost the agent its connection: the flow goes on with
  // none (fail-open: no WS patterns → fallback cut), and the throw is recorded (D38).
  function withExtras(meta) {
    try { return { ...meta, ...(describe(meta) || {}) } } catch (e) {
      onError(e)
      failure({ code: 'describe-error', pid: meta.pid ?? null, agent: meta.agent ?? null, dst: meta.dst, reason: String((e && e.message) || e) })
      return meta
    }
  }
  const flowCtx = (connect) => ({
    ...timing, drainTimeoutMs, issuer, store, upstreamCa, upstreamTrust, policy, isRecording, retention, negCache, counters, failure,
    connectUpstream: connect,
    newFlowId: () => `flow_${String(++flowSeq).padStart(6, '0')}`,
  })
  // The one flow starter both doors use. `connect(dst)` is how this flow reaches its upstream (the transparent door: the
  // engine's; the ingress: its pre-dialled socket first, a re-dial after).
  function runFlow(socket, meta0, connect, duringLookup = null) {
    const meta = withExtras(meta0)
    counters.active++
    const ctx = flowCtx(connect)
    // every failure of this flow names its agent (4.6, V30): the engine copies the door's meta, it does not branch on a harness
    if (meta.agent != null) ctx.failure = (rec) => failure(rec.agent === undefined ? { agent: meta.agent, ...rec } : rec)
    const entry = { agent: meta.agent ?? null, handle: null, socket }
    flows.add(entry)
    ctx.register = (h) => { entry.handle = h }
    const gone = () => { flows.delete(entry); for (const w of [...waiters]) w() }
    let started
    try { started = handleFlow(socket, meta, ctx) } catch (e) { // a synchronous throw (e.g. net.connect on a bad port): this connection only
      onError(e); failure({ code: 'engine-error', pid: meta.pid ?? null, agent: meta.agent ?? null, dst: meta.dst, reason: String((e && e.message) || e) })
      socket.destroy(); counters.active--; gone(); return
    }
    const done = started.then((rec) => {
      // outcomes, not plans: a row that kept its decision while nothing was forwarded (RFC 4.6 §记录 连接行怎么落码) — the upstream
      // failed before decrypting, or a side went during a wait — counts in neither
      if (!rec || rec.not_captured === 'error' || (rec.error && rec.error.wait)) return
      if (rec.decision === 'decrypt') counters.decrypted++
      else if (rec.decision === 'splice') counters.spliced++
    }).catch((e) => { ctx.failure({ code: 'engine-error', pid: meta.pid ?? null, dst: meta.dst, reason: `handling the connection failed: ${String((e && e.message) || e)}` }); onError(e) }).finally(() => { active.delete(done); counters.active--; gone() })
    active.add(done)
    if (duringLookup) socket.removeListener('error', duringLookup) // handleFlow's own listener has taken over
  }

  // The proxy ingress (4.8 §5.1): created on first listen({ingress}), where the token and the redirector's lookupIngress are known.
  let ingress = null
  function ingressDoor() {
    if (ingress) return ingress
    if (typeof redirector.lookupIngress !== 'function') throw new TypeError('listen({ingress}): this redirector has no lookupIngress')
    ingress = createIngress({
      token: ingressToken, timing,
      lookupIngress: (q) => redirector.lookupIngress(q),
      servePac: typeof redirector.servePac === 'function' ? (q) => redirector.servePac(q) : null, // GET /trocar.pac on an auth:false door (4.11 P10)
      ownerOfPeer: typeof redirector.ownerOfPeer === 'function' ? (p) => redirector.ownerOfPeer(p) : null, // who sent an opener the door cannot take (4.8 §5.1)
      connectUpstream: (dst) => (connectUpstream || defaultConnect)(dst),
      failure,
      // an ingress connection whose upstream refused or could not be reached never became a flow: its flows/ row is written here
      refuse: (meta, info) => writeRefusal(meta, flowCtx(connectUpstream || defaultConnect), info),
      handleFlow: (socket, meta, { upstream, redial }) => {
        // one upstream dial per agent connection: the ingress's pre-dialled socket the first time flow.mjs asks, a re-dial after that
        // (the 让路; none when the upstream carries credentials: flow.mjs closes the flow instead of sending them a second time)
        let first = true
        runFlow(socket, meta, () => { if (first) { first = false; return upstream } if (!redial) throw new Error('the upstream carries credentials: it is not dialled a second time'); return redial() })
      },
    })
    return ingress
  }

  // listen({port, hosts, ingress: {port}|null, groups}) → {port, ingressPort?, groupPorts?}
  //   port    the transparent listener (0 → the OS picks); skipped when the redirector has no `lookup` (Windows: no transparent rewrite)
  //   ingress the proxy ingress's own port, on the same hosts (4.8 §5.1); needs the redirector's lookupIngress and createEngine's ingressToken
  //   groups  the engine's own per-group proxy doors (D47, 4.9 §3): [{ id, port, auth, token }] — one loopback listener per entry group, answered
  //           by the same proxy ingress with that group's credentials (`token`; `auth:false` = the door takes none, the desktop-launcher shape).
  //           Binding is idempotent per group id (a door already bound is answered with its port, not bound again), so `attach()` may re-ask;
  //           closeGroups(ids) is the other half — a door the plan no longer carries stops accepting and is forgotten.
  // The first host binds first, then the rest reuse the resolved port, so 127.0.0.1 and ::1 share one.
  const boundGroups = new Map() // group id → { port, servers }: the doors this engine already listens on
  const accepted = new Set() // every socket a door accepted, until it closes: the stop closes what is left once the rows are written
  async function listen({ port = 0, hosts = ['127.0.0.1'], ingress: ing = null, groups = null } = {}) {
    const transparent = typeof redirector.lookup === 'function'
    const wanted = (groups || []).filter((g) => g && typeof g.id === 'string' && g.id !== '')
    if (!transparent && !ing && wanted.length === 0) throw new TypeError('listen: this redirector has no lookup and no ingress was asked for: nothing to listen on')
    const door = ing || wanted.length ? ingressDoor() : null
    const bind = (handler, wantedPort, label, sink = null) => new Promise((resolve, reject) => {
      let boundPort = wantedPort
      let i = 0
      const bindNext = () => {
        if (i >= hosts.length) { resolve(boundPort); return }
        const host = hosts[i++]
        const srv = net.createServer((sock) => { accepted.add(sock); sock.once('close', () => accepted.delete(sock)); handler(sock) })
        srv.once('error', reject)
        srv.listen(boundPort, host, () => {
          srv.removeListener('error', reject)
          // after listen (e.g. EMFILE on accept): recorded and reported, never an uncaught exception
          srv.on('error', (e) => { failure({ code: (e && e.code) || 'engine-error', reason: `the engine's ${label}listener on ${host}: ${String((e && e.message) || e)}` }); onError(e) })
          boundPort = srv.address().port; servers.push(srv); if (sink) sink.push(srv); bindNext()
        })
      }
      bindNext()
    })
    const out = { port: transparent ? await bind(onConnection, port, '') : null }
    if (door && ing) out.ingressPort = await bind(door.connection, ing.port ?? 0, 'ingress ')
    if (door && wanted.length) {
      out.groupPorts = {}
      for (const g of wanted) {
        const held = boundGroups.get(g.id)
        if (held) { out.groupPorts[g.id] = held.port; continue }
        if (!Number.isInteger(g.port) || g.port < 1 || g.port > 65535) throw new TypeError(`listen: the door of group ${JSON.stringify(g.id)} needs a TCP port, got ${typeof g.port === 'number' ? g.port : typeof g.port}`)
        const serversOfDoor = []
        const p = await bind((s) => door.connection(s, { user: g.id, token: g.token ?? null, open: g.auth === false }), g.port, `group ${g.id} door `, serversOfDoor)
        boundGroups.set(g.id, { port: p, servers: serversOfDoor })
        out.groupPorts[g.id] = p
      }
    }
    return out
  }

  // closeGroups(ids) → the ids closed (D47): each door stops ACCEPTING at once and is forgotten (a later listen binds it again); the
  // connections already accepted are not killed — they drain as ever, and the daemon's `off` drain (below) closes them where the engine
  // sees a boundary. A door nobody asked for is nobody's error.
  function closeGroups(ids) {
    const closed = []
    for (const id of ids || []) {
      const held = boundGroups.get(id)
      if (!held) continue
      boundGroups.delete(id)
      closed.push(id)
      for (const srv of held.servers) {
        const at = servers.indexOf(srv)
        if (at >= 0) servers.splice(at, 1)
        srv.close(() => {}) // a second close (engine.close below) is a no-op callback, never an 'error' event
      }
    }
    return closed
  }

  // close({graceMs, boundMs}) → {closing, waiting, cut}: the stop barrier (1.6 §5.2). Stop accepting; ask every connection to close where the engine
  // sees a boundary (as `off` does); wait for that up to graceMs; then cut what is left (rows say `cut-by-stop`), and destroy the client socket of
  // every connection still there — one in its lookup, one whose gate failed or threw — so none outlives the cut. Then wait for every cut flow's row and
  // envelopes, so what the stop writes after it (daemon-stop) comes after them; a flow that has still not ended `boundMs` later rejects close() with   // `stop-failed` (the stop records it and goes on: the stop is bounded, V99). closing / waiting: what the first ask found; cut: what the grace left.
  async function close({ graceMs = 2000, boundMs = 2000, who = null } = {}) { // who: the command stopping the daemon (update / uninstall), named in the cut rows
    let open = servers.length
    const closing = Promise.all(servers.map((s) => new Promise((res) => s.close(() => { open--; res() }))))
    if (ingress) ingress.closeIdle() // handshakes and health tunnels are not flows: nothing of an agent's is lost, and they would hold close() for their idle timeout
    const asked = drain({ agents: null })
    let timer = null
    await Promise.race([drained({ agents: null }), new Promise((r) => { timer = setTimeout(r, graceMs) })])
    clearTimeout(timer)
    const left = drain({ agents: null, now: true, by: 'stop', who })
    const cutNow = (e) => { try { const st = e.handle.state(); return st === 'cut' || st === 'closed' || st === 'done' } catch { return false } }
    left.cut += lookups.size + [...flows].filter((e) => !e.handle || !cutNow(e)).length // in its lookup, not yet a handle, or a gate that threw or failed open: the socket below cuts it
    for (const s of [...lookups.values(), ...[...flows].map((e) => e.socket)]) { try { s.destroy() } catch { /* already gone */ } }
    // the rows written, a socket still on a door carries no flow (off's FIN on a keep-alive the agent has not closed yet, a handshake): closed here
    const rest = (async () => { await Promise.allSettled([...lookups.keys()]); await Promise.allSettled([...active]); await drained({ agents: null }); for (const s of accepted) s.destroy(); await closing })()
    const late = await Promise.race([rest.then(() => false), new Promise((r) => { timer = setTimeout(() => r(true), boundMs) })])
    clearTimeout(timer)
    const unended = flows.size + lookups.size
    if (late && unended) throw Object.assign(new Error(`${unended} connection(s) had not ended ${boundMs} ms after the stop cut them; their rows may be missing`), { code: 'stop-failed' })
    if (late) throw Object.assign(new Error(`${open} listener(s) had not closed ${boundMs} ms after the stop although every connection was closed; no row is affected`), { code: 'stop-failed' })
    return { closing: asked.closing, waiting: asked.waiting, cut: left.cut }
  }

  function stats() {
    const storeErrors = store && typeof store.errors === 'number' ? store.errors : 0
    return { active: counters.active, total: counters.total, decrypted: counters.decrypted, spliced: counters.spliced, lookupMisses: counters.lookupMisses, storeErrors, notCaptured: { ...counters.notCaptured }, ...(ingress ? { ingress: ingress.stats() } : {}) }
  }

  // `off` (RFC 1.6 §1.3): every connection of `agents` (null = all) that is still relayed is asked to close where the engine can
  // see a boundary — an idle one at once, an HTTP one when its response has ended, a WebSocket one at the turn's terminal
  // message — or, on `now`, is cut. → {closing, waiting, cut}: still on its way out / waiting for its own close (a spliced
  // connection, a WebSocket whose turn end is not seen) / cut. Connections closed at once are in none of them.
  const mine = (e, agents) => !agents || agents.has(e.agent)
  function drain({ agents = null, now = false, by = 'off', who = null } = {}) {
    const out = { closing: 0, waiting: 0, cut: 0 }
    for (const e of [...flows]) {
      if (!mine(e, agents) || !e.handle) continue
      let r
      try { r = e.handle.start({ now, by, ...(who ? { who } : {}) }) } catch (err) { failure({ code: 'engine-error', agent: e.agent, reason: `closing a connection after off failed: ${String((err && err.message) || err)}` }); onError(err); continue }
      if (r === 'closing' || r === 'waiting' || r === 'cut') out[r]++
    }
    return out
  }
  // → {closing, waiting}: the connections of `agents` that off has asked to close and that are still relayed
  function relayed({ agents = null } = {}) {
    const out = { closing: 0, waiting: 0 }
    for (const e of flows) {
      if (!mine(e, agents) || !e.handle) continue
      const st = e.handle.state()
      if (st === 'closing' || st === 'waiting') out[st]++
    }
    return out
  }
  // resolves once no connection of `agents` (null = all, counting those still in their lookup) is left in the engine, closing or not
  function drained({ agents = null } = {}) {
    return new Promise((resolve) => {
      const check = () => { if (![...flows].some((e) => mine(e, agents)) && (agents || lookups.size === 0)) { waiters.delete(check); resolve() } } // all: a connection still in its lookup is one too
      waiters.add(check); check()
    })
  }

  // negatives() is for status only; forgetPid(pid) is called by the daemon when that process exits; forgetNegKey(k) when the last process of a
  // form with no pid to key by has (4.8 §5.5).
  return { listen, closeGroups, close, stats, drain, relayed, drained, negatives: () => neg.list(), forgetPid: neg.forgetKey, forgetNegKey: neg.forgetKey, holdsNegKey: neg.holds }
}
