// user-procs.mjs (src/off) — the asight processes the USER started themselves, read off a process table (1.6 §1.4). Its own file because the three
// commands that report them (`off` and `uninstall`, which also undo things, and read-only `status`) must not load each other's graph for it: it is a
// pure function of a table, and importing it through ./orchestrate.mjs pulled that module's whole undo machinery into `status` (27 ms of module load
// on a Mac, more on Windows — D62, 1.6 §3.1). Imports nothing.
const USER_VERBS = { serve: 'a read-only dashboard, not on any agent path', capture: 'capturing in the foreground, it may be relaying agent traffic', mitm: 'capturing in the foreground, it may be relaying agent traffic' }
/** The asight processes the user started themselves (`asight serve`, a foreground `capture` / `mitm`): listed, never killed (1.6 §1.4). */
export function userProcessesOf(list, selfPid = process.pid) {
  const out = []
  for (const p of list || []) {
    const argv = Array.isArray(p.argv) ? p.argv : []
    const i = argv.findIndex((a) => /(^|\/)asight(\.mjs)?$/.test(String(a)))
    const verb = i >= 0 ? argv[i + 1] : null
    if (verb && Object.hasOwn(USER_VERBS, verb) && p.pid !== selfPid) out.push({ pid: p.pid, command: `asight ${verb}`, note: USER_VERBS[verb] })
  }
  return out
}
