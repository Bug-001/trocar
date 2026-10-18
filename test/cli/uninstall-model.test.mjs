// CM24 (RFC 4.11 §5; 1.6 §1.1 uninstall): on macOS / Windows uninstall never does off. A harness on, or a holder — told by the daemon's GET /holders
// when it answers on the endpoint control.json names (a real control server here), judged from the manifest's liveness and the process table when
// it is down — is named and nothing changes, exit 1, code collectors-online. Offline, the LIFO undo: wrapper, plugin and loader line, config keys,
// the pem-blocks, the root store, and the root's key LAST.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { modelWorld, sharedCertFileWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { formatUninstallReceipt } from '../../src/cli/receipt.mjs'
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
function uninstall(w, deps = {}, opts = {}) {
  const custody = { kind: w.custody.kind, remove: (id) => { seq.push('custody:remove'); return w.custody.remove(id) } }
  const exec = recordingExec({ onRun: (cmd) => seq.push(`exec:${cmd.split(' ').slice(0, 2).join(' ')}`) })
  return runUninstall({ home: w.home, env: w.env, yes: true, ...opts, deps: { platform: 'darwin', exec: exec.run, custody, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501, ...deps } })
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
    assert.deepEqual([exit, receipt.error && receipt.error.code], [1, 'collectors-online'])
    assert.ok(receipt.problems.some((p) => p.includes('asight off') && p.includes('asight uninstall')), 'the refusal gives the steps: asight off, then asight uninstall (1.6 §9.6 collectors-online)')
    assert.match(receipt.problems.join('\n'), /codex \(pid 4242\)/)
    assert.deepEqual(tree(w.home), before, 'not one file changed')
    const purged = await uninstall(w, {}, { purgeData: true }) // the receipt of a refused --purge-data says the captures stay (it said 「采集数据已删」)
    assert.deepEqual([purged.exit, purged.receipt.error && purged.receipt.error.code, tree(w.home)], [1, 'collectors-online', before])
    assert.doesNotMatch(formatUninstallReceipt(purged.receipt), /your captured records \(--purge-data\)/)
  } finally { await server.close() }
})

test('CM24 · a harness still on (desired on) → refused and named, nothing changed — uninstall never does off', async () => {
  const w = await installed()
  fs.writeFileSync(path.join(w.dir, 'state.json'), JSON.stringify({ version: 2, updated_at: null, harnesses: { 'kimi-code': { desired: 'on', since: new Date().toISOString() } } }))
  const before = tree(w.home)
  const { receipt, exit } = await uninstall(w)
  assert.deepEqual([exit, receipt.error && receipt.error.code], [1, 'collectors-online'])
  assert.match(receipt.problems.join('\n'), /capture is still on for kimi-code/)
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
  assert.deepEqual([exit, receipt.error && receipt.error.code], [1, 'collectors-online'], JSON.stringify(receipt.problems))
  assert.match(receipt.problems.join('\n'), /codex \(pid 777\)/)
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

// D48 · 1.6 §1.6 OS 框: once the OS was asked to add the root, whatever it answered, the root may be in the user's store — a cancelled macOS box leaves
// it in the login keychain without trust, a Windows read-back that failed hides a trusted one, a prompt left open may be answered later. Install records
// it, and uninstall removes it by its fingerprint (review 2026-10-17: the read-back's pending skipped the record, and uninstall left the root). Generated
// along what the add and its read-back answer.
const ANSWERS = {
  'the add ok, the read-back absent': (s) => { s.add = () => ({ ok: true }) },
  'the add ok, the read-back an error': (s) => { const has = s.has; let n = 0; s.add = () => ({ ok: true }); s.has = (id) => (n++ ? { error: 'certutil -user -store failed (exit 1)' } : has(id)) },
  'the prompt declined': (s) => { s.answer = 'declined' },
  'the prompt left pending': (s) => { s.answer = 'pending' },
}
for (const [what, make] of Object.entries(ANSWERS)) {
  test(`D48 · ${what} → the manifest records the root, uninstall removes it by its fingerprint`, async () => {
    const w = await modelWorld()
    make(w.store)
    const r = await w.install()
    assert.deepEqual([r.exit, r.pending.map((p) => p.item)], [1, ['root-store']])
    assert.deepEqual(readManifest(w.dir).entries.filter((e) => e.kind === 'system-root').map((e) => e.fp256), [r.fp256], 'one system-root record, this root')
    const removed = []
    const { receipt } = await uninstall(w, { rootStore: { remove: (id) => { removed.push(id.fp256); return { ok: true } }, has: () => ({ present: false }) } })
    assert.deepEqual(removed, [r.fp256], JSON.stringify({ p: receipt.problems, l: receipt.left }))
  })
}

// 4.11 P4 rule U: one user file two harnesses' settings name holds one block, recorded once — uninstall takes it out once, the user's bytes as they were
test('rule U · the block Claude Code and Kimi Code share comes out once: the user\'s file byte for byte, nothing left, exit 0', async () => {
  const w = await sharedCertFileWorld({ userPem: USER_PEM })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  assert.notEqual(fs.readFileSync(w.file, 'utf8'), USER_PEM, 'the block is there')
  const { receipt, exit } = await uninstall(w)
  assert.equal(exit, 0, JSON.stringify({ p: receipt.problems, l: receipt.left }))
  assert.equal(fs.readFileSync(w.file, 'utf8'), USER_PEM)
  const at = (k) => receipt[k].filter((x) => x.path === w.file || x.what === w.file)
  assert.deepEqual([at('changed').length, at('skipped'), at('left')], [1, [], []], JSON.stringify(receipt.changed))
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

// 0.2:130 (D46): the daemon's console logs, which launchd writes (the LaunchAgent's StandardOutPath / StandardErrorPath, 4.9) and which no manifest
// entry names on the model path, go with uninstall once the daemon has stopped; the user's files stay byte for byte; a refused uninstall leaves them
const userTree = (home) => Object.fromEntries(Object.entries(tree(home)).filter(([p]) => !p.startsWith(path.join(home, '.asight'))).map(([p, b]) => [path.relative(home, p), b]))
const withLogs = (w) => {
  const logs = path.join(w.dir, 'logs')
  fs.mkdirSync(logs, { recursive: true })
  for (const n of ['daemon-out.log', 'daemon-err.log']) fs.writeFileSync(path.join(logs, n), `${n}: what launchd caught\n`)
  return logs
}
test('0.2:130 · offline uninstall removes ~/.asight/collector/logs (daemon-out / daemon-err) — the user\'s files byte for byte', async () => {
  const w = await installed()
  const twin = await installed() // the same uninstall with no logs: what it leaves of the user's is the yardstick
  const logs = withLogs(w)
  const { receipt, exit } = await uninstall(w)
  assert.equal(exit, 0, JSON.stringify({ p: receipt.problems, l: receipt.left }))
  assert.equal(fs.existsSync(logs), false, `the daemon's logs are gone: ${leftUnder(w.home).join(', ')}`)
  assert.ok(receipt.removed.includes(logs), 'the receipt names them')
  assert.equal((await uninstall(twin)).exit, 0)
  assert.deepEqual(userTree(w.home), userTree(twin.home), 'outside ~/.asight the user\'s files are byte for byte what the same uninstall leaves without logs')
})
test('0.2:130 · a refused uninstall (collectors-online) leaves the daemon\'s logs', async () => {
  const w = await installed()
  const logs = withLogs(w)
  fs.writeFileSync(path.join(w.dir, 'state.json'), JSON.stringify({ version: 2, updated_at: null, harnesses: { codex: { desired: 'on', since: new Date().toISOString() } } }))
  const before = tree(w.home)
  const { receipt, exit } = await uninstall(w)
  assert.deepEqual([exit, receipt.error && receipt.error.code], [1, 'collectors-online'])
  assert.deepEqual(fs.readdirSync(logs).sort(), ['daemon-err.log', 'daemon-out.log'])
  assert.deepEqual(tree(w.home), before)
})

// invariant 2: `--purge-data` deletes the captures only once every other step has succeeded — a run with a problem (a state.json that cannot be written —
// the test rig's EIO) or an item left (a key the custody cannot reach) keeps every capture and says so (G12: exit 1, yet 「采集数据已删」). Generated along the causes.
const CAPTURES = ['capture-2026-10-17.ndjson', 'flows/2026-01-01.ndjson', 'audit/a.ndjson', 'replays/r.json']
const withCaptures = (w) => { for (const p of CAPTURES) { fs.mkdirSync(path.dirname(path.join(w.dir, p)), { recursive: true }); fs.writeFileSync(path.join(w.dir, p), `${p}\n`) } }
const UNFINISHED = {
  'a state.json that cannot be written': (w) => { fs.rmSync(path.join(w.dir, 'state.json'), { force: true }); fs.mkdirSync(path.join(w.dir, 'state.json', 'x'), { recursive: true }) },
  'a key the custody cannot reach': (w) => { w.custody.switches.unavailable = true },
}
for (const [cause, make] of Object.entries(UNFINISHED)) {
  test(`invariant 2 · --purge-data with ${cause}: exit 1, and every capture stays; the receipt says they stay`, async () => {
    const w = await installed()
    withCaptures(w)
    make(w)
    const { receipt, exit } = await uninstall(w, {}, { purgeData: true })
    assert.equal(exit, 1, JSON.stringify({ p: receipt.problems, l: receipt.left }))
    for (const p of CAPTURES) assert.equal(fs.readFileSync(path.join(w.dir, p), 'utf8'), `${p}\n`, `${p} stays`)
    assert.deepEqual(receipt.purge_data, false)
    assert.doesNotMatch(formatUninstallReceipt(receipt), /your captured records \(--purge-data\)/)
  })
}
test('invariant 2 · --purge-data on a clean run deletes the captures (the negative above is not vacuous)', async () => {
  const w = await installed()
  withCaptures(w)
  const { receipt, exit } = await uninstall(w, {}, { purgeData: true })
  assert.equal(exit, 0, JSON.stringify({ p: receipt.problems, l: receipt.left }))
  for (const p of CAPTURES) assert.equal(fs.existsSync(path.join(w.dir, p)), false, `${p} is gone`)
  assert.match(formatUninstallReceipt(receipt), /your captured records \(--purge-data\)/)
})

// D38 · P5 (Windows test machine 2026-10-18): removing a root asks the operator, and a question nobody answers (or a tool that exits 0 while the root stays)
// must not read as "removed" — uninstall exited 1 with nothing naming the certificate, and the manifest went anyway, so the machine kept trusting
// asight and the next uninstall said nothing was installed. Generated along the ways the store can keep the root.
const KEPT_ROOT = {
  'the removal reports success, the store still holds it': { remove: () => ({ ok: true }), has: () => ({ present: true }) },
  'the removal fails': { remove: () => ({ ok: false, reason: 'certutil -user -delstore failed (exit none)' }), has: () => ({ present: true }) },
  'the removal throws': { remove: () => { throw new Error('the prompt was not answered') }, has: () => ({ present: true }) },
  'the store cannot be read back': { remove: () => ({ ok: true }), has: () => ({ error: 'certutil -user -store failed (exit 1)' }) },
}
for (const [what, store] of Object.entries(KEPT_ROOT)) {
  test(`D38 · ${what}: exit 1, the receipt names the root and the command, the manifest keeps the record for the next run`, async () => {
    const w = await installed()
    const fp = readManifest(w.dir).entries.find((e) => e.kind === 'system-root').fp256
    const { receipt, exit } = await uninstall(w, { rootStore: store })
    assert.equal(exit, 1, JSON.stringify({ p: receipt.problems, l: receipt.left }))
    assert.equal(receipt.ok, false)
    assert.deepEqual(receipt.still_trusting.map((x) => [x.what, x.fp256]), [['root', fp]], JSON.stringify(receipt.still_trusting))
    assert.match(receipt.still_trusting[0].command, /security remove-trusted-cert|certutil/, 'the by-hand command is there')
    assert.equal(receipt.problems.length, 1, JSON.stringify(receipt.problems))
    assert.match(receipt.problems[0], /root certificate was NOT taken out of your trust store/)
    assert.ok(receipt.left.some((l) => /trust store/.test(l.reason)), JSON.stringify(receipt.left))
    const after = readManifest(w.dir)
    assert.deepEqual(after.entries.filter((e) => e.kind === 'system-root').map((e) => e.fp256), [fp], 'the next uninstall finds the root to remove')
    const flows = path.join(w.dir, 'flows')
    const lines = fs.readdirSync(flows).flatMap((n) => fs.readFileSync(path.join(flows, n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    assert.equal(lines.filter((l) => l.code === 'root-not-removed').length, 1, `one failure line (${lines.map((l) => l.code || l.kind).join(', ')})`)
    assert.match(formatUninstallReceipt(receipt, { home: w.home }), /trust store/)
  })
}
