// test/cli/status-topology.test.mjs — RFC 1.6 §9.1–§9.2 through the command line: `status` draws each harness's path under the mode header, `status <harness>` the detail, `--json` the same `topology` object the
// board reads (V43), and there is no `net` / `proxy` command (V44). Linux driver mode in a sandbox HOME of the dispatch fixture: the daemon's reply, the process table, the `ss` / `ip` reads and the VPN
// probe are the test's (0.1 §3); nothing here reads the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { validateReceipt, validateTopology, validateFinding } from '../../src/cli/schema.mjs'
import { captureHealth } from '../../src/health/read.mjs'
import { asightHome } from '../../src/off/paths.mjs'
import { renderCompact } from '../../src/netenv/topology.mjs'
import { installedViaCli, snapshot } from './fixtures/dispatch-ctx.mjs'
import { claudeProc, CLASH } from './fixtures/status-ctx.mjs'

const ENGINE = { status: { engine: { port: 47123 } } } // what the daemon's /status says of its engine
const SS_MIHOMO = 'LISTEN 0 4096 127.0.0.1:7897 0.0.0.0:* users:(("verge-mihomo",pid=11800,fd=7))'
/** The recording runner of the sandbox, except that `ss` lists a mihomo core on :7897 (what `CLASH()` says the product's port is). */
const withMihomo = (s) => (file, args, o) => (file === 'ss' ? { status: 0, stdout: SS_MIHOMO, stderr: '' } : s.sys.exec.run(file, args, o))
const status = async (s, argv = [], deps = {}) => {
  const r = await s.run(['status', ...argv], { deps })
  return { ...r, text: r.io.stdoutText(), json: () => r.io.json() }
}

test('V43: the 「各 harness 的路」 block follows the table, starts with the mode, and has a line per harness with the chain and the verdict', async () => {
  const s = await installedViaCli(ENGINE)
  const lines = (await status(s)).text.split('\n')
  const head = lines.findIndex((l) => l.startsWith('各 harness 的路('))
  assert.equal(lines[head], '各 harness 的路(驱动模式(eBPF) · 新连接 · 细节: asight status <harness>)')
  const table = lines.slice(0, head).filter((l) => /^ {2}\S+\s+正在被采集/.test(l)).map((l) => l.trim().split(/\s+/)[0])
  const drawn = lines.slice(head + 1).filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().split(/\s+/)[0])
  assert.deepEqual(drawn.slice(0, table.length), table, 'the harnesses of the table are the ones drawn, in its order, right after the header')
  assert.match(lines[head + 1], /^ {2}claude-code\s+claude-code → \[eBPF\] asight 引擎 :47123 → api\.anthropic\.com:443\(直连\)\s+在路径上 · 是$/)
  assert.ok(lines.slice(0, head).some((l) => l.startsWith('守护进程')), 'and the table comes first')
})

test('V43: `--json` carries `topology` — one HarnessTopology per harness in the table, each valid, with the verdict the table gave; the receipt validates and stdout is the one document', async () => {
  const s = await installedViaCli()
  const r = await status(s, ['--json'], { procs: async () => [claudeProc(4121, Date.parse('2099-01-01T00:00:00Z'))] })
  const doc = r.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual(validateTopology(doc.topology), [])
  assert.deepEqual(Object.keys(doc.topology), doc.harnesses.map((h) => h.harness), 'the harnesses of the table, in its order')
  for (const h of doc.harnesses) assert.deepEqual([doc.topology[h.harness].captured, doc.topology[h.harness].reason], [h.captured, h.reason], `${h.harness}: the topology and the table say the same of it`)
  assert.equal(r.io.stderrText(), '')
})

test('V43: every hop name in the text is some node\'s name — the compact lines are made of the topology and of nothing else — and so are those of `status <harness>`', async () => {
  const s = await installedViaCli()
  const doc = (await status(s, ['--json'])).json()
  const text = (await status(s)).text
  for (const [h, t] of Object.entries(doc.topology)) {
    for (const line of renderCompact(t)) {
      assert.ok(text.includes(line), `${h}: the text has the compact line as the topology draws it`)
      for (const hop of line.replace(/^(HTTP|WebSocket) /, '').split(' → ').map((x) => x.replace(/^\[[^\]]*\] /, ''))) assert.ok(t.nodes.some((n) => hop.startsWith(n.name)), `${h}: ${hop} is a node`)
    }
  }
})

test('V43: the board reads the same object — netenv.json holds the topology, and /api/capture-health\'s `netenv.topology` equals what `status --json` printed', async () => {
  const s = await installedViaCli()
  const doc = (await status(s, ['--json'])).json()
  const file = JSON.parse(fs.readFileSync(path.join(s.home, '.asight', 'netenv.json'), 'utf8'))
  assert.deepEqual(file.topology, doc.topology)
  const health = captureHealth({ home: asightHome(s.home) })
  assert.deepEqual(JSON.parse(JSON.stringify(health.netenv.topology)), doc.topology)
  assert.equal(fs.statSync(path.join(s.home, '.asight', 'netenv.json')).mode & 0o777, 0o600)
  // `status codex` redraws codex only: the others keep what they had
  const before = JSON.parse(fs.readFileSync(path.join(s.home, '.asight', 'netenv.json'), 'utf8')).topology
  await status(s, ['codex'])
  const after = JSON.parse(fs.readFileSync(path.join(s.home, '.asight', 'netenv.json'), 'utf8')).topology
  assert.deepEqual(Object.keys(after), Object.keys(before))
  assert.deepEqual(after['claude-code'], before['claude-code'])
})

test('V44: `asight net` and `asight proxy codex http://x` are not commands: exit 2 and the HOME byte for byte what it was — the topology is a view of `status`, not a verb', async () => {
  const s = await installedViaCli()
  const before = snapshot(s.home)
  for (const argv of [['net'], ['proxy', 'codex', 'http://x']]) {
    const r = await s.run(argv)
    assert.equal(r.exit, 2, argv.join(' '))
    assert.match(r.io.stderrText(), /没有这个命令/)
  }
  assert.deepEqual(snapshot(s.home), before)
})

test('V44: `status codex` draws the detail — the path a hop to a line, 「关掉 asight 时的路」, 「要换代理」 — and `status` without a name does not', async () => {
  const s = await installedViaCli(ENGINE)
  const one = (await status(s, ['codex'])).text
  assert.match(one, /^codex · 开 · 驱动模式\(eBPF\) · 被采集: /m)
  assert.match(one, /^关掉 asight 时的路: .*api\.openai\.com/m)
  assert.match(one, /^要换代理: 照常改 codex 的设置/m)
  assert.match(one, /^新连接的路  /m)
  const all = (await status(s)).text
  assert.doesNotMatch(all, /关掉 asight 时的路|要换代理/)
  assert.doesNotMatch(one, /^\s+→ .*claude-code/m, 'only the named harness is drawn in detail')
})

test('V44: with a VPN product on the machine the detail says the one line about its per-process rules — and only there: not in `status`, not in `on --dry-run`', async () => {
  const s = await installedViaCli()
  const line = '你的 VPN 按进程分流时,看到的来源是 asight,不是 codex'
  const deps = { netenv: async () => CLASH({ mixed_port: 7897 }), exec: withMihomo(s) }
  assert.ok((await status(s, ['codex'], deps)).text.includes(line))
  assert.ok(!(await status(s, [], deps)).text.includes('看到的来源是 asight'), 'the compact block does not say it')
  assert.ok(!(await status(s, ['codex'])).text.includes('看到的来源是 asight'), 'no VPN product detected: no such line')
  const dry = await s.run(['on', 'codex', '--dry-run'], { deps })
  assert.ok(!dry.io.text().includes('看到的来源是 asight'), '`on`\'s plan does not print it')
})

test('a failure to build the topology is said in the text and in --json (`topology_error`), and changes neither the table nor the exit code; nothing is drawn in its place', async () => {
  const s = await installedViaCli(ENGINE)
  const plain = await status(s)
  const broken = await status(s, [], { netFactsDeps: async () => { throw new Error('boom: no facts') } })
  assert.equal(broken.exit, plain.exit)
  assert.match(broken.text, /^各 harness 的路: 不知道\(boom: no facts\)$/m)
  assert.doesNotMatch(broken.text, /→ \[eBPF\]/)
  const doc = (await status(s, ['--json'], { netFactsDeps: async () => { throw new Error('boom: no facts') } })).json()
  assert.equal(doc.topology_error, 'boom: no facts')
  assert.equal(doc.topology, undefined)
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual(doc.harnesses.map((h) => h.captured), (await status(s, ['--json'])).json().harnesses.map((h) => h.captured))
})

test('status writes ~/.asight/netenv.json once per run, with the probe and the topology in the same file (the board never sees one without the other)', async () => {
  const s = await installedViaCli(ENGINE)
  const renamed = []
  const spy = new Proxy(fs, { get: (o, k) => (k === 'renameSync' ? (a, b) => { renamed.push(b); return o.renameSync(a, b) } : o[k]) })
  await status(s, [], { fs: spy })
  assert.deepEqual(renamed.filter((f) => f.endsWith('netenv.json')), [path.join(s.home, '.asight', 'netenv.json')])
  const file = JSON.parse(fs.readFileSync(path.join(s.home, '.asight', 'netenv.json'), 'utf8'))
  assert.ok(Array.isArray(file.products) && file.topology['claude-code'], 'the probe\'s result and the topology')
})

test('V44: `doctor codex --json` gives `findings` and every one of them is codex\'s; `doctor --json` gives the findings of all of them; the topology of `status --json` carries the codes of its harness', async () => {
  const s = await installedViaCli(ENGINE)
  const deps = { netenv: async () => CLASH({ mixed_port: 7897 }), exec: withMihomo(s) }
  const some = fs.readFileSync(path.join(s.home, '.codex', '.env'), 'utf8')
  fs.writeFileSync(path.join(s.home, '.codex', '.env'), `${some}HTTPS_PROXY=socks5://127.0.0.1:7897\n`) // codex cannot speak SOCKS and goes straight out: a finding of its own
  const one = (await s.run(['doctor', 'codex', '--json', '--source', path.join(s.home, 'none')], { deps })).io.json()
  assert.ok(Array.isArray(one.findings) && one.findings.length > 0)
  assert.ok(one.findings.every((f) => f.harness === 'codex'), 'only codex\'s, none of the machine\'s')
  assert.ok(one.findings.some((f) => f.code === 'proxy-unsupported'))
  for (const f of one.findings) assert.deepEqual(validateFinding(f), [], f.code)
  const all = (await s.run(['doctor', '--json', '--source', path.join(s.home, 'none')], { deps })).io.json()
  assert.ok(new Set(all.findings.map((f) => f.harness)).size >= 1 && all.findings.some((f) => f.harness === 'codex'))
  const st = (await status(s, ['--json'], deps)).json()
  assert.ok(st.topology.codex.findings.includes('proxy-unsupported'), 'the board\'s topology carries the codes')
  assert.deepEqual(st.topology['claude-code'].findings.filter((c) => c === 'proxy-unsupported'), [])
  const text = (await s.run(['doctor', 'codex', '--source', path.join(s.home, 'none')], { deps })).io.stdoutText()
  assert.match(text, /\[失败\] codex · proxy-unsupported — /)
  assert.match(text, /怎么验证: asight status codex/)
})
