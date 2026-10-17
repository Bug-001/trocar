// test/collector/arch/darwin/accept-async.test.mjs — the darwin daemon's accept path runs lsof / ps through execFile (src/off/exec.mjs runAsync),
// so socktable's 250 ms budget really races a slow lsof and one slow lookup does not hold a second door connection's. Real child processes: a stub
// `lsof` in the temp dir (the only tools npm test lets run, 0.1 §3) that answers after 2 s, and one that answers at once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { execTool, runAsync } from '../../../../src/off/exec.mjs'
import { ownerOfSocket } from '../../../../src/collector/arch/darwin/socktable.mjs'
import { factsOfPid } from '../../../../src/collector/arch/darwin/procinfo.mjs'

function stubs(slowMs) {
  const dir = tmpDir('asight-lsof-')
  const sh = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f }
  // the slow one answers the 50001 peer after slowMs; any other peer at once, with the holder pid 777
  sh('lsof', `case "$*" in *:50001*) sleep ${slowMs / 1000};; esac\nprintf 'p777\\nn127.0.0.1:%s->127.0.0.1:1\\n' "$(echo "$*" | sed 's/.*://')"`)
  sh('ps', `sleep ${slowMs / 1000}; printf '  777     1   501 x Mon Oct  5 17:00:00 2026     /bin/x\\n'`)
  return { PATH: `${dir}:/bin:/usr/bin` }
}

test('a slow lsof does not block a second door connection\'s lookup — the budget wins and the other peer is answered meanwhile', async () => {
  // a 1 s budget (the daemon uses 250 ms): a cold shell under a loaded full run must still answer the fast peer inside it
  const env = { ...process.env, ...stubs(2000) }
  const exec = (file, args, o = {}) => execTool(file, args, { ...o, env, run: runAsync }) // the daemon's runner (arch/model-backends.mjs doorPartsFor)
  const t0 = Date.now()
  let ticked = 0
  const tick = setInterval(() => { ticked++ }, 20)
  const [slow, fast] = await Promise.all([ownerOfSocket({ exec, budgetMs: 1000, peer: { address: '127.0.0.1', port: 50001 } }), ownerOfSocket({ exec, budgetMs: 1000, peer: { address: '127.0.0.1', port: 50002 } })])
  clearInterval(tick)
  assert.equal(slow.pid, null, 'the slow lookup is the budget\'s fail-safe null')
  assert.equal(fast.pid, 777, 'the other connection is answered')
  assert.ok(Date.now() - t0 < 1800, `both settle by the budget, not after the slow lsof (${Date.now() - t0} ms)`)
  assert.ok(ticked >= 3, `the event loop kept running while lsof ran (${ticked} ticks)`)
})

test('the targeted facts ask (ps + lsof) does not stop the event loop with the async runner', async () => {
  const env = { ...process.env, ...stubs(300) }
  let ticked = 0
  const tick = setInterval(() => { ticked++ }, 20)
  const f = await factsOfPid(777, { exec: (file, args, o) => runAsync(file, args, { ...o, env }) })
  clearInterval(tick)
  assert.equal(f.pid, 777)
  assert.ok(ticked >= 3, `the loop ticked while ps ran (${ticked})`)
})
