// switch.mjs — the collector's on/off state machine (RFC 4.6 §开关语义). Two states are kept apart:
// `desired` is what the operator asked for, persisted in ~/.asight/collector/state.json (0600) so a
// restarted daemon restores it (S9); `actual` is ALWAYS read back from the kernel through the
// redirector (the helper reports the links the kernel still confirms) — never from a flag set here.
// When they disagree, report() says so. Recording follows the switch: off() clears it BEFORE the links
// come off, so a request that starts after off() returns is never written, even on a connection the
// engine keeps relaying until it closes (§开关「已有连接」). Errors are reported, never thrown.
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STATE = { version: 1, desired: 'off', policy: 'auto', extra_hosts: [] }

export function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      ...DEFAULT_STATE,
      desired: s.desired === 'on' ? 'on' : 'off',
      policy: s.policy === 'all' ? 'all' : 'auto',
      extra_hosts: Array.isArray(s.extra_hosts) ? s.extra_hosts.filter((h) => typeof h === 'string') : [],
      updated_at: s.updated_at || null,
    }
  } catch { return { ...DEFAULT_STATE } }
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

const sameHosts = (a, b) => a.length === b.length && a.every((h, i) => h === b[i])

export function createSwitch({ redirector, stateFile, ensureReady = async () => {}, onEvent = () => {} }) {
  let state = readState(stateFile)
  let recording = false
  let degraded = null
  let actualCache = null

  async function actual() {
    if (degraded) return { actual: 'off', links: [], hb_age_ms: null } // a dead helper's links died with it (never pinned)
    try {
      const s = await redirector.status()
      return { actual: s.attached ? 'on' : 'off', links: s.links || [], hb_age_ms: s.hb_age_ms ?? null }
    } catch (e) {
      if (degraded) return { actual: 'off', links: [], hb_age_ms: null } // the helper died while we asked
      return { actual: 'unknown', links: [], hb_age_ms: null, error: String((e && e.message) || e) }
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
    const changed = persist({ ...state, desired: 'off' })
    if (!changed && (degraded || (await actual()).actual === 'off')) return report({ noop: true })
    if (!degraded) {
      try { await redirector.detach() } catch (e) { onEvent({ event: 'detach-failed', error: String((e && e.message) || e) }) }
    }
    const r = await report()
    onEvent({ event: 'switch', desired: 'off', actual: r.actual })
    return r
  }

  async function restore() { return state.desired === 'on' ? on() : off() }

  return {
    restore, on, off, report,
    isRecording: () => recording,
    markDown(reason) { degraded = { reason: String(reason) } },
    clearDown() { degraded = null },
    state: () => ({ ...state }),
  }
}
