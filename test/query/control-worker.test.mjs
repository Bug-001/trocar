// test/query/control-worker.test.mjs — the control worker role (RFC 3.5 §谁执行它「三个角色」): it never reads the rows, writes nothing
// under index/, and answers a query line with 500, never 200 or 102. The real worker fork on a home with one raw segment and no index.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { rawHome, writeSegment } from './raw-home.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'

test('the control worker answers a query line 500, reads no rows and writes no index', async () => {
  const home = rawHome()
  writeSegment(home, '20261018T100000Z', [{ ts: '2026-10-18T10:00:00.000Z', sessionKey: 's-1', harness: 'opencode' }])
  const child = workerFork(home, '', 'control')
  const messages = []
  child.on('message', (m) => messages.push(m))
  const exited = once(child, 'exit')
  let buf = Buffer.alloc(0), wake = () => {}
  child.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); wake() })
  const frame = () => within((async () => {
    for (;;) {
      const nl = buf.indexOf(10)
      if (nl >= 0) {
        const head = buf.subarray(0, nl).toString('utf8').split(' '), len = Number(head[1])
        if (buf.length >= nl + 1 + len) { buf = buf.subarray(nl + 1 + len); return Number(head[0]) }
      }
      await new Promise((d) => { wake = d })
    }
  })(), 30_000, 'a frame from the control worker')
  try {
    for (const name of ['sessions', 'status']) {
      child.stdin.write(JSON.stringify({ name, params: {} }) + '\n')
      assert.equal(await frame(), 500, name)
    }
    child.stdin.end()
    await within(exited, 30_000, 'the control worker exit')
  } finally { if (child.exitCode === null) child.kill() }
  assert.ok(!messages.some((m) => m && m.rows === true))
  assert.equal(fs.existsSync(path.join(home, 'index')), false)
})
