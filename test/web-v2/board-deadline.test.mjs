// test/web-v2/board-deadline.test.mjs — 0.1 §3 约定 13: a real-browser test's browser has a hard deadline. withBoard over a stand-in
// browser that never answers (its process a real child in a process group of its own, as Playwright starts Chrome): when the deadline
// passes the group is killed, the hung call rejects, and stop() fails the test saying the browser did not answer. Not a real browser, so it
// runs in the plain unit suite.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { withBoard } from './browser/harness.mjs'

const groups = [] // every stand-in group, killed after the file whatever the case did (a red case leaves them running)
after(() => { for (const pid of groups) try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } })

// the stand-in: launch() starts a child (and a grandchild, as Chrome's renderers are) and resolves; every later call waits until the
// child is gone, then rejects as Playwright does for a closed browser
function standIn({ hangLaunch = false } = {}) {
  const kids = []
  return {
    kids,
    launch: async () => {
      const child = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e3)'], { stdio: 'ignore' }); setInterval(() => {}, 1e3)`], { detached: process.platform !== 'win32', stdio: 'ignore' })
      kids.push(child); groups.push(child.pid)
      const gone = new Promise((resolve) => child.once('exit', resolve))
      const hang = () => gone.then(() => { throw new Error('Target page, context or browser has been closed') })
      if (hangLaunch) return hang() // the launch itself never answers
      return { newContext: hang, contexts: () => [], close: async () => {}, on() {} }
    },
  }
}

for (const hangLaunch of [false, true]) test(`0.1 约定 13: a browser that never answers${hangLaunch ? ' (its launch)' : ''} is killed with its process group at the deadline, and the test fails saying so`, { skip: process.platform === 'win32' && 'process groups are POSIX', timeout: 20_000 }, async () => {
  const chromium = standIn({ hangLaunch }), t0 = Date.now()
  const err = await withBoard({ base: 'http://127.0.0.1:9/#t=x', chromium, deadline: 1000 }).then(() => null, (e) => e)
  assert.ok(err, 'withBoard over a browser that never answers does not resolve')
  assert.match(String(err.message), /browser did not answer in 1 s/)
  assert.ok(Date.now() - t0 < 10_000, `it failed ${Date.now() - t0} ms after it began`)
  const [child] = chromium.kids
  // the browser and its grandchild were one group: none of it is left (kill(-pgid, 0) fails with ESRCH) once the killed are reaped
  const groupLeft = () => { try { process.kill(-child.pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
  for (const t1 = Date.now(); groupLeft() && Date.now() - t1 < 3000;) await new Promise((r) => setTimeout(r, 50))
  assert.ok(child.pid && !groupLeft(), 'a process of the browser\'s group is left')
})
