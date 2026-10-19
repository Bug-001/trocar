// on-setup.test.mjs — V91 `on` (1.6 §3.3, D65④, 4.11 P4b): a harness whose setup is needed (here: its install-folder wrapper replaced by its own update)
// is refused alone with `setup-needed` and not one byte of it written; the other harness is turned on. `--dry-run` exits 0 with it in `blocked`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { runOnCli } from '../../src/cli/on.mjs'

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
const A = 'kimi-code', B = 'codex'
const fakeIo = () => { const out = [], err = []; return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')), errText: () => err.join('') } }
const unit = { path: '/nowhere/unit', text: () => '', registered: () => ({ state: 'present' }), enable: () => { throw new Error('untouched') }, start: () => { throw new Error('untouched') }, startNow: () => { throw new Error('untouched') } }
const reader = { ready: Promise.resolve({ ready: true, via: 'daemon' }), close: async () => {}, self: () => null, call: async () => ({ procs: [] }) }

/** A's files: everything under its install folder, and its switch file. */
const filesOf = (w) => { const at = path.join(w.home, '.kimi-code'), out = {}; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : (out[p] = fs.readFileSync(p)) } }; walk(at); const sw = path.join(w.dir, 'switch', A); out[sw] = fs.existsSync(sw) ? fs.readFileSync(sw) : null; return out }

test('V91 · 1.6 §3.3: on A B, A needing setup → exit 1, error.code setup-needed, refused holds A only, A byte for byte unchanged, B written; --dry-run → exit 0 with A in blocked', async () => {
  const w = await modelWorld({ commands: [B] })
  const bin = path.join(w.home, '.kimi-code', 'bin', 'kimi')
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, MACHO)
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  fs.writeFileSync(bin, Buffer.concat([MACHO, Buffer.from('the new release')])) // A's own update overwrote asight's wrapper: carrier-overwritten
  const sock = path.join(w.home, 'c.sock'), token = 'k'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, daemonReader: reader, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } } }
  const on = async (argv) => { const io = fakeIo(); return { exit: await runOnCli(argv, { io, env: w.env, home: w.home, platform: 'darwin', deps }), io } }
  try {
    const before = filesOf(w)
    const dry = await on([A, B, '--dry-run', '--json'])
    assert.deepEqual([dry.exit, dry.io.json().blocked.map((x) => x.what)], [0, [A]], dry.io.text())
    const r = await on([A, B, '--yes', '--json'])
    const j = r.io.json()
    assert.deepEqual([r.exit, j.error && j.error.code, j.refused.map((x) => x.harness)], [1, 'setup-needed', [A]], r.io.text())
    assert.equal(r.io.errText(), '', '--json: stderr stays empty')
    assert.deepEqual(filesOf(w), before, 'not one byte of A written')
    assert.match(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'), /HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+/, 'B is turned on')
  } finally { await server.close() }
})
