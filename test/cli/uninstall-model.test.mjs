// CM24 (RFC 4.11 §5; 1.6 §1.1 uninstall): on macOS / Windows uninstall never does off. A harness on, or a holder — told by the daemon's GET /holders
// when it answers on the endpoint control.json names (a real control server here), judged from the manifest's liveness and the process table when
// it is down — is named and nothing changes, exit 1, code collectors-online. Offline, the LIFO undo: wrapper, plugin and loader line, config keys,
// the pem-blocks, the root store, and the root's key LAST.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { readManifest, saveManifest } from '../../src/off/manifest.mjs'
import { recordingExec } from './fixtures/on-ctx.mjs'

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4])
const USER_PEM = `${tls.rootCertificates[2].trim()}\n`
const TOKEN = 't'.repeat(32)
const tree = (root) => { const out = {}; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (p.includes(`${path.sep}flows`)) continue; const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile()) out[p] = fs.readFileSync(p).toString("base64") } }; walk(root); return out }

async function installed() {
  const w = await modelWorld({ commands: ['codex', 'dsh'], env: (home) => ({ SSL_CERT_FILE: path.join(home, 'certs', 'mine.pem') }) })
  fs.mkdirSync(path.join(w.home, 'certs'), { recursive: true }); fs.writeFileSync(w.env.SSL_CERT_FILE, USER_PEM)
  const kimi = path.join(w.home, '.kimi-code', 'bin', 'kimi')
  fs.mkdirSync(path.dirname(kimi), { recursive: true }); fs.writeFileSync(kimi, MACHO)
  fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true })
  fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
  const r = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  return { ...w, kimi }
}
const seq = []
function uninstall(w, deps = {}) {
  const custody = { kind: w.custody.kind, remove: (id) => { seq.push('custody:remove'); return w.custody.remove(id) } }
  const exec = recordingExec({ onRun: (cmd) => seq.push(`exec:${cmd.split(' ').slice(0, 2).join(' ')}`) })
  return runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform: 'darwin', exec: exec.run, custody, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501, ...deps } })
}
async function daemonAnswering(w, holders) {
  const sock = path.join(w.home, 'c.sock')
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token: TOKEN }))
  return startControlServer({ socketPath: sock, token: TOKEN, routes: { 'GET /holders': async () => ({ count: holders.length, holders }), 'GET /status': async () => ({}) } })
}

test('CM24 · daemon up: a holder the daemon names (GET /holders over its real endpoint) → refused, named, nothing changed, exit 1', async () => {
  const w = await installed()
  const server = await daemonAnswering(w, [{ harness: 'codex', pid: 4242, start: 1, why: 'started-in-window' }])
  try {
    const before = tree(w.home)
    const { receipt, exit } = await uninstall(w)
    assert.deepEqual([exit, receipt.code], [1, 'collectors-online'])
    assert.match(receipt.problems.join('\n'), /pid 4242 \(codex\)/)
    assert.deepEqual(tree(w.home), before, 'not one file changed')
  } finally { await server.close() }
})

test('CM24 · a harness still on (desired on) → refused and named, nothing changed — uninstall never does off', async () => {
  const w = await installed()
  fs.writeFileSync(path.join(w.dir, 'state.json'), JSON.stringify({ version: 2, updated_at: null, harnesses: { 'kimi-code': { desired: 'on', since: new Date().toISOString() } } }))
  const before = tree(w.home)
  const { receipt, exit } = await uninstall(w)
  assert.deepEqual([exit, receipt.code], [1, 'collectors-online'])
  assert.match(receipt.problems.join('\n'), /还开着: kimi-code/)
  assert.deepEqual(tree(w.home), before)
})

test('CM24 · daemon down: the CLI judges holders from the manifest\'s liveness and the process table (a codex started inside its on window) → refused', async () => {
  const w = await installed()
  const m = readManifest(w.dir)
  const onAt = Date.now() - 60_000
  m.liveness.codex = { ...m.liveness.codex, on_at: new Date(onAt).toISOString(), off_at: new Date(onAt + 30_000).toISOString() }
  saveManifest(w.dir, m)
  const before = tree(w.home)
  const proc = { pid: 777, startedAt: onAt + 1000, name: 'codex', comm: 'codex', exe: '/usr/local/bin/codex', args: ['codex'], cmdline: 'codex', argv: ['codex'] }
  const { receipt, exit } = await uninstall(w, { procs: async () => [proc] })
  assert.deepEqual([exit, receipt.code], [1, 'collectors-online'], JSON.stringify(receipt.problems))
  assert.match(receipt.problems.join('\n'), /pid 777 \(codex\)/)
  assert.deepEqual(tree(w.home), before)
})

test('CM24 · offline: LIFO — the wrapper back, the plugin and its loader line, the config key, the pem-block, the root store, and the root\'s key LAST; the user\'s bytes as they were', async () => {
  const w = await installed()
  seq.length = 0
  const { receipt, exit } = await uninstall(w)
  assert.equal(exit, 0, JSON.stringify({ p: receipt.problems, l: receipt.left }))
  assert.deepEqual(fs.readFileSync(w.kimi), MACHO, 'the real kimi is back in place')
  assert.equal(fs.existsSync(path.join(w.home, '.kimi-code', 'bin', '.asight-real')), false)
  assert.equal(fs.readFileSync(w.env.SSL_CERT_FILE, 'utf8'), USER_PEM, 'the pem-block is gone, the user\'s file byte for byte')
  assert.deepEqual(fs.readdirSync(path.join(w.home, '.dsh')).filter((n) => n.startsWith('asight-')), [], 'the plugin is gone')
  assert.ok(!fs.existsSync(path.join(w.home, '.dsh', 'cordis.patch.yml')) || !/asight/.test(fs.readFileSync(path.join(w.home, '.dsh', 'cordis.patch.yml'), 'utf8')), 'and its loader line')
  const zc = path.join(w.home, '.zcode', 'cli', 'config.json')
  assert.ok(!fs.existsSync(zc) || !/caCertFile/.test(fs.readFileSync(zc, 'utf8')), 'Z-Code\'s key is gone')
  assert.ok(seq.some((s) => s.startsWith('exec:security')), `the root store was asked (${seq.join(', ')})`)
  assert.equal(seq.at(-1), 'custody:remove', `the root's key goes last: ${seq.join(', ')}`)
  assert.equal(w.custody.exists(), false)
})

// invariant 5: uninstall leaves nothing of asight's but the captures — the darwin signing helper install put in ~/.asight/bin goes too, after the key;
// while the key could not be removed (the custody unreachable), the helper stays with its record: the next uninstall needs it
const leftUnder = (home) => { const out = []; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (p.includes(`${path.sep}flows`)) continue; if (fs.lstatSync(p).isDirectory()) walk(p); else out.push(path.relative(home, p)) } }; if (fs.existsSync(path.join(home, '.asight'))) walk(path.join(home, '.asight')); return out }
test('invariant 5 · offline uninstall: ~/.asight keeps only the captures — the signing helper and ~/.asight/bin go after the key', async () => {
  const w = await installed()
  const helper = path.join(w.home, '.asight', 'bin', 'asight-sign-helper')
  fs.writeFileSync(helper, MACHO, { mode: 0o755 })
  const { receipt, exit } = await uninstall(w)
  assert.equal(exit, 0, JSON.stringify({ p: receipt.problems, l: receipt.left }))
  assert.deepEqual(leftUnder(w.home), [], 'nothing of asight\'s but the captures')
  assert.equal(fs.existsSync(path.join(w.home, '.asight', 'bin')), false)
  assert.ok(receipt.removed.includes(helper))
})
test('invariant 5 · D38: a key the custody cannot reach now stays recorded, listed as left, and its signing helper stays for the next uninstall', async () => {
  const w = await installed()
  const helper = path.join(w.home, '.asight', 'bin', 'asight-sign-helper')
  fs.writeFileSync(helper, MACHO, { mode: 0o755 })
  w.custody.switches.unavailable = true
  const { receipt, exit } = await uninstall(w)
  assert.equal(exit, 1)
  assert.ok(receipt.left.some((l) => /private key/.test(l.reason)), JSON.stringify(receipt.left))
  assert.equal(fs.existsSync(helper), true)
  assert.ok(readManifest(w.dir).entries.some((e) => e.kind === 'root-key'))
})
