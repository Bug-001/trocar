// test/collector/arch/darwin/table-async.test.mjs — 4.8 §5.5: the darwin process table (the negative-key sweep's and the holder poll's read) runs
// its two `ps` asks through execFile (src/off/exec.mjs runAsync) in the daemon, so a slow table read does not stop the daemon's event loop. Real child
// processes: stubs in the temp dir (the only tools npm test lets run, 0.1 §3) that answer late.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { runAsync } from '../../../../src/off/exec.mjs'
import { listProcs } from '../../../../src/off/proc.mjs'
import { doorPartsFor } from '../../../../src/collector/arch/model-backends.mjs'

const UID = typeof process.getuid === 'function' ? process.getuid() : 501
const ROWS = [{ pid: 777, ppid: 1, exe: '/Applications/Some App.app/Contents/MacOS/Some App' }, { pid: 778, ppid: 777, exe: '/usr/local/bin/agent' }]

function stubs(slowMs) {
  const dir = tmpDir('trocar-table-')
  const sh = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const table = ROWS.map((r) => `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${String(UID).padStart(5)} Mon Oct  5 17:00:00 2026     ${r.exe.split('/').pop()} --x`).join('\\n')
  const comm = ROWS.map((r) => `${String(r.pid).padStart(5)} ${r.exe}`).join('\\n')
  sh('ps', `sleep ${slowMs / 1000}\nif [ "$2" = "pid=,comm=" ]; then printf '${comm}\\n'; else printf '${table}\\n'; fi`)
  // the system-proxy watch doorPartsFor starts: no proxy, and a change watch that waits on stdin
  sh('scutil', `if [ "$1" = "--proxy" ]; then printf '<dictionary> {\\n}\\n'; else cat >/dev/null; fi`)
  return { dir, PATH: `${dir}:/bin:/usr/bin` }
}

const shape = (rows) => rows.map((r) => ({ pid: r.pid, ppid: r.ppid, exe: r.exe })).sort((a, b) => a.pid - b.pid)

async function ticking(f) {
  let ticked = 0
  const t = setInterval(() => { ticked++ }, 20)
  try { return { value: await f(), ticked } } finally { clearInterval(t) }
}

test('4.8 §5.5: the darwin table read with the async runner answers the rows ps printed and the event loop keeps running', async () => {
  const st = stubs(300), env = { ...process.env, PATH: st.PATH }
  const { value, ticked } = await ticking(() => listProcs({ platform: 'darwin', uid: null, env, exec: runAsync }))
  assert.deepEqual(shape(value), ROWS, 'pid, ppid, and the executable from comm')
  assert.ok(ticked >= 3, `the loop ticked while ps ran (${ticked})`)
})

test('4.8 §5.5: the model daemon\'s darwin procTable (doorPartsFor, no injected runner) reads the table off the event loop', async () => {
  const st = stubs(300), env = { ...process.env, PATH: st.PATH }
  const saved = process.env.PATH
  process.env.PATH = st.PATH // the system-proxy baseline read uses the process's own environment
  let parts
  try { parts = await doorPartsFor({ os: 'darwin', env, io: {} }) } finally { process.env.PATH = saved }
  try {
    const { value, ticked } = await ticking(() => parts.procTable())
    assert.deepEqual(shape(value), ROWS)
    assert.ok(ticked >= 3, `the loop ticked while ps ran (${ticked})`)
  } finally { parts.close() }
})
