// test/cli/status-topology.test.mjs — RFC 1.6 §9.1–§9.2 through the command line: `status` draws each harness's path under the mode header, `status <harness>` the detail, `--json` the same `topology` object the
// board reads (V43), and there is no `net` / `proxy` command (V44). Linux driver mode in a sandbox HOME of the dispatch fixture: the daemon's reply, the process table, the `ss` / `ip` reads and the VPN
// probe are the test's (0.1 §3); nothing here reads the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { validateReceipt, validateTopology, validateFinding } from '../../src/cli/schema.mjs'
import { renderRoutes, routeRows } from '../../src/netenv/topology-text.mjs'
import { installedViaCli, snapshot } from './fixtures/dispatch-ctx.mjs'
import { claudeProc } from './fixtures/status-ctx.mjs'

const ENGINE = { status: { engine: { port: 47123 } } } // what the daemon's /status says of its engine
const SS_MIHOMO = 'LISTEN 0 4096 127.0.0.1:7897 0.0.0.0:* users:(("verge-mihomo",pid=11800,fd=7))'
/** The recording runner of the sandbox, except that `ss` lists a mihomo core on :7897 (the owner is the only name asight shows, D49). */
const withMihomo = (s) => (file, args, o) => (file === 'ss' ? { status: 0, stdout: SS_MIHOMO, stderr: '' } : s.sys.exec.run(file, args, o))
const status = async (s, argv = [], deps = {}) => {
  const r = await s.run(['status', ...argv], { deps })
  return { ...r, text: r.io.stdoutText(), json: () => r.io.json() }
}

test('V43: the one-screen summary (§3.5) draws no chain — the paths live in `status <harness>` and in the document, so the summary stays one screen', async () => {
  const s = await installedViaCli(ENGINE)
  const text = (await status(s)).text
  assert.ok(!/ -> /.test(text), text)
  assert.ok(!/^ {2}Routes/m.test(text), text)
  assert.match((await status(s, ['claude-code'])).text, /^ {2}Routes$/m, 'the named harness draws them')
})

test('V43: `--json` carries `topology` — one HarnessTopology per harness in the table, each valid, with the verdict the table gave; the receipt validates and stdout is the one document', async () => {
  const s = await installedViaCli()
  const r = await status(s, ['--json'], { procs: async () => [claudeProc(4121, Date.parse('2099-01-01T00:00:00Z'))] })
  const doc = r.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual(validateTopology(doc.topology), [])
  assert.deepEqual(Object.keys(doc.topology), Object.keys(doc.harnesses), 'the harnesses of the table, in its order')
  for (const [h, x] of Object.entries(doc.harnesses)) assert.deepEqual([doc.topology[h].captured, doc.topology[h].reason], [x.captured, x.reason], `${h}: the topology and the table say the same of it`)
  assert.equal(r.io.stderrText(), '')
})

test('V43: every hop name in the text is some node\'s name — the `Routes` rows of `status <harness>` are made of the topology and of nothing else', async () => {
  const s = await installedViaCli()
  const doc = (await status(s, ['--json'])).json()
  const ids = Object.keys(doc.topology)
  const text = (await status(s, ids)).text
  for (const h of ids) {
    const t = doc.topology[h]
    for (const line of renderRoutes(t)) assert.ok(text.includes(line), `${h}: the text has the row as the topology draws it: ${line}`)
    for (const [, c] of routeRows(t)) for (const hop of c.split(' -> ').map((x) => x.replace(/^\[[^\]]*\] /, ''))) assert.ok(t.nodes.some((n) => hop.startsWith(n.name)), `${h}: ${hop} is a node`)
  }
})

test('§3.5: `status` writes nothing — no copy of the topology of its own (the board\'s netenv.json is the daemon\'s to write); the document carries the topology instead', async () => {
  const s = await installedViaCli()
  const doc = (await status(s, ['--json'])).json()
  assert.deepEqual(validateTopology(doc.topology), [])
  assert.ok(!fs.existsSync(path.join(s.home, '.asight', 'netenv.json')), 'status drew the topology and recorded nothing')
  await status(s, ['codex'])
  assert.ok(!fs.existsSync(path.join(s.home, '.asight', 'netenv.json')))
})

test('V44: `asight net` and `asight proxy codex http://x` are not commands: exit 2 and the HOME byte for byte what it was — the topology is a view of `status`, not a verb', async () => {
  const s = await installedViaCli()
  const before = snapshot(s.home)
  for (const argv of [['net'], ['proxy', 'codex', 'http://x']]) {
    const r = await s.run(argv)
    assert.equal(r.exit, 2, argv.join(' '))
    // the manual's own line (1.6 §1.3): `asight: unknown command '<name>'. Run: asight help`
    assert.match(r.io.stderrText(), /unknown command '(net|proxy)'/)
  }
  assert.deepEqual(snapshot(s.home), before)
})

test('V44: `status codex` draws the detail — the path a hop to a line, `without asight`, how to change the proxy — and `status` without a name does not', async () => {
  const s = await installedViaCli(ENGINE)
  const one = (await status(s, ['codex'])).text
  assert.match(one, /^codex: on, /m)
  assert.match(one, /^ {4}new processes {2}.*api\.openai\.com/m)
  assert.match(one, /^ {4}without asight {2}.*api\.openai\.com/m)
  assert.match(one, /^ {2}To change the proxy: edit codex's own settings/m)
  assert.doesNotMatch(one, /seconds? ago/)
  const all = (await status(s)).text
  assert.doesNotMatch(all, /without asight|To change the proxy/)
  assert.doesNotMatch(one, /^ {4}(new processes|without asight)[^\n]*claude-code/m, 'only the named harness is drawn in detail')
})

test('§9.2: the document carries when the paths were read (`at`), and the text prints no probe age of its own', async () => {
  const s = await installedViaCli(ENGINE)
  let t = Date.parse('2026-10-07T10:00:00Z')
  const r = await status(s, ['codex'], { ms: () => (t += 1000) }) // a second passes at every read of the clock: the paths are drawn before the text is
  assert.doesNotMatch(r.text, /seconds? ago/)
  const doc = (await status(s, ['--json'], { ms: () => (t += 1000) })).json()
  assert.match(doc.topology.codex.at, /^2026-10-07T10:00:/, doc.topology.codex.at)
})

test('V44/D49: with asight on the path the detail says the one line about a VPN / proxy\'s per-process rules, product or none — and only there: not in `status`, not in `on --dry-run`', async () => {
  const s = await installedViaCli()
  const line = 'If your VPN or proxy routes by process, it sees asight, not codex.'
  const deps = { exec: withMihomo(s) }
  assert.ok((await status(s, ['codex'], deps)).text.includes(line))
  assert.ok(!(await status(s, [], deps)).text.includes('it sees asight'), 'the summary does not say it')
  assert.ok((await status(s, ['codex'])).text.includes(line), 'no VPN detected: the same line, nothing to find')
  const dry = await s.run(['on', 'codex', '--dry-run'], { deps })
  assert.ok(!dry.io.text().includes('it sees asight'), '`on`\'s plan does not print it')
})

test('a failure to build the topology is said in the text and in --json (`topology_error`), and changes neither the table nor the exit code; nothing is drawn in its place', async () => {
  const s = await installedViaCli(ENGINE)
  const plain = await status(s, ['codex'])
  const broken = await status(s, ['codex'], { netFactsDeps: async () => { throw new Error('boom: no facts') } })
  assert.equal(broken.exit, plain.exit)
  assert.match(broken.text, /^ {2}Routes: unknown \(boom: no facts\)$/m)
  assert.doesNotMatch(broken.text, / -> /)
  const doc = (await status(s, ['--json'], { netFactsDeps: async () => { throw new Error('boom: no facts') } })).json()
  assert.equal(doc.topology_error, 'boom: no facts')
  assert.equal(doc.topology, undefined)
  assert.deepEqual(validateReceipt(doc), [])
  const capturedOf = (d) => Object.fromEntries(Object.entries(d.harnesses).map(([h, x]) => [h, x.captured]))
  assert.deepEqual(capturedOf(doc), capturedOf((await status(s, ['--json'])).json()))
})

test('V42: one hop that cannot be read changes no exit code and no verdict — it is said in the row (`unknown: owner-unreadable`, then `?`) and in --json, and `captured` stays what the rest of the facts say', async () => {
  const s = await installedViaCli(ENGINE)
  const before = await status(s)
  assert.equal(before.exit, 0)
  // claude-code's own proxy is on a port whose owner `ss` cannot name (another user's listener)
  const file = path.join(s.home, '.claude', 'settings.json'), doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...doc, env: { ...doc.env, HTTPS_PROXY: 'http://127.0.0.1:7891' } }, null, 2))
  const nobody = (f, args, o) => (f === 'ss' ? { status: 0, stdout: 'LISTEN 0 4096 127.0.0.1:7891 0.0.0.0:*', stderr: '' } : s.sys.exec.run(f, args, o))
  const r = await status(s, ['claude-code'], { exec: nobody })
  assert.match(r.text, /^ {4}new processes$\n^ {6}claude-code -> asight :47123 -> 127\.0\.0\.1:7891 \(unknown: owner-unreadable\) -> unknown$/m, r.text)
  assert.equal(r.exit, before.exit, 'a hop that cannot be read is not a verdict that cannot be given: only `captured` null exits 3 (1.6 §2)')
  const j = (await status(s, ['--json'], { exec: nobody })).json()
  assert.deepEqual([j.topology['claude-code'].captured, j.topology['claude-code'].on_path], [true, true])
  assert.equal(j.topology['claude-code'].nodes.find((n) => n.kind === 'proxy').unknown.reason, 'owner-unreadable')
  assert.equal(j.harnesses['claude-code'].captured, true, 'and the table says the same')
  assert.equal((await status(s, ['--json'], { exec: nobody })).exit, before.exit)
})

test('1.6 §9.6: when the findings cannot be made `doctor --json` has `findings: null` and `findings_error` (the topology\'s reason), the text says unknown and not "no problems", and nothing else changes; when they were read and there are none, `findings` is []', async () => {
  const s = await installedViaCli(ENGINE)
  const none = path.join(s.home, 'none')
  const fine = await s.run(['doctor', '--json'], { env: { ...s.ctx().env, ASIGHT_SOURCE: none } })
  const fineDoc = fine.io.json()
  assert.ok(Array.isArray(fineDoc.findings), '`[]` or a list: it was read')
  assert.equal(fineDoc.findings_error, undefined)
  const broken = await s.run(['doctor', '--json'], { env: { ...s.ctx().env, ASIGHT_SOURCE: none }, deps: { netFactsDeps: async () => { throw new Error('boom: no facts') } } })
  const doc = broken.io.json()
  assert.deepEqual([doc.findings, doc.findings_error], [null, 'boom: no facts'])
  assert.equal(broken.exit, fine.exit, 'a finding that could not be made is not a verdict that doctor could not give')
  const capturedOf = (d) => Object.fromEntries(Object.entries(d.status.harnesses).map(([h, x]) => [h, x.captured]))
  assert.deepEqual(capturedOf(doc), capturedOf(fineDoc))
  const text = (await s.run(['doctor'], { env: { ...s.ctx().env, ASIGHT_SOURCE: none }, deps: { netFactsDeps: async () => { throw new Error('boom: no facts') } } })).io.stdoutText()
  assert.match(text, /^asight doctor: findings are unknown \(boom: no facts\)\.$/m)
  assert.doesNotMatch(text, /no problems/)
})

test('§3.5 / §3.7: neither `status` nor `doctor` writes a file — no rename of any kind in the HOME', async () => {
  const s = await installedViaCli(ENGINE)
  const renamed = []
  const spy = new Proxy(fs, { get: (o, k) => (k === 'renameSync' ? (a, b) => { renamed.push(b); return o.renameSync(a, b) } : o[k]) })
  await status(s, [], { fs: spy })
  await s.run(['doctor'], { env: { ...s.ctx().env, ASIGHT_SOURCE: path.join(s.home, 'none') }, deps: { fs: spy } })
  assert.deepEqual(renamed, [])
})

test('V44: `doctor codex --json` gives `findings` and every one of them is codex\'s; `doctor --json` gives the findings of all of them; the topology of `status --json` carries the codes of its harness', async () => {
  const s = await installedViaCli(ENGINE)
  const deps = { exec: withMihomo(s) }
  const some = fs.readFileSync(path.join(s.home, '.codex', '.env'), 'utf8')
  fs.writeFileSync(path.join(s.home, '.codex', '.env'), `${some}HTTPS_PROXY=socks5://127.0.0.1:7897\n`) // codex cannot speak SOCKS and goes straight out: a finding of its own
  const one = (await s.run(['doctor', 'codex', '--json'], { env: { ...s.ctx().env, ASIGHT_SOURCE: path.join(s.home, 'none') }, deps })).io.json()
  assert.ok(Array.isArray(one.findings) && one.findings.length > 0)
  assert.ok(one.findings.every((f) => f.harness === 'codex'), 'only codex\'s, none of the machine\'s')
  assert.ok(one.findings.some((f) => f.code === 'proxy-unsupported'))
  for (const f of one.findings) assert.deepEqual(validateFinding(f), [], f.code)
  const all = (await s.run(['doctor', '--json'], { env: { ...s.ctx().env, ASIGHT_SOURCE: path.join(s.home, 'none') }, deps })).io.json()
  assert.ok(new Set(all.findings.map((f) => f.harness)).size >= 1 && all.findings.some((f) => f.harness === 'codex'))
  const st = (await status(s, ['--json'], deps)).json()
  assert.ok(st.topology.codex.findings.includes('proxy-unsupported'), 'the board\'s topology carries the codes')
  assert.deepEqual(st.topology['claude-code'].findings.filter((c) => c === 'proxy-unsupported'), [])
  const text = (await s.run(['doctor', 'codex'], { env: { ...s.ctx().env, ASIGHT_SOURCE: path.join(s.home, 'none') }, deps })).io.stdoutText()
  assert.match(text, /^\d+\. codex does not support the proxy scheme/m)
  assert.match(text, /^ {3}Check {2}asight status codex$/m)
})
