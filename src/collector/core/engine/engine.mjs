// engine.mjs — the collector's TCP listener (RFC 4.6 §引擎). It accepts connections the platform
// redirector steered to it, asks the redirector who the peer is, and hands each known flow to
// handleFlow; unknown peers are dropped. close() stops accepting and waits for in-flight flows to
// finish rather than killing them (RFC 4.6 §开关: connections established while on keep relaying).
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
// timing (tests): {firstByteTimeoutMs, upstreamSlowMs, preludeStallMs} — the engine's waits, 5 s each by default.
// ingressToken: the install's ingress token (4.8 §3), required for listen({ingress}).
export function createEngine({ redirector, issuer, store, connectUpstream, upstreamCa, systemCa, policy = () => true, isRecording = () => true, retention = null, describe = () => ({}), onError = () => {}, onFailure = null, timing = {}, drainTimeoutMs, ingressToken = null }) {
  const counters = { active: 0, total: 0, decrypted: 0, spliced: 0, lookupMisses: 0, notCaptured: { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 0, leafError: 0 } }
  const servers = []
  const active = new Set()
  // every connection past the lookup: {agent, handle}; the handle is the flow's own (flow.mjs registers it), for drain() / relayed()
  const flows = new Set()
  const waiters = new Set() // drained() promises, checked whenever a flow ends
  // (pid, host) pairs the engine no longer tries to decrypt (RFC 4.6 §引擎 5). A hit is spliced and
  // labelled in flows/; the redirector is never told (the kernel can only stop a whole process).
  // Every write into it is a failure event (D-12, 4.6 §记录 负缓存写入): from then on this (pid, host) is spliced, not
  // captured, until the process exits (the daemon calls forgetPid and records the clearing).
  const neg = createNegativeCache()
  // neg_key: what the entry is keyed by — "<pid>", or "<route>.<group>" for a connection with no pid (4.8 §5.5)
  const negWritten = (made, key, o) => { if (made) { const e = neg.get(key); failure({ code: 'negative-cache', pid: e.pid ?? null, neg_key: e.negKey, agent: e.agent, host: e.host, cause: e.cause, reason: `${e.host} is no longer decrypted for ${e.pid != null ? `pid ${e.pid}` : e.negKey} (${e.cause}${e.rejections > 1 ? `, ${e.rejections} times in a row` : ''}); its connections there are passed through until ${e.pid != null ? 'it exits' : 'every process of that form has exited'}` }) } return made }
  // trust-rejected (D51④, 4.6 §事件与码): a critical failure at most once per (pid, host) in the process's life, the negative cache's bound; the
  // daemon's forgetPid ends it with the negative cache's entries (negative-cache-cleared, counted in `dropped` when it was not cached too)
  const rejectedOnce = new Set()
  const firstRejection = (key) => (rejectedOnce.has(key) ? false : (rejectedOnce.add(key), true))
  const forgetWho = (who) => {
    who = String(who)
    const cached = new Set(neg.list().filter((e) => e.negKey === who).map((e) => e.key))
    let only = 0
    for (const k of [...rejectedOnce]) if (k.slice(0, k.indexOf('|')) === who) { rejectedOnce.delete(k); if (!cached.has(k)) only++ }
    return neg.forgetKey(who) + only
  }
  const negCache = { ...neg, observe: (key, o) => negWritten(neg.observe(key, o), key, o), mark: (key, o) => negWritten(neg.mark(key, o), key, o) }
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

  async function onConnection(socket) {
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
    runFlow(socket, meta, connectUpstream || defaultConnect, duringLookup)
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
    ...timing, drainTimeoutMs, issuer, store, upstreamCa, upstreamTrust, policy, isRecording, retention, negCache, counters, failure, firstRejection,
    connectUpstream: connect,
    newFlowId: () => `flow_${String(++flowSeq).padStart(6, '0')}`,
  })
  // The one flow starter both doors use. `connect(dst)` is how this flow reaches its upstream (the transparent door: the
  // engine's; the ingress: its pre-dialled socket first, a re-dial after).
  function runFlow(socket, meta0, connect, duringLookup = null) {
    const meta = withExtras(meta0)
    counters.active++
    const ctx = flowCtx(connect)
    const entry = { agent: meta.agent ?? null, handle: null }
    flows.add(entry)
    ctx.register = (h) => { entry.handle = h }
    const gone = () => { flows.delete(entry); for (const w of [...waiters]) w() }
    let started
    try { started = handleFlow(socket, meta, ctx) } catch (e) { // a synchronous throw (e.g. net.connect on a bad port): this connection only
      onError(e); failure({ code: 'engine-error', pid: meta.pid ?? null, agent: meta.agent ?? null, dst: meta.dst, reason: String((e && e.message) || e) })
      socket.destroy(); counters.active--; gone(); return
    }
    const done = started.then((rec) => {
      if (rec && rec.decision === 'decrypt') counters.decrypted++
      else if (rec && rec.decision === 'splice') counters.spliced++
    }).catch((e) => { failure({ code: 'engine-error', pid: meta.pid ?? null, dst: meta.dst, reason: `handling the connection failed: ${String((e && e.message) || e)}` }); onError(e) }).finally(() => { active.delete(done); counters.active--; gone() })
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
      servePac: typeof redirector.servePac === 'function' ? (q) => redirector.servePac(q) : null, // GET /asight.pac on an auth:false door (4.11 P10)
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
        const srv = net.createServer(handler)
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

  async function close() {
    const closing = Promise.all(servers.map((s) => new Promise((res) => s.close(res))))
    if (ingress) ingress.closeIdle() // handshakes and health tunnels are not flows: nothing of an agent's is lost, and they would hold close() for their idle timeout
    await closing
    await Promise.allSettled([...active]) // let in-flight flows finish; never destroy them
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
  function drain({ agents = null, now = false } = {}) {
    const out = { closing: 0, waiting: 0, cut: 0 }
    for (const e of [...flows]) {
      if (!mine(e, agents) || !e.handle) continue
      let r
      try { r = e.handle.start({ now }) } catch (err) { failure({ code: 'engine-error', agent: e.agent, reason: `closing a connection after off failed: ${String((err && err.message) || err)}` }); onError(err); continue }
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
  // resolves once no connection of `agents` (null = all) is left in the engine, closing or not
  function drained({ agents = null } = {}) {
    return new Promise((resolve) => {
      const check = () => { if (![...flows].some((e) => mine(e, agents))) { waiters.delete(check); resolve() } }
      waiters.add(check); check()
    })
  }

  // negatives() is for status only; forgetPid(pid) is called by the daemon when that process exits; forgetNegKey(k) when the last process of a
  // form with no pid to key by has (4.8 §5.5).
  return { listen, closeGroups, close, stats, drain, relayed, drained, negatives: () => neg.list(), forgetPid: forgetWho, forgetNegKey: forgetWho }
}
