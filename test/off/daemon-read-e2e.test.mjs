// test/off/daemon-read-e2e.test.mjs — the CLI ↔ daemon read question over the REAL seam (the platform-seam rule: the pattern of test/off/main.test.mjs's
// off side, and of test/collector/model-daemon-e2e.test.mjs): a real daemon with a real control server at the endpoint its own control-path module
// picked, found through the ONE resolver (control.json) — no `request` and no `socketPath` injected anywhere — answers `POST /helper` (4.8 §7) from the
// resident helper it holds, and src/off/proc.mjs's table reader takes that answer instead of starting a PowerShell. The helper is a stand-in here (this
// host is not Windows and must not start a real one, 0.1 §3); everything between the CLI's call and the daemon's route is the product's own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { daemonReader, DAEMON_READ_VERBS } from '../../src/off/daemon-read.mjs'
import { regReadAllowed, REG_READ_ALLOW } from '../../src/collector/arch/win32/helper.mjs'
import { memoProcQuestions, listProcs } from '../../src/off/proc.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'

const CREATED = 1_740_000_123_456
const ROW = { pid: 7171, ppid: 1, name: 'codex.exe', exe: 'C:\\Users\\a\\codex.exe', startedAt: CREATED, cmdline: '"C:\\Users\\a\\codex.exe" app-server', cmdlineState: 'ok' }

for (const platform of ['win32', 'darwin']) {
  test(`${platform}: the CLI's read question reaches the daemon's resident helper over the real control endpoint, and the table reader takes that answer instead of asking the OS`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const asked = []
    const helper = { close: async () => {}, call: async (verb, args) => { asked.push(verb); if (verb === 'ps') return { sessionId: 1, procs: [ROW] }; if (verb === 'reg-read') return { keyExists: true, values: { ProxyEnable: 0 } }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } }
    const box = await liveUnit({ w, platform, parts: { helper, regReadAllowed } })
    await withScratchCwd(platform, async () => {
      box.unit.startNow()
      await box.starting
      try {
        // the endpoint is resolved from control.json alone, the way every caller resolves it
        const reader = daemonReader({ platform, dir: w.dir, env: w.env })
        assert.ok(reader, 'the daemon wrote control.json and the resolver found the endpoint')
        const data = await reader.call('ps', { all: true })
        assert.deepEqual(data.procs, [ROW], 'the helper\'s own answer, over the real socket, byte for byte')
        assert.deepEqual(asked, ['ps'], 'and the daemon put the question to its helper exactly once')
        assert.deepEqual(reader.self(), { pid: process.pid, start_time: '111', boot_id: 'boot-1' }, 'the envelope carries the daemon\'s own identity — the pair it writes into its lock (4.8 §7)')

        // the one place that asks for the process table takes it: inside a scope with this reader, no OS tool is run at all (no `exec` is
        // injected here, so a real PowerShell would be refused by the test guard and the rows would never arrive)
        const close = memoProcQuestions({ reader })
        try {
          const rows = await listProcs({ platform: 'win32', env: w.env })
          assert.deepEqual(rows.map((r) => [r.pid, r.exe, r.argv, r.startedAt, r.uid, r.envRead]), [[ROW.pid, ROW.exe, ['C:\\Users\\a\\codex.exe', 'app-server'], CREATED, null, false]], 'the daemon\'s rows, in the table reader\'s own shape')
        } finally { close() }

        // the daemon refuses a read verb outside the CLI's subset before its helper is asked (4.8 §7; W1's gate on this side)
        for (const verb of ['proc-env', 'token', 'roots', 'pipe-server', 'write-anything']) {
          await assert.rejects(() => reader.call(verb, {}), (e) => e.code === 'daemon-read-unknown-verb', `the client refuses ${verb}`)
          assert.equal(DAEMON_READ_VERBS.includes(verb), false, `${verb} is not in the subset`)
        }
        const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
        const raw = await ep.request({ socketPath: ep.socketPath, method: 'POST', path: '/helper', body: { verb: 'proc-env', args: { pid: 1, names: ['PATH'] } } })
        assert.equal(raw.ok, false, 'and a request that goes round the client is refused by the daemon itself')
        assert.match(raw.error, /not one of the daemon's read verbs/)
        assert.deepEqual(asked, ['ps'], 'the helper was never asked it')

        // `reg-read` names a registry KEY, so the daemon checks the arguments too, against the one allow-list its helper checks against
        // (4.8 §7, W26: refused before the helper is asked) — the verb alone was the whole gate
        const rule = REG_READ_ALLOW[0]
        const regAsk = (args) => reader.call('reg-read', args)
        await assert.rejects(() => regAsk({ hive: rule.hive, key: 'Software\\Anything\\Else', names: rule.names.slice(0, 1) }), (e) => /outside the allow-list/.test(e.message), 'a key no rule names')
        assert.deepEqual(asked, ['ps'], 'the helper was never asked it')
        const reader2 = daemonReader({ platform, dir: w.dir, env: w.env }) // the first failure ends a reader for the life of its command (fix 3)
        const good = { hive: rule.hive, key: rule.key, names: rule.names.slice(0, 1) }
        assert.ok(regReadAllowed(good), 'the allow-list itself says this one is in it')
        assert.deepEqual(await reader2.call('reg-read', good), { keyExists: true, values: { ProxyEnable: 0 } }, 'and a key the list names is answered by the helper')
        assert.deepEqual(asked, ['ps', 'reg-read'])
      } finally { await box.stop() }
    })
  })
}
