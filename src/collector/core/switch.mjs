// switch.mjs — the collector's on/off state machine (RFC 4.6 §开关语义). Two states are kept apart:
// `desired` is what the operator asked for, persisted in ~/.asight/collector/state.json (0600) so a
// restarted daemon restores it (S9); `actual` is ALWAYS read back from the kernel through the
// redirector (the helper reports the links the kernel still confirms) — never from a flag set here.
// When they disagree, report() says so. Recording follows the switch: off() clears it BEFORE the links
// come off, so a request that starts after off() returns is never written, even on a connection the
// engine keeps relaying until it closes (§开关「已有连接」). Errors are reported, never thrown.
import fs from 'node:fs'
import path from 'node:path'

// Decrypt policy (RFC 4.6 §引擎 解密策略, D40): the default is `all` — every host of a trusted agent process — so what an agent does
// besides calling the model is seen. `auto` (the known API hosts only) stays as an opt-down the operator chose.
// An install that never wrote a policy gets `all`; a state.json that already says `auto` keeps it: on disk an old default
// `auto` cannot be told from a chosen one, so what is written is respected.
const DEFAULT_STATE = { version: 1, desired: 'off', policy: 'all', extra_hosts: [] }

// An unreadable state file (not a missing one) is reported through onError and read as the default `off`.
export function readState(file, onError = () => {}) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      ...DEFAULT_STATE,
      desired: s.desired === 'on' ? 'on' : 'off',
      policy: s.policy === 'auto' ? 'auto' : 'all',
      extra_hosts: Array.isArray(s.extra_hosts) ? s.extra_hosts.filter((h) => typeof h === 'string') : [],
      updated_at: s.updated_at || null,
    }
  } catch (e) {
    if (e.code !== 'ENOENT') onError(e)
    return { ...DEFAULT_STATE }
  }
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
}

const sameHosts = (a, b) => a.length === b.length && a.every((h, i) => h === b[i])

export function createSwitch({ redirector, stateFile, ensureReady = async () => {}, onEvent = () => {} }) {
  let state = readState(stateFile, (e) => onEvent({ event: 'failure', where: 'state', code: e.code || 'state-unparsable', reason: `${stateFile} is unreadable (${String(e.message || e)}); the desired state reads as off until on/off rewrites it` }))
  let recording = false
  let degraded = null
  let actualCache = null
  let inFlight = 0 // on / off running: desired and actual legitimately differ until it returns (the 5 s check waits)

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

  async function report(extra = {}) {
    const a = await actual()
    actualCache = a.actual
    return { desired: state.desired, ...a, mismatch: a.actual !== state.desired, degraded, recording, policy: state.policy, extra_hosts: state.extra_hosts, ...extra }
  }

  function persist(next) {
    const changed = next.desired !== state.desired || next.policy !== state.policy || !sameHosts(next.extra_hosts, state.extra_hosts)
    if (changed) { state = { ...next, updated_at: new Date().toISOString() }; writeState(stateFile, state) }
    return changed
  }

  async function on(opts = {}) {
    const changed = persist({ ...state, desired: 'on', policy: opts.policy || state.policy, extra_hosts: opts.extra_hosts || state.extra_hosts })
    if (!changed && !degraded && actualCache === 'on' && (await actual()).actual === 'on') return report({ noop: true })
    try {
      await ensureReady()
      degraded = null
      await redirector.attach()
      recording = true
    } catch (e) {
      onEvent({ event: 'attach-failed', error: String((e && e.message) || e) })
    }
    const r = await report()
    onEvent({ event: 'switch', desired: 'on', actual: r.actual })
    return r
  }

  async function off() {
    recording = false
    let changed
    // D-8: the desired state that cannot be written never keeps the kernel steering — record it and detach anyway
    try { changed = persist({ ...state, desired: 'off' }) } catch (e) {
      changed = true
      onEvent({ event: 'failure', where: 'state', code: (e && e.code) || 'record-error', reason: `${stateFile} could not be written (${String((e && e.message) || e)}); detaching anyway, but the next start restores the old desired state` })
    }
    if (!changed && (degraded || (await actual()).actual === 'off')) return report({ noop: true })
    if (!degraded) {
      try { await redirector.detach() } catch (e) { onEvent({ event: 'detach-failed', error: String((e && e.message) || e) }) }
    }
    const r = await report()
    onEvent({ event: 'switch', desired: 'off', actual: r.actual })
    return r
  }

  async function restore() { return state.desired === 'on' ? on() : off() }
  const counted = (fn) => async (...a) => { inFlight++; try { return await fn(...a) } finally { inFlight-- } }

  return {
    restore: counted(restore), on: counted(on), off: counted(off), report,
    busy: () => inFlight > 0,
    isRecording: () => recording,
    markDown(reason) { degraded = { reason: String(reason) } },
    clearDown() { degraded = null },
    state: () => ({ ...state }),
  }
}
