// src/query/router.mjs — the daemon's read route over three query services, one per worker role (RFC 3.5 §谁执行它「三个角色」, D78 ②).
//
// The names `rowFree` in QUERIES go to the light role, so they never wait behind an answer of the main worker: an answer in flight cannot be pre-empted.
// Any rejection while its caller has had no byte (a crash, a cooling subject, a `102`) puts the same request on the main role, with `rows: true` when it
// was a `102`. Not on the light role again: no main may be alive, and nobody else rebuilds a plaintext segment's stale index, so the main role forks and
// answers once its rows are read. A light worker that died idle sends these names to the main role for its cool-down. The board's control verbs are the control
// role's alone, never handed to another role: a verb in the OS's root prompt holds no read, and a verb whose worker died is not run again. All else is the main role's.
import { createQueryService, forkWorker } from './service.mjs'

/** → the shape of createQueryService's return. `fork(home, deps, role)`: forkWorker's arguments; the main role's fork gets the home alone. */
export function createQueryRouter({ fork = forkWorker, ...opts }) {
  const main = createQueryService({ ...opts, fork })
  const light = createQueryService({ ...opts, fork: (home) => fork(home, '', 'light'), handsOff: true })
  const ctl = createQueryService({ ...opts, fork: (home) => fork(home, '', 'control'), handsOff: true })
  let stopped = false
  const lightly = async (name) => !light.down() && !!(await import('./named/index.mjs')).QUERIES[name]?.rowFree
  const served = (call, nameOf) => async (a) => {
    if (!(await lightly(nameOf(a)))) return main[call](a)
    try { return await light[call](a) } catch (e) {
      if (stopped || a.res.headersSent || a.res.destroyed) throw e // after a stop, nothing may fork a worker nobody stops
      return main[call]({ ...a, rows: e.again === true })
    }
  }
  const stop = () => { stopped = true; ctl.stop(); light.stop(); main.stop() }
  return { ...main, relay: served('relay', (a) => a.name), route: served('route', (a) => a.query.get('name')), control: (a) => ctl.control(a), stop }
}
