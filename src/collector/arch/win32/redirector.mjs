// redirector.mjs — the Windows implementation of the Redirector contract (RFC 4.8 §1; core/redirector.mjs says what core asks of an arch adapter). Windows has no kernel that steers connections to the engine
// and no event for "a process started", so what the Linux adapter gets from the kernel this one has from three places: the process snapshot (`procinfo.mjs`: `exec` / `exit` by difference, `facts-update` when a
// command line arrives late), the form tables of the harness files (`forms.mjs`: which form a process is), and the verdicts the tracker pushes through `watch(pid, { decrypt })` (the table 4.8 §5.4 judges by).
// This file is the first part: the process table. It reads the helper's answers through the watcher it is given and writes nothing; it names no harness (arch/ never imports harness/: the daemon hands the groups in).
//
// The table holds EVERY process of this session, not only the agents': a form with no process rule in the kernel (a program that is every Node program of the machine) takes every connection of its port, and the
// connection's owner may be any process (4.8 §3.5), so who owns it can only be told against all of them. What the table says about each is the answer of `matchForm`:
//   { kind: 'form', id }                 a process of that form · { kind: 'pending', forms }   its command line is not known yet (the watcher says again, `facts-update`) · { kind: 'path-unknown', forms, shape } · { kind: 'none' }
import { EventEmitter } from 'node:events'
import { HELPER_PROTO } from './helper.mjs'
import { matchForm } from './forms.mjs'

/**
 * createWin32Redirector({ helper, procWatcher, groups, home }) → the Redirector (an EventEmitter)
 *   helper       the started helper client (helper.mjs `startHelper`): its `ready` line and `pid` answer `start()` / `helperInfo()`, and `close()` closes it
 *   procWatcher  `createProcWatcher()`: the redirector subscribes to its events in this call, so none is lost between the two
 *   groups       `groupsOf(descriptors)` (route-plan.mjs): `[{ g, harness, group, forms, proxy }]`, the harness files' Windows data
 *   home         the user's profile directory (`%USERPROFILE%`): `form-path-unknown` masks the user's name wherever the profile is (forms.mjs `formPathShape`)
 * Events: 'exec' ProcFacts · 'exit' {pid, startedAt} · 'facts-update' ProcFacts (a command line that was not known yet is, or was given up on) · 'facts-error' (a process whose image cannot be read) — the watcher's, passed on after
 *   the table has taken them in, so a listener that asks the table finds the process there · 'helper-error' {reason, code, …} (the watcher's `poll-error`: the helper failed, or a listener threw) ·
 *   'form-exit' {form, neg_key} (the last process of a form is gone: the engine forgets that form's negative-cache entries, 4.8 §5.5).
 */
export function createWin32Redirector({ helper, procWatcher, groups, home = null } = {}) {
  if (!procWatcher || typeof procWatcher.on !== 'function') throw new TypeError('createWin32Redirector needs the process watcher (procinfo.mjs createProcWatcher)')
  if (!Array.isArray(groups)) throw new TypeError('createWin32Redirector needs the groups (route-plan.mjs groupsOf)')
  const ev = new EventEmitter()
  const forms = groups.flatMap((x) => x.forms) // in the order the harness files list them: matchForm tries a shared image's forms in that order
  const procs = new Map() // pid → { exe, ppid, startedAt, elevated, match, seq }
  const verdicts = new Map() // pid → { decrypt, agent }: what the tracker judged (4.8 §5.4); a process it has not judged has none, which is "not trusted"
  let seq = 0
  let info = { pid: null, proto: null, build: null }

  function ingest(facts) {
    const match = matchForm(forms, { exe: facts.exe, cmdline: facts.cmdline, cmdlineState: facts.cmdlineState }, { home })
    procs.set(facts.pid, { exe: facts.exe ?? null, ppid: facts.ppid ?? null, startedAt: facts.startedAt ?? null, elevated: facts.elevated ?? null, match, seq: ++seq })
  }
  const pidsOf = (form) => [...procs].filter(([, p]) => p.match.kind === 'form' && p.match.id === form).map(([pid]) => pid)
  /** Forgets a process and its verdict; says `form-exit` when it was the last process of its form (after any `exit` the caller passes on, so a listener of both sees the process leave first). */
  function drop(pid, { then = () => {} } = {}) {
    const p = procs.get(pid)
    procs.delete(pid)
    verdicts.delete(pid)
    then()
    if (p && p.match.kind === 'form' && pidsOf(p.match.id).length === 0) ev.emit('form-exit', { form: p.match.id, neg_key: `of.${p.match.id}` })
  }

  procWatcher.on('exec', (facts) => { ingest(facts); ev.emit('exec', facts) })
  procWatcher.on('facts-update', (facts) => { ingest(facts); ev.emit('facts-update', facts) })
  procWatcher.on('exit', (x) => drop(x.pid, { then: () => ev.emit('exit', x) }))
  procWatcher.on('facts-error', (x) => ev.emit('facts-error', x))
  procWatcher.on('poll-error', (x) => ev.emit('helper-error', { ...x, code: x.cause ?? x.code ?? 'helper-error' }))

  return Object.assign(ev, {
    /** Waits for the helper's ready line (its protocol, its PowerShell), then takes the process baseline. Rejects when the helper never starts: that failure is already recorded by the helper's own sink. */
    async start() {
      const ready = helper && helper.ready ? await helper.ready : null
      info = { pid: (helper && helper.pid) ?? (ready && ready.pid) ?? null, proto: ready ? ready.proto ?? null : null, build: ready ? ready.ps ?? null : null }
      await procWatcher.start()
      return info
    },
    /** Stops the watcher and closes the helper (the daemon's stop). Nothing is steered on Windows, so there is nothing to leave direct: closing the helper is all of it. */
    async close() {
      procWatcher.stop()
      if (helper && typeof helper.close === 'function') await helper.close()
    },
    heartbeat() {}, // nothing is gated on a heartbeat: when the engine is gone the kernel falls back on its own health check (4.8 §3.3)
    helperInfo: () => ({ ...info }),
    expectedProto: HELPER_PROTO,

    /** The live processes of this session as facts; the table is taken from them: a process that was in it, is not in the scan, and was not seen after the scan began has gone (a process that started after the
     *  scan's own snapshot is an `exec` and stays). */
    async scan() {
      const begun = seq
      const live = await procWatcher.scan()
      const seen = new Set()
      for (const f of live) { seen.add(f.pid); ingest(f) }
      for (const [pid, p] of [...procs]) if (!seen.has(pid) && p.seq <= begun) drop(pid)
      return live
    },
    unreadable: () => procWatcher.unreadable(),

    /** The tracker's verdict for a process (4.8 §5.4: the decrypt table): `decrypt` true only for one it confirmed trusts asight's CA. */
    watch(pid, verdict) { verdicts.set(pid, { decrypt: !!(verdict && verdict.decrypt === true), agent: (verdict && verdict.agent) || null }) },
    unwatch(pid) { verdicts.delete(pid) },
    verdictOf: (pid) => (verdicts.has(pid) ? { ...verdicts.get(pid) } : null),

    /** The pids of the processes that are `form` (the live ones the table has taken in), and what `planRoutes` takes as `procs`: `[{ pid, match, elevated }]` for every process that is, or might be, a form's. */
    pidsOf,
    procs: () => [...procs].filter(([, p]) => p.match.kind !== 'none').map(([pid, p]) => ({ pid, match: p.match, elevated: p.elevated })),
  })
}
