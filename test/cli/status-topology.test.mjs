// test/cli/status-topology.test.mjs — RFC 1.6 §9.1–§9.2 through the command line: `status` draws each harness's path under the mode header, `status <harness>` the detail, `--json` the same `topology` object the
// board reads (V43), and there is no `net` / `proxy` command (V44). Linux driver mode in a sandbox HOME of the dispatch fixture: the daemon's reply, the process table, the `ss` / `ip` reads and the VPN
// probe are the test's (0.1 §3); nothing here reads the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { validateReceipt, validateTopology, validateFinding } from '../../src/cli/schema.mjs'
import { captureHealth } from '../../src/health/read.mjs'
import { createServer } from '../../src/server.mjs'
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

test('V43: the digest draws a per-harness line under 路径 for every harness whose path is known — the chain and the verdict as the topology draws them (the mode rides the [eBPF] label; the block header with the probe age lives in the detail view)', async () => {
  const s = await installedViaCli(ENGINE)
  const lines = (await status(s)).text.split('\n')
  const head = lines.findIndex((l) => l.startsWith('路径    '))
  assert.ok(head >= 1, 'the 路径 row is there, below the verdict rows')
  const drawn = lines.slice(head + 1).filter((l) => /^ {2}\S/.test(l) && l.includes(' → '))
  assert.deepEqual(drawn.map((l) => l.trim().split(/\s+/)[0]), ['claude-code', 'codex', 'hermes', 'opencode', 'deepseek-dsh', 'kimi-code', 'z-code'], 'every harness with a known path is drawn, in the digest\'s order, right after 路径')
  assert.match(lines[head + 1], /^ {2}claude-code\s+claude-code → \[eBPF\] asight 引擎 :47123 → api\.anthropic\.com:443\(直连\)\s+在路径上 · 是$/)
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
  // and through the route the board fetches (`GET /api/capture-health` over HTTP, from the home `serve` reads): the same object, field for field
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: null, healthHome: asightHome(s.home) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const body = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/capture-health' }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, b })) }).on('error', reject))
    assert.equal(body.status, 200)
    assert.deepEqual(JSON.parse(body.b).netenv.topology, doc.topology, 'the route\'s netenv.topology is what `status --json` printed')
  } finally { server.close() }
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
  assert.match(one, /^新连接的路 · \d+ 秒前探测  /m)
  const all = (await status(s)).text
  assert.doesNotMatch(all, /关掉 asight 时的路|要换代理/)
  assert.doesNotMatch(one, /^\s+→ .*claude-code/m, 'only the named harness is drawn in detail')
})

test('§9.2 「N 秒前探测」: the header of the block and the first line of the detail say how long ago the paths were probed, by the clock `status` runs on (the example of the spec prints it; no caller used to pass a clock)', async () => {
  const s = await installedViaCli(ENGINE)
  let t = Date.parse('2026-10-07T10:00:00Z')
  const r = await status(s, ['codex'], { ms: () => (t += 1000) }) // a second passes at every read of the clock: the paths are drawn before the text is
  const head = r.text.split('\n').find((l) => l.startsWith('各 harness 的路('))
  const n = Number((/ · (\d+) 秒前探测 · /.exec(head) || [])[1])
  assert.ok(n >= 1, head)
  assert.match(r.text, new RegExp(`^新连接的路 · ${n} 秒前探测  `, 'm'), 'the detail says the same of the same probe')
  assert.doesNotMatch((await status(s, ['--json'], { ms: () => (t += 1000) })).text, /秒前探测/, '--json has the topology\'s `at`, and no words')
})

test('V44/D49: with asight on the path the detail says the one line about a VPN / proxy\'s per-process rules, product or none — and only there: not in `status`, not in `on --dry-run`', async () => {
  const s = await installedViaCli()
  const line = '若你的 VPN / 代理按进程分流,它看到的来源是 asight,不是 codex'
  const deps = { netenv: async () => CLASH({ mixed_port: 7897 }), exec: withMihomo(s) }
  assert.ok((await status(s, ['codex'], deps)).text.includes(line))
  assert.ok(!(await status(s, [], deps)).text.includes('看到的来源是 asight'), 'the compact block does not say it')
  assert.ok((await status(s, ['codex'])).text.includes(line), 'no VPN detected: the same line, nothing to find')
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

test('V42: one hop that cannot be read changes no exit code and no verdict — it is said in the line (「不知道 · owner-unreadable」, then 「?」) and in --json, and `captured` stays what the rest of the facts say', async () => {
  const s = await installedViaCli(ENGINE)
  const before = await status(s)
  assert.equal(before.exit, 0)
  // claude-code's own proxy is on a port whose owner `ss` cannot name (another user's listener)
  const file = path.join(s.home, '.claude', 'settings.json'), doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...doc, env: { ...doc.env, HTTPS_PROXY: 'http://127.0.0.1:7891' } }, null, 2))
  const nobody = (f, args, o) => (f === 'ss' ? { status: 0, stdout: 'LISTEN 0 4096 127.0.0.1:7891 0.0.0.0:*', stderr: '' } : s.sys.exec.run(f, args, o))
  const r = await status(s, [], { exec: nobody })
  assert.match(r.text, /^ {2}claude-code\s+claude-code → \[eBPF\] asight 引擎 :47123 → \[CONNECT 原样转\] 127\.0\.0\.1:7891\(不知道 · owner-unreadable\) → \?\s+在路径上 · 是$/m)
  assert.equal(r.exit, before.exit, 'a hop that cannot be read is not a verdict that cannot be given: only `captured` null exits 3 (1.6 §2)')
  const j = (await status(s, ['--json'], { exec: nobody })).json()
  assert.deepEqual([j.topology['claude-code'].captured, j.topology['claude-code'].on_path], [true, true])
  assert.equal(j.topology['claude-code'].nodes.find((n) => n.kind === 'proxy').unknown.reason, 'owner-unreadable')
  assert.equal(j.harnesses.find((h) => h.harness === 'claude-code').captured, true, 'and the table says the same')
  assert.equal((await status(s, ['--json'], { exec: nobody })).exit, before.exit)
})

test('1.6 §9.6: when the findings cannot be made `doctor --json` has `findings: null` and `findings_error` (the topology\'s reason), the text says 「不知道(…)」 and not 「没有」, and nothing else changes; when they were read and there are none, `findings` is []', async () => {
  const s = await installedViaCli(ENGINE)
  const none = path.join(s.home, 'none')
  const fine = await s.run(['doctor', '--json', '--source', none])
  const fineDoc = fine.io.json()
  assert.ok(Array.isArray(fineDoc.findings), '`[]` or a list: it was read')
  assert.equal(fineDoc.findings_error, undefined)
  const broken = await s.run(['doctor', '--json', '--source', none], { deps: { netFactsDeps: async () => { throw new Error('boom: no facts') } } })
  const doc = broken.io.json()
  assert.deepEqual([doc.findings, doc.findings_error], [null, 'boom: no facts'])
  assert.equal(broken.exit, fine.exit, 'a finding that could not be made is not a verdict that doctor could not give')
  assert.deepEqual(doc.status.harnesses.map((h) => h.captured), fineDoc.status.harnesses.map((h) => h.captured))
  const text = (await s.run(['doctor', '--source', none], { deps: { netFactsDeps: async () => { throw new Error('boom: no facts') } } })).io.stdoutText()
  assert.match(text, /^ *发现\(网络与采集\): 不知道\(boom: no facts\)$/m)
  assert.doesNotMatch(text, /发现\(网络与采集\): 没有/)
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
