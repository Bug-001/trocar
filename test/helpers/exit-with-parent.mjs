// test/helpers/exit-with-parent.mjs — a preload (`node --import <this file> …`) that makes the process end when the process that started it is gone.
//
// A test starts processes that have to stay up until the test ends them (a stand-in for a daemon, a mock server, an agent). The test ends them itself (`finally { child.kill() }`), but
// when the runner is killed — SIGKILL leaves no `finally` and no `after` — they live on, parentless, for as long as nobody notices (six were found alive up to ten hours). A child
// whose parent died is reparented, so `process.ppid` changes; the watch below sees it and exits. `TROCAR_WATCH_PID` (set by `spawnStandin` / `watchEnv` in standin.mjs) names the process
// to watch instead, which also covers a parent that died before this ran and a child started through another process (`setpriv`, `sh`). The timer is unref'd: it keeps nothing
// alive that would have ended, and a stand-in that does nothing else keeps itself alive. `node --test` also runs this file as a test file; the unref'd timer ends it at once.
const first = process.ppid
const named = Number(process.env.TROCAR_WATCH_PID)
const watched = Number.isInteger(named) && named > 1 ? named : null
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const gone = () => process.ppid !== first || (watched !== null && !alive(watched))
if (watched !== null || first > 1) {
  if (gone()) process.exit(0)
  setInterval(() => { if (gone()) process.exit(0) }, 500).unref()
}
