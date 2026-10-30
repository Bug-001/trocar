// switch.mjs — the collector's on/off state machine, per harness (RFC 4.6 §开关语义, 1.6 §1.5, D39②). Two states are kept apart:
// `desired` is what the operator asked for, per harness, persisted in ~/.trocar/collector/state.json (0600, version 2, src/off/state.mjs)
// so a restarted daemon restores it (S9); `actual` is ALWAYS read back from the kernel through the redirector (the helper reports the
// links the kernel still confirms) — never from a flag set here. When they disagree, report() says so. The links are one per
// instance, not per harness: they stand while ANY harness is on and come off when the last one goes off; which processes are steered
// is the kernel watch table, which the daemon keeps through the `reconcile` hook (tracker.setEnabled + tracker.reconcile).
// Recording follows the switch, per harness: off clears it BEFORE the links come off, so a request that starts after off() returns is
// never written, even on a connection the engine keeps relaying until it closes (§开关「已有连接」). Errors are reported, never thrown.
//
// What the file may change under a running daemon (4.6: the daemon re-reads state.json before every heartbeat, by stat key): only ever
// what TAKES CAPTURE AWAY. reloadIfChanged() turns a harness off that the file says off (hook: unwatch its processes; none left on:
// detach), and never turns one on — links are attached only by an `on` request and at start (restore), because `trocar on` writes the
// desired state first and hangs the links last (1.6 R9): a daemon that attached on seeing the file would steer before the entries and the
// merged bundles are in place. The desired state of a harness the file says on but this daemon was not asked to turn on stays off here.
import fs from 'node:fs'
import { readStateFile, emptyState, setDesired, writeStateAtomic } from '../../off/state.mjs'

// Decrypt policy of a harness whose entry names none (RFC 4.6 §引擎 解密策略, D40): `all` — every host of a trusted agent process — so what an
// agent does besides calling the model is seen . `auto` (the known API hosts only) stays as an opt-down the operator chose.
// An install that never wrote a policy gets `all`; an entry that already says `auto` keeps it: on disk an old default `auto` cannot be
// told from a chosen one, so what is written is respected (src/off/state.mjs keeps `auto`, the version 1 migration too). One line: this one.
export const DEFAULT_POLICY = 'all'

const sameHosts = (a, b) => a.length === b.length && a.every((h, i) => h === b[i])
const withDefaults = (st) => ({ ...st, harnesses: Object.fromEntries(Object.entries(st.harnesses).map(([id, h]) => [id, { ...h, policy: h.policy ?? DEFAULT_POLICY, extra_hosts: h.extra_hosts ?? [] }])) })
// every entry and the top level say when (the board's "capture off since T" reads it); one that has no time yet gets `at`
const stamped = (st, at) => ({ ...st, updated_at: st.updated_at || at, harnesses: Object.fromEntries(Object.entries(st.harnesses).map(([id, h]) => [id, { ...h, updated_at: h.updated_at || at }])) })
const allOff = (ids) => withDefaults({ ...emptyState(), harnesses: Object.fromEntries(ids.map((id) => [id, { desired: 'off', updated_at: null }])) })

// A state file that is there and cannot be read is reported through onError and read as every installed harness `off` (a missing one
// is not an error: nothing is on). A version 1 file reads as version 2 for the installed harnesses (V28).
export function readState(file, onError = () => {}, { installed = [] } = {}) {
  try { return withDefaults(readStateFile(file, { installed }).state) } catch (e) { onError(e); return allOff(installed) }
}

export function writeState(file, state) { writeStateAtomic(file, state) }

export function createSwitch({ redirector, stateFile, known, installed = () => [], ensureReady = async () => {}, reconcile = null, onEvent = () => {} }) {
  const unreadable = (e) => onEvent({ event: 'failure', where: 'state', code: e.code || 'state-unparsable', reason: `${stateFile} is unreadable (${String((e && e.message) || e)}); the desired state reads as off until on/off rewrites it` })
  const keyOf = () => { try { const s = fs.statSync(stateFile); return `${s.ino}:${s.size}:${s.mtimeMs}` } catch (e) { return `gone:${(e && e.code) || 'error'}` } } // a rename (new inode), an edit or a removal changes it
  let diskKey = keyOf() // before the read: a change in between is seen by the next reload, never missed
  let dirty = false // the state in memory was made up because the file could not be read: the next on / off rewrites it
  let state = readState(stateFile, (e) => { dirty = true; unreadable(e) }, { installed: installed() })
  const recording = new Set() // harnesses whose requests are recorded now: set after a successful attach, cleared first thing at off
  let degraded = null
  let actualCache = null
  let inFlight = 0 // on / off / a reload running: desired and actual legitimately differ until it returns (the 5 s check waits)

  const desiredOf = (id) => (state.harnesses[id] && state.harnesses[id].desired === 'on' ? 'on' : 'off')
  // every walk starts from `known`, this daemon's own harness table (4.11 §3 ㉓): an id state.json holds outside it is never read, changed or reported
  const walked = () => known.filter((id) => installed().includes(id) || state.harnesses[id])
  const onIds = () => known.filter((id) => desiredOf(id) === 'on')
  const anyOn = () => onIds().length > 0
  const view = () => Object.fromEntries(walked().map((id) => { const h = state.harnesses[id]; return [id, { desired: desiredOf(id), policy: h ? h.policy : DEFAULT_POLICY, extra_hosts: h ? [...h.extra_hosts] : [], updated_at: h ? h.updated_at : null }] }))

  async function actual() {
    if (degraded) return { actual: 'off', links: [], hb_age_ms: null } // a dead helper's links died with it (never pinned)
    try {
      const s = await redirector.status()
      return { actual: s.attached ? 'on' : 'off', links: s.links || [], hb_age_ms: s.hb_age_ms ?? null, drops: s.drops ?? null } // drops: protocol 2 (D-16)
    } catch (e) {
      if (degraded) return { actual: 'off', links: [], hb_age_ms: null } // the helper died while we asked
      return { actual: 'unknown', links: [], hb_age_ms: null, error: String((e && e.message) || e), ...(e && e.code ? { error_code: e.code } : {}) }
    }
  }

  // desired: 'on' when any harness is on — what the links are for; the harnesses carry their own
  async function report(extra = {}) {
    const a = await actual()
    actualCache = a.actual
    const desired = anyOn() ? 'on' : 'off'
    return { desired, ...a, mismatch: a.actual !== desired, degraded, recording: recording.size > 0, harnesses: view(), ...extra }
  }

  // Writes `next` (every entry stamped); `tolerate`: the write may fail without failing the request (off, D-8) — it is recorded.
  function commit(next, { tolerate = false } = {}) {
    const out = stamped(withDefaults(next), new Date().toISOString())
    try { writeState(stateFile, out); diskKey = keyOf(); dirty = false } catch (e) {
      if (!tolerate) throw e
      onEvent({ event: 'failure', where: 'state', code: (e && e.code) || 'record-error', reason: `${stateFile} could not be written (${String((e && e.message) || e)}); detaching anyway, but the next start restores the old desired state` })
    }
    state = out
  }

  // The hook that brings the kernel watch table to the state just reached (the daemon: tracker.reconcile). Runs while the links still
  // stand; what it returns ({unwatched, failed}) is handed back to the caller. A hook that throws never stops the links coming off.
  // A reload calls it only when it took something away; an `off` request always does, so that repeating it confirms (and retries) the table.
  async function runReconcile(turnedOff, { always = false } = {}) {
    if (!reconcile || (!always && !turnedOff.length)) return {}
    try { return (await reconcile({ turnedOff: [...turnedOff] })) || {} } catch (e) {
      onEvent({ event: 'failure', where: 'switch', code: (e && e.code) || 'unwatch-error', reason: `the processes of ${turnedOff.join(', ')} could not be taken out of the kernel watch table (${String((e && e.message) || e)}); the links come off anyway if none is left on` })
      return { failed: [null] }
    }
  }
  const detachIfNoneOn = async () => {
    if (anyOn() || degraded) return
    try { await redirector.detach() } catch (e) { onEvent({ event: 'detach-failed', error: String((e && e.message) || e) }) }
  }

  // The file may have changed under us (the CLI wrote a harness off): take away what it takes away, adopt policy edits, and attach
  // nothing — see the head of this file. `changed` says the file was read again (its stat key moved), not that anything was taken.
  let reloading = Promise.resolve()
  async function reload() {
    const key = keyOf()
    if (key === diskKey) return { changed: false, turnedOff: [] }
    diskKey = key
    const fresh = readState(stateFile, (e) => { dirty = true; unreadable(e) }, { installed: installed() })
    const turnedOff = onIds().filter((id) => !(fresh.harnesses[id] && fresh.harnesses[id].desired === 'on'))
    const was = state
    // a harness the file says on is kept off here until an `on` request: the file never attaches
    state = { ...fresh, harnesses: Object.fromEntries(Object.entries(fresh.harnesses).map(([id, h]) => [id, { ...h, desired: h.desired === 'on' && was.harnesses[id] && was.harnesses[id].desired === 'on' ? 'on' : 'off' }])) }
    for (const id of turnedOff) if (!state.harnesses[id]) state.harnesses[id] = { ...was.harnesses[id], desired: 'off' }
    for (const id of turnedOff) recording.delete(id) // first: nothing begun after this is recorded
    if (turnedOff.length) {
      await runReconcile(turnedOff)
      await detachIfNoneOn()
      const r = await report()
      onEvent({ event: 'switch', desired: r.desired, actual: r.actual, harnesses: turnedOff, reason: `${stateFile} turned off ${turnedOff.join(', ')}: capture of ${turnedOff.length === 1 ? 'it' : 'them'} stops${anyOn() ? '' : ', and the links come off because no harness is left on'}` })
    }
    return { changed: true, turnedOff }
  }
  const reloadIfChanged = () => (reloading = reloading.then(counted(reload), counted(reload))) // one at a time: the heartbeat gate and a request may both ask

  // `on` of the named harnesses (none named: every installed one, `installed()`). The request that follows the CLI's write is what attaches.
  function planOn(ids, o) {
    const flip = ids.filter((id) => desiredOf(id) !== 'on')
    const next = setDesired(state, flip, 'on', new Date())
    let changed = flip.length > 0
    for (const id of ids) {
      const h = { policy: DEFAULT_POLICY, extra_hosts: [], ...next.harnesses[id] }
      const policy = o.policy === undefined ? h.policy : o.policy === 'all' ? 'all' : 'auto'
      const hosts = Array.isArray(o.extra_hosts) ? o.extra_hosts.filter((x) => typeof x === 'string') : h.extra_hosts
      if (policy !== h.policy || !sameHosts(hosts, h.extra_hosts)) { next.harnesses[id] = { ...h, policy, extra_hosts: hosts }; changed = true }
    }
    return { next, changed }
  }

  async function on({ harnesses = null, policy, extra_hosts } = {}) {
    await reloadIfChanged() // what the disk took away since is gone before this asks for anything
    const ids = harnesses ? [...new Set(harnesses)] : installed()
    const { next, changed } = planOn(ids, { policy, extra_hosts })
    if (changed || dirty) commit(next) // throws: the request fails and nothing here changed
    if (!anyOn()) return report({ noop: true }) // nothing named, nothing on: nothing to attach
    if (!changed && !degraded && actualCache === 'on' && ids.every((id) => recording.has(id)) && (await actual()).actual === 'on') return report({ noop: true })
    try {
      await ensureReady()
      degraded = null
      await redirector.attach()
      for (const id of onIds()) recording.add(id)
    } catch (e) {
      onEvent({ event: 'attach-failed', error: String((e && e.message) || e) })
    }
    const r = await report()
    onEvent({ event: 'switch', desired: r.desired, actual: r.actual })
    return r
  }

  // `off` of the named harnesses (none named: all). Order: recording stops, the desired state is written, the kernel watch table is
  // brought to it (the hook), and only then — when no harness is left on — the links come off (1.6 §1.5).
  async function off({ harnesses = null } = {}) {
    await reloadIfChanged()
    const ids = harnesses ? [...new Set(harnesses)] : walked()
    const turned = ids.filter((id) => desiredOf(id) === 'on')
    for (const id of ids) recording.delete(id)
    const changed = turned.length > 0
    if (changed || dirty) commit(setDesired(state, turned, 'off', new Date()), { tolerate: true }) // D-8: the state that cannot be written never keeps the kernel steering
    const hooked = await runReconcile(turned, { always: true })
    const extra = { unwatched: hooked.unwatched || [], unwatch_failed: hooked.failed || [] }
    if (!changed && (anyOn() || degraded || (await actual()).actual === 'off')) return report({ noop: true, ...extra })
    await detachIfNoneOn()
    const r = await report(extra)
    onEvent({ event: 'switch', desired: r.desired, actual: r.actual })
    return r
  }

  // At start: what the file says on is turned on (attach, last); with nothing on the kernel is only confirmed off — a fresh helper starts
  // detached — and nothing is written, so an unreadable file stays for the operator to look at until an on / off rewrites it.
  async function restore() {
    if (anyOn()) return on({ harnesses: onIds() })
    if (degraded || (await actual()).actual === 'off') return report({ noop: true })
    await detachIfNoneOn()
    const r = await report()
    onEvent({ event: 'switch', desired: r.desired, actual: r.actual })
    return r
  }
  function counted(fn) { return async (...a) => { inFlight++; try { return await fn(...a) } finally { inFlight-- } } }

  return {
    restore: counted(restore), on: counted(on), off: counted(off), report, reloadIfChanged,
    busy: () => inFlight > 0,
    isRecording: (agent) => agent != null && recording.has(agent) && desiredOf(agent) === 'on',
    desiredOf, anyOn, enabled: () => new Set(onIds()),
    markDown(reason) { degraded = { reason: String(reason) } },
    clearDown() { degraded = null },
    state: () => ({ ...state, harnesses: Object.fromEntries(Object.entries(state.harnesses).map(([id, h]) => [id, { ...h, extra_hosts: [...h.extra_hosts] }])) }),
  }
}
