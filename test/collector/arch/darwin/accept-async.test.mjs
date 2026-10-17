// test/collector/arch/darwin/accept-async.test.mjs — the darwin daemon's accept path runs netstat / ps / lsof through execFile (src/off/exec.mjs
// runAsync), so a slow table read does not stop the daemon serving its other doors. Real child processes: stubs in the temp dir (the only tools npm test
// lets run, 0.1 §3) that answer late.
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
  // the kernel TCP table after slowMs: peers 50001 and 50002 held by 777 and 778
  sh('netstat', `sleep ${slowMs / 1000}\nprintf 'Proto Recv-Q Send-Q  Local Address  Foreign Address  (state)  rxbytes txbytes rhiwat shiwat process:pid state\\n'\nprintf 'tcp4 0 0 127.0.0.1.50001 127.0.0.1.18112 ESTABLISHED 1 1 1 1 a:777 00102\\ntcp4 0 0 127.0.0.1.50002 127.0.0.1.18112 ESTABLISHED 1 1 1 1 b:778 00102\\n'`)
  sh('lsof', `sleep ${slowMs / 1000}; printf 'p777\\nftxt\\nn/bin/x\\n'`)
  sh('ps', `sleep ${slowMs / 1000}; printf '  777     1   501 x Mon Oct  5 17:00:00 2026     /bin/x\\n'`)
  return { PATH: `${dir}:/bin:/usr/bin` }
}

test('the owner lookup runs off the event loop and is waited for — a slow table read answers its pid, and the loop keeps serving meanwhile', async () => {
  const env = { ...process.env, ...stubs(600) }
  const exec = (file, args, o = {}) => execTool(file, args, { ...o, env, run: runAsync }) // the daemon's runner (arch/model-backends.mjs doorPartsFor)
  let ticked = 0
  const tick = setInterval(() => { ticked++ }, 20)
  const [a, b] = await Promise.all([ownerOfSocket({ exec, peer: { address: '127.0.0.1', port: 50001 } }), ownerOfSocket({ exec, peer: { address: '127.0.0.1', port: 50002 } })])
  clearInterval(tick)
  assert.deepEqual([a.pid, b.pid], [777, 778], 'both connections are answered, slow or not')
  assert.ok(ticked >= 3, `the event loop kept running while netstat ran (${ticked} ticks)`)
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
