// `asight install` (RFC 1.6 §1.1, §1.6): its own command; root refused before anything is read; a v2 manifest refused before any write;
// no terminal and no --yes → the plan only, exit 2, nothing written; --yes → the model install, its receipt and an install-note; exit 0 / 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runInstallCli } from '../../src/cli/install.mjs'
import { resolveAlias, commandNamed } from '../../src/cli/commands.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'

function fakeIo({ tty = false } = {}) {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: tty }, stdout: { isTTY: tty }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) }
}
async function cli(argv, { tty = false, over = {} } = {}) {
  const w = await modelWorld({ commands: ['codex'] })
  const io = fakeIo({ tty })
  const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, ...over }
  const exit = await runInstallCli(argv, { io, env: w.env, home: w.home, platform: 'darwin', deps })
  return { w, io, exit }
}

test('install is a command of its own, and `collector install` is its hidden alias (no longer `on`)', () => {
  assert.ok(commandNamed('install'))
  assert.deepEqual(resolveAlias(['collector', 'install', '--yes']).argv, ['install', '--yes'])
  assert.deepEqual(resolveAlias(['install']).argv, ['install'], 'install is no alias of on')
})

test('1.6 §1.6: as root, install refuses before it reads anything — exit 1, no ~/.asight', async () => {
  const { w, exit } = await cli(['--yes'], { over: { getuid: () => 0 } })
  assert.equal(exit, 1)
  assert.equal(fs.existsSync(path.join(w.home, '.asight')), false)
})

test('1.6 §1.6: no terminal and no --yes → the plan (cost and residual-risk lines) and exit 2, nothing written; --dry-run → exit 0, nothing written', async () => {
  const a = await cli([])
  assert.equal(a.exit, 2)
  assert.match(a.io.text(), /代价:证书在时/); assert.match(a.io.text(), /剩余风险:/); assert.match(a.io.text(), /codex\.cli/)
  assert.equal(fs.existsSync(path.join(a.w.home, '.asight', 'collector', 'install-manifest.json')), false)
  const b = await cli(['--dry-run'])
  assert.equal(b.exit, 0)
  assert.equal(fs.existsSync(path.join(b.w.home, '.asight', 'collector', 'install-manifest.json')), false)
})

test('4.11 ⑰: a version 2 manifest is refused before any write — exit 1, the file as it was', async () => {
  const w = await modelWorld()
  const f = path.join(w.home, '.asight', 'collector', 'install-manifest.json')
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ version: 2, entries: [], files: [] }))
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps: { getuid: () => 501 } }), 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).version, 2)
})

test('install --yes --json: the receipt (fingerprint, carriers, residual risk, commands) and an install-note; exit 0; a declined root store → exit 1', async () => {
  const { w, io, exit } = await cli(['--yes', '--json'])
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.deepEqual([r.command, r.ok, typeof r.fp256, r.commands.includes('asight uninstall')], ['install', true, 'string', true])
  const day = fs.readdirSync(path.join(w.dir, 'flows')).find((n) => n.endsWith('.ndjson'))
  assert.ok(fs.readFileSync(path.join(w.dir, 'flows', day), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.event === 'install-note' && e.kind === 'result'))
  w.store.answer = 'declined'
  const again = await cli(['--yes'])
  again.w.store.answer = 'declined'
  const io2 = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io: io2, env: again.w.env, home: tmpHomeOf(again.w), platform: 'darwin', deps: { getuid: () => 501, backends: { custody: again.w.custody, rootStore: again.w.store, dirs: again.w.ctx.dirs }, harnesses: [], owns: again.w.owns } }), 1)
})
const tmpHomeOf = (w) => { const h = `${w.home}-2`; fs.mkdirSync(h, { recursive: true }); return h }
