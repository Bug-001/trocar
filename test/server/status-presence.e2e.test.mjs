// test/server/status-presence.e2e.test.mjs — 4.11 §2.3 `present`, 1.6 V91: whether a form is on this machine is the same answer whoever asks. A form
// whose only presence check is a command (codex.cli) is found in a directory only the user's shell PATH has; the daemon's query worker runs with the
// login service's PATH (/usr/bin:/bin). A REAL daemon (test/helpers/model-daemon.mjs) with the real query worker (test/helpers/worker-fork.mjs) answers
// GET /api/status on the board's real port; `trocar on codex` runs through the real runCli from the user's shell (it records the PATH), and
// `status --json` then runs with the login PATH too: a form not found would make codex `not-routed` (4.11 P5). Nothing is injected into `which`, a request or a socket path. Sandbox HOMEs only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd, boardPortOf } from '../helpers/model-daemon.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { depsFile, boardDeps } from '../helpers/board-world.mjs'
import { request } from './face.mjs'
import { fakeIo } from '../cli/fixtures/on-ctx.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { runCli } from '../../src/cli/main.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { USER_PATH_FILE } from '../../src/off/paths.mjs'

const HELPER = { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } }
const view = (doc) => { const h = doc.harnesses.codex; return { desired: h.desired, forms: (h.forms || []).map((f) => f.form), captured: h.captured, reason: h.reason } }

for (const platform of ['darwin', 'win32']) {
  test(`${platform} · 4.11 present: the board's /api/status and \`trocar status\` agree on codex's forms and verdict, whichever PATH each process has`, { timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] }) // w.env.PATH = the one directory that has codex: the user's shell
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const login = { ...w.env, PATH: '/usr/bin:/bin' } // what the login service starts the daemon and its worker with
    const port = await boardPortOf(w.dir)
    await withScratchCwd(platform, async () => {
      const box = await liveUnit({ w, platform, parts: { helper: HELPER }, daemon: { fork: (h) => workerFork(h, depsFile({ ...w, env: login }, platform)) } })
      box.unit.start(); await box.starting
      try {
        const io = fakeIo()
        assert.equal(await runCli(['on', 'codex', '--yes', '--json'], { io, home: w.home, env: w.env, platform, uid: 501, deps: await boardDeps({ platform, home: w.home, env: w.env, dirs: w.ctx.dirs }) }), 0, io.text())
        assert.ok(fs.existsSync(path.join(w.dir, USER_PATH_FILE)), 'a command from the shell recorded the user\'s PATH')
        const token = fs.readFileSync(path.join(w.dir, 'board.token'), 'utf8')
        const r = await request(port, '/api/status', { headers: { [CONTROL_TOKEN_HEADER]: token } })
        assert.equal(r.status, 200, r.body)
        const cli = fakeIo()
        await runStatusCli(['--json'], { io: cli, home: w.home, platform, env: login, deps: await boardDeps({ platform, home: w.home, env: login, dirs: w.ctx.dirs }) })
        const board = view(JSON.parse(r.body)), shell = view(cli.json())
        assert.deepEqual(board, shell, 'one answer whoever asks')
        assert.equal(board.desired, 'on')
        assert.notEqual(board.reason, 'not-routed', `the command-only form is present for the worker too: ${JSON.stringify(board)}`)
      } finally { await box.stop() }
    })
  })
}
