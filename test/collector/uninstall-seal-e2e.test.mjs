// test/collector/uninstall-seal-e2e.test.mjs — V125 (RFC 1.6 §3.6, 4.2 §自动封存): the uninstall ↔ daemon seam for real. The daemon is a REAL child
// process at its real control endpoint (as in model-replace-drain-e2e); uninstall's drainDaemon runs over the real lock file and control socket,
// with its default request and pid check (only the lock identity is answered, as the child's is). A closed segment the seal queue never got is
// in raw/: the stop seals it at normal priority, the progress reaches onSealing through the lock, and the wait ends only once the pid has exited.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { modelWorld } from '../helpers/model-world.mjs'
import { withScratchCwd, unservable } from '../helpers/model-daemon.mjs'
import { within } from '../helpers/bounded.mjs'
import { WITH_PARENT, watchEnv } from '../helpers/standin.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { agentOf } from '../helpers/model-io.mjs'
import { offWorld, drainDaemon } from '../../src/off/orchestrate.mjs'
import { rawHome } from '../../src/paths.mjs'

const CHILD = fileURLToPath(new URL('./fixtures/model-daemon-child.mjs', import.meta.url))
const SEG = '20261003T000000Z'
const until = async (ok, ms, what) => within((async () => { for (;;) { const v = ok(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) } })(), ms, what)

for (const platform of ['darwin', 'win32']) {
  test(`V125 · ${platform}: uninstall's drain waits while the real daemon seals, hears its progress, and returns once the pid has exited`, { skip: await unservable(platform), timeout: 90_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const desc = w.harnesses.find((h) => h.name === 'codex')
    const a = agentOf({ w, name: desc.processes.names[0].name, env: {} })
    const agentFile = path.join(tmpDir('trocar-agent-'), 'agent.json')
    fs.writeFileSync(agentFile, JSON.stringify({ ...a, ports: [...a.ports] }))
    let child = null
    await withScratchCwd(platform, async () => {
      try {
        child = spawn(process.execPath, [...WITH_PARENT, CHILD, 'run'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
          env: watchEnv({ ...w.env, TROCAR_TEST_SANDBOX: '1', TROCAR_E2E_OS: platform, TROCAR_E2E_AGENT: agentFile, TROCAR_E2E_FX: path.join(tmpDir('trocar-helper-'), 'fixture.json') }) })
        let out = '', err = ''
        child.stdout.on('data', (b) => { out += b }); child.stderr.on('data', (b) => { err += b })
        const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
        await within(Promise.race([until(() => /trocar collector:/.test(out), 30_000, 'the readiness line'), exited.then((r) => { throw new Error(`the daemon exited before it was ready: ${JSON.stringify(r)} ${err}`) })]), 30_000, `the readiness line (err=${err})`)

        const raw = rawHome(path.dirname(w.dir)); fs.mkdirSync(raw, { recursive: true })
        const line = (i) => JSON.stringify({ id: `req_${i}`, ts: '2026-10-03T10:00:00.000Z', req_body: `${i} `.repeat(500) }) + '\n'
        fs.writeFileSync(path.join(raw, `${SEG}.ndjson`), Array.from({ length: 12_000 }, (_, i) => line(i)).join(''), { mode: 0o600 }) // ~ 24 MB
        const size = fs.statSync(path.join(raw, `${SEG}.ndjson`)).size

        const ow = offWorld({ home: w.home, env: w.env, deps: { platform, identity: () => ({ start_time: '111', boot_id: 'boot-1' }) } })
        const seen = []
        const { routing } = await drainDaemon(ow, { by: 'uninstall', onSealing: (s) => seen.push(s) })
        assert.equal(routing.how, 'daemon-reply', JSON.stringify(routing))
        assert.ok(child.exitCode !== null || child.signalCode !== null, 'the wait returned only after the daemon\'s pid had exited')
        const end = await exited
        assert.deepEqual([end.code, end.signal], [0, null], `exit 0 by itself (err=${err})`)
        assert.ok(seen.some((s) => s.segment === SEG && s.total === size), JSON.stringify(seen))
        assert.deepEqual(fs.readdirSync(raw).filter((n) => n.startsWith(SEG)), [`${SEG}.sealed`], 'sealed, the plaintext gone')
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    })
  })
}
