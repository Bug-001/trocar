// test/off/standalone.test.mjs — the single-file ~/.trocar/bin/trocar-off (RFC 1.6 R3). V2: with the repository out of reach it undoes the same entries and prints what
// `trocar off` prints. V11: what is generated imports node:* and nothing else. V35: a manifest or an item it does not know is left alone (exit 1, the hint is `trocar off`), `doctor`'s
// check reports a stale copy, and every `on` rewrites it. A sandbox HOME in which the real `on` has run; the file that `on` wrote is the file that runs, in a child process that is
// handed a copy in a directory of its own (no relative import could find the repo), a PATH of stubs (the sandbox guard allows those, and nothing else), and no NODE_PATH.
// Nothing here runs a real OS tool or touches a real process.
import test from 'node:test'
import { runInstallCli } from '../../src/cli/install.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { buildStandalone, writeStandalone, checkStandalone, STANDALONE_ENTRY } from '../../src/off/standalone.mjs'
import { OFF_VERSION, MANIFEST_VERSION, readManifest, saveManifest, manifestPath, KNOWN_KINDS, FILE_ENTRY_KINDS } from '../../src/off/manifest.mjs'
import { standalonePath } from '../../src/off/paths.mjs'
import { sha256 } from '../../src/off/fsutil.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { formatPlan } from '../../src/cli/receipt.mjs'
import { fakeIo, onCtx, seedClaude } from '../cli/fixtures/on-ctx.mjs'
import { installedHome, flowEvents } from './fixtures/off-ctx.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ── running a copy ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// What trocar-off calls at the end of the file. The tests that need a Linux answer on any machine, with no real uid and no real process table, replace exactly this call (and assert
// first that it is there): the platform, the user id and the table's reader are what a person's machine decides, and every other byte of the file is the one `on` wrote.
// The whole world is linux now — before the flip checklist ① (4.9 §4) `deps.platform: 'darwin'` was a free way to make the table's reader use the `ps` stub, but the off HAS a
// darwin arm today (the LaunchAgent undo), so a darwin platform in deps would send the copy down it. The table is injected instead (a function literal — this entry is source the
// test writes), the same empty table cliCtx's offDeps injects, so the copy needs no /proc on whatever machine runs the tests and the receipts still compare key for key.
const AS_LINUX = `runOffCli(process.argv.slice(2), { standalone: true, platform: 'linux', deps: { platform: 'linux', procs: async () => [], getuid: () => 1000 } })`

function stubBin() {
  const dir = tmpDir('trocar-stub-'), bin = path.join(dir, 'bin'), log = path.join(dir, 'calls.log')
  fs.mkdirSync(bin)
  for (const name of ['systemctl']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`, { mode: 0o755 }) // answers 0 and says nothing: no unit; the process table is injected, so no `ps` is asked
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) }
}

/** Runs `text` as a file called trocar-off in a directory of its own; resolves { status, stdout, stderr }. */
function runCopy(text, argv, { env = {}, nodeArgs = [], sibling = null } = {}) {
  const dir = tmpDir('trocar-std-')
  const file = path.join(dir, 'trocar-off')
  fs.writeFileSync(file, text, { mode: 0o755 })
  for (const [name, body] of Object.entries(sibling || {})) fs.writeFileSync(path.join(dir, name), body)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, file, ...argv], { cwd: dir, env: { NODE_PATH: '', TROCAR_TEST_SANDBOX: '1', TMPDIR: os.tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = [], err = []
    child.stdout.on('data', (d) => out.push(d)); child.stderr.on('data', (d) => err.push(d))
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`trocar-off did not exit in 30 s; stdout so far: ${Buffer.concat(out)}`)) }, 30_000)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }) })
  })
}

/** The file `on` wrote for this sandbox, run with the Linux answer; the sandbox's own HOME and env, the stub PATH. */
function runWritten(s, argv, { extraEnv = {}, stubs = stubBin() } = {}) {
  const text = fs.readFileSync(standalonePath(s.home), 'utf8')
  assert.ok(text.includes(STANDALONE_ENTRY), 'the file ends with the standard entry call')
  return runCopy(text.replace(STANDALONE_ENTRY, AS_LINUX), argv, { env: { ...s.sh.env, PATH: stubs.bin, ...extraEnv } }).then((r) => ({ ...r, stubs }))
}

// two sandboxes in the same state never hold the same paths, times or backup names: what a receipt says is compared with those taken out
const normalize = (obj, home) => JSON.parse(JSON.stringify(obj).split(home).join('<HOME>').replace(/[0-9a-f]{16}-\d{8}T\d{9}Z(-\d+)?/g, '<BACKUP>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<TIME>'))
const cliCtx = (s, io) => ({ io, home: s.home, env: s.sh.env, platform: 'linux', deps: s.offDeps({ getuid: () => 1000 }) })
const brokenTrocar = async () => { const s = await installedHome({ names: ['claude-code', 'codex'] }); s.sys.daemon.state.up = false; return s } // on has run; nothing answers any more
const preEntries = (s) => readManifest(s.dir).entries.filter((e) => e.pre_sha256).map((e) => ({ path: e.path, pre: e.pre_sha256 }))
const backToBefore = (list) => list.filter((e) => !fs.existsSync(e.path) || sha256(fs.readFileSync(e.path)) !== e.pre).map((e) => e.path)

// ── V2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('V2: with the repository out of reach the copy install wrote does what `trocar off` does — no certificate entry taken (D55①) — and prints what it prints (the daemon gone)', async () => {
  const a = await brokenTrocar(), b = await brokenTrocar()
  const io = fakeIo(), kept = readManifest(b.dir).entries.map((e) => [e.harness, e.kind, e.path])
  const viaCli = await runOffCli(['--json'], cliCtx(a, io))
  const r = await runWritten(b, ['--json'])
  assert.equal(r.status, viaCli, r.stderr)
  assert.equal(viaCli, 0, 'and it is a done off')
  assert.deepEqual(normalize(JSON.parse(r.stdout), b.home), normalize(io.json(), a.home), 'the same receipt, key for key')
  assert.deepEqual([backToBefore(preEntries(b)).length, JSON.parse(r.stdout).changed], [preEntries(b).length, []], 'every certificate entry install wrote is still in (D55①): the copy, like off, takes none')
  assert.deepEqual(readManifest(b.dir).entries.map((e) => [e.harness, e.kind, e.path]), kept, 'and its manifest keeps the same entries')
  assert.ok(!r.stubs.calls().some((c) => /disable/.test(c)), `D61: no off disables the autostart, the copy included (${r.stubs.calls()})`)
  assert.equal(r.stderr, '')
})

test('V2: the text a person reads is the same too, and a per-harness off leaves the other harness alone', async () => {
  const a = await brokenTrocar(), b = await brokenTrocar()
  const io = fakeIo()
  assert.equal(await runOffCli(['claude'], cliCtx(a, io)), 0)
  const r = await runWritten(b, ['claude'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.split(b.home).join('~').replace(/\n$/, ''), io.stdoutText().split(a.home).join('~').replace(/\n$/, ''), 'the same words')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.dir, 'state.json'), 'utf8')).harnesses.codex.desired, 'on', 'only claude-code was turned off')
  assert.deepEqual([...new Set(readManifest(b.dir).entries.map((e) => e.harness).filter(Boolean))].sort(), ['claude-code', 'codex'], 'and the certificate entries of both stay (D55①)')
})

test('V2: with the install manifest lost the copy undoes by trocar\'s own marks, after a yes, and prints what `trocar off --yes` prints', async () => {
  const a = await brokenTrocar(), b = await brokenTrocar()
  const before = preEntries(b)
  for (const s of [a, b]) fs.rmSync(manifestPath(s.dir))
  const io = fakeIo()
  const viaCli = await runOffCli(['--yes', '--json'], cliCtx(a, io))
  const r = await runWritten(b, ['--yes', '--json'])
  assert.equal(r.status, viaCli, r.stderr)
  assert.equal(viaCli, 0, io.text())
  const out = JSON.parse(r.stdout)
  assert.deepEqual(normalize(out, b.home), normalize(io.json(), a.home))
  assert.equal(out.undone_by_marker, true)
  for (const e of before) assert.ok(!fs.readFileSync(e.path, 'utf8').includes(path.join(b.home, '.trocar')), `${e.path} no longer points into ~/.trocar (by marks the file is not promised byte for byte: nothing says what was there before)`)
  const nobody = await runWritten(await brokenTrocar().then((s) => { fs.rmSync(manifestPath(s.dir)); return s }), ['--json'])
  assert.equal(nobody.status, 1, 'not in a terminal and no --yes: it lists, and stops')
  assert.equal(JSON.parse(nobody.stdout).pending.length >= 2, true)
})

// a control socket in a short path (a unix socket's path is at most 103 bytes on macOS), answering from a fake daemon
async function serveControl(daemon) {
  const run = tmpDir('as-')
  fs.mkdirSync(path.join(run, 'trocar'), { mode: 0o700 })
  const sock = path.join(run, 'trocar', 'collector.sock')
  if (sock.length > 100) return { skip: `the socket path ${sock} is too long for a unix socket` }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
        const reply = await daemon.request({ method: req.method, path: req.url, body })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply))
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message) })) }
    })
  })
  await new Promise((resolve) => server.listen(sock, resolve))
  return { run, server, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('V2: a daemon that answers is told to switch off by the copy, over the control socket, and the receipt is the same', async (t) => {
  const a = await installedHome({ names: ['claude-code', 'codex'] }), b = await installedHome({ names: ['claude-code', 'codex'] }) // both daemons up after on
  const ctl = await serveControl(b.sys.daemon)
  if (ctl.skip) return t.skip(ctl.skip)
  try {
    const io = fakeIo()
    const viaCli = await runOffCli(['--json'], cliCtx(a, io))
    const r = await runWritten(b, ['--json'], { extraEnv: { XDG_RUNTIME_DIR: ctl.run } })
    assert.equal(r.status, viaCli, r.stderr)
    assert.deepEqual(normalize(JSON.parse(r.stdout), b.home), normalize(io.json(), a.home))
    assert.deepEqual(b.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), a.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), 'the copy posted the same off request')
    assert.ok(b.sys.daemon.calls.some((c) => c.startsWith('POST /off') && c.includes('"exit":true')), 'no names: the daemon was asked to go once drained')
  } finally { await ctl.close() }
})

// ── what it is made of ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('V11: what is generated imports node:* and nothing else — no import or export statement, no require, no dynamic import; every built-in comes in through the one loader, by a literal name', () => {
  const text = buildStandalone({ version: 'test' })
  assert.match(text, /^#!\/usr\/bin\/env node\n\/\/ trocar-off test — generated from src\/off by trocar on; do not edit\n/, 'the shebang and the version line, first')
  assert.equal(buildStandalone({ version: 'test' }), text, 'the same text every time: `on` compares it with what is on disk')
  const calls = [...text.matchAll(/__trocarLoad\(/g)].length
  const specs = [...text.matchAll(/__trocarLoad\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2])
  assert.ok(specs.length >= 8, `it loads the built-ins the undo side uses: ${specs}`)
  assert.equal(specs.length, calls, 'every call of the loader names a built-in by a literal')
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), [], 'node:* only')
  const bare = text.split('\n').filter((l) => /^\s*(import|export)\s/.test(l) || /\brequire\s*\(/.test(l.replace(/typeof require/g, '')) || /\bimport\s*\(/.test(l))
  assert.deepEqual(bare, [], 'nothing else brings code in')
  assert.ok(!/from\s+['"]\.{1,2}\//.test(text.replace(/\/\/.*$/gm, '')), 'and no relative path is left')
  for (const fn of ['osRootsFor', 'osBundleRoots', 'darwinRoots', 'windowsRoots']) assert.match(text, new RegExp(`function ${fn}\\(`), `${fn} rides along: the copy rebuilds a gone bundle with the platform's own reader (4.6 撤销顺序 第 2 步)`)
})

// The file has no extension: which kind of module Node takes it for is up to the Node (and a package.json somewhere above it). It is written to be right either way.
test('the file runs however Node takes a file with no extension: not as an ES module (no detection), and as one (a package.json of type module above it)', async () => {
  const text = buildStandalone({ version: 'test' })
  const usage = async (opts) => { const r = await runCopy(text, ['--bogus'], opts); assert.deepEqual([r.status, /unknown option '--bogus'/.test(r.stderr)], [2, true], `${JSON.stringify(opts)}: ${r.stderr}`) }
  await usage({}) // parses its own arguments and prints on the process's streams
  if (spawnSync(process.execPath, ['--no-experimental-detect-module', '-e', '0']).status === 0) await usage({ nodeArgs: ['--no-experimental-detect-module'] })
  if (typeof process.getBuiltinModule === 'function') await usage({ sibling: { 'package.json': '{"type":"module"}\n' } })
})

// ── what the generator refuses ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const tree = (files) => { const dir = tmpDir('trocar-gen-'); for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t); return dir }
const GOOD = {
  'main.mjs': "import { help } from './help.mjs'\nexport async function runOffCli(argv) { console.log(help(argv)); return 7 }\n",
  'help.mjs': "import { shout } from './util.mjs'\nexport const help = (a) => shout(a)\n",
  'util.mjs': 'export const shout = (s) => s\n',
}

test('the generator: dependencies come first, a built-in is loaded once however a module names it, a template literal that looks like code stays text, and the file runs', async () => {
  const dir = tree({
    ...GOOD,
    'help.mjs': "import nodeFs from 'node:fs'\nimport path, { sep as pathSep } from 'node:path'\nimport * as nodeOs from 'node:os'\nimport { shout } from './util.mjs'\nexport const TEXT = `\nexport const notReal = 1\nimport x from 'nope'\n${'}'}\n`\n// import y from 'no'\nexport function help(argv) { return [shout(argv.join()), nodeFs.existsSync('/') && path.basename('/a/b'), pathSep, typeof nodeOs.tmpdir, TEXT.length].join('|') }\n",
    'util.mjs': "import fs from 'node:fs'\nimport nodeFs from 'node:fs'\nexport const shout = (s) => `${s}!` + (fs === nodeFs ? '' : 'DIFFERENT')\n",
  })
  const text = buildStandalone({ srcDir: dir, version: 'g1' })
  const at = (name) => text.indexOf(`// ── src/off/${name} ──`)
  assert.ok(at('util.mjs') > 0 && at('util.mjs') < at('help.mjs') && at('help.mjs') < at('main.mjs'), 'util, then help, then main')
  assert.equal([...text.matchAll(/__trocarLoad\('node:fs'\)/g)].length, 1, 'node:fs is loaded once, for both names it goes by')
  const r = await runCopy(text, ['x', 'y'])
  assert.deepEqual([r.status, r.stderr], [7, ''])
  assert.equal(r.stdout.trim(), `x,y!|b|/|function|${"\nexport const notReal = 1\nimport x from 'nope'\n}\n".length}`)
})

test('the generator refuses what would make a wrong file: a duplicate top-level name, an import that is not node:* or a file of the directory, a cycle, an export it cannot strip, a rename of an import', () => {
  const bad = (override, re) => assert.throws(() => buildStandalone({ srcDir: tree({ ...GOOD, ...override }), version: 'g' }), re)
  const help = (extra) => ({ 'help.mjs': GOOD['help.mjs'] + extra }) // after the code
  const top = (line) => ({ 'help.mjs': line + GOOD['help.mjs'] }) // before it, where imports are
  bad({ ...help('const dup = 1\n'), 'util.mjs': `${GOOD['util.mjs']}const dup = 2\n` }, /dup.*(util|help)\.mjs.*(util|help)\.mjs/)
  bad(top("import x from 'left-pad'\n"), /left-pad/)
  bad(top("import x from '../paths.mjs'\n"), /\.\.\/paths\.mjs/)
  bad(top("import x from 'fs'\n"), /'fs'/)
  bad(top("import './nope.mjs'\n"), /side-effect/)
  bad({ 'util.mjs': "import { help } from './help.mjs'\nexport const shout = (s) => help(s)\n" }, /cycle.*(help|util)\.mjs/)
  bad(help("import late from 'node:os'\n"), /after the first statement/)
  bad(help('export default 1\n'), /export default/)
  bad(help('const q = 1\nexport { q }\n'), /export \{/)
  bad(help("export * from './util.mjs'\n"), /export \*/)
  bad({ 'help.mjs': "import { shout as yell } from './util.mjs'\nexport const help = (a) => yell(a)\n" }, /shout as yell/)
  bad({ 'help.mjs': "import { nothing } from './util.mjs'\nexport const help = (a) => nothing(a)\n" }, /nothing.*util\.mjs/)
  bad(help('export const { a, b } = { a: 1, b: 2 }\n'), /destructuring/)
  bad({ 'help.mjs': `import path from 'node:path'\n${GOOD['help.mjs']}`, 'util.mjs': `${GOOD['util.mjs']}export const path = 1\n` }, /path.*(util|help)\.mjs/)
  bad({ 'help.mjs': `import x from 'node:fs'\n${GOOD['help.mjs']}`, 'util.mjs': `import x from 'node:os'\n${GOOD['util.mjs']}` }, /x.*node:(fs|os).*node:(fs|os)/)
  bad(help('export const module = 1\n'), /module/)
  assert.throws(() => buildStandalone({ srcDir: tree({ 'main.mjs': GOOD['main.mjs'] }), version: 'g' }), /help\.mjs/, 'an import of a file that is not there')
  assert.throws(() => buildStandalone({ version: '' }), /version/)
})

test('src/off carries OFF_VERSION as an integer, and the unique-name rule the generator needs holds over the real directory (it builds)', () => {
  assert.ok(Number.isInteger(OFF_VERSION) && OFF_VERSION >= 1)
  assert.ok(buildStandalone({ version: OFF_VERSION }).length > 20_000)
})

// The kinds the copy undoes, and how (the file rule's kinds), pinned to the OFF_VERSION that ships them: a change to either list
// without a bump (and a row here) is red, so doctor's version line tells an old copy from one that knows the new rules.
const KINDS_AT = { 16: 'e3c392509cb0c538', 17: 'e3c392509cb0c538', 18: 'e3c392509cb0c538', 19: 'e3c392509cb0c538', 20: 'e3c392509cb0c538', 21: 'e3c392509cb0c538', 22: 'e3c392509cb0c538', 23: 'e3c392509cb0c538' } // 17-23 ship the same kinds: those bumps are D61 (no autostart disable), D62 ⑥ (no exit asked of a proxy-mode daemon), D62 (the switch asks the daemon's warm helper for the process table) and a new harness's marker place, their reason lines are in src/off/manifest.mjs
test('OFF_VERSION moves with the undo rules: the known kinds and the file-rule kinds are the ones this version ships', () => {
  const fp = sha256(Buffer.from(JSON.stringify([KNOWN_KINDS, FILE_ENTRY_KINDS]))).slice(0, 16)
  assert.equal(KINDS_AT[OFF_VERSION], fp, `KNOWN_KINDS / FILE_ENTRY_KINDS changed: bump OFF_VERSION with its reason line (src/off/manifest.mjs) and add { ${OFF_VERSION + 1}: '${fp}' } here`)
})

// ── V35 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('V35 / an item of a kind the copy does not know refuses the whole off — ok:false, exit 1, the hint is `trocar off`; no other entry is undone either', async () => {
  const s = await brokenTrocar()
  const before = preEntries(s)
  const mystery = path.join(s.home, 'mystery.cfg')
  fs.writeFileSync(mystery, 'x')
  const m = readManifest(s.dir)
  m.entries.push({ phase: 'on', harness: 'codex', path: mystery, kind: 'mystery', undo_by_hand: 'rm it' })
  saveManifest(s.dir, m)
  const r = await runWritten(s, ['--json'])
  assert.equal(r.status, 1, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, false)
  const left = out.left.find((l) => l.path === mystery)
  assert.ok(left && /trocar off/.test(left.reason) && /mystery/.test(left.reason), `the item and the hint: ${JSON.stringify(out.left)}`)
  assert.equal(fs.readFileSync(mystery, 'utf8'), 'x', 'the item was not touched')
  assert.ok(backToBefore(before).length > 0, 'the entries it does know are not undone: half an off would leave routing off with the item still in place')
  assert.deepEqual(readManifest(s.dir).entries.map((e) => e.kind).filter((k) => k === 'mystery'), ['mystery'], 'and the manifest is as it was, for the trocar that knows it')
  // `trocar off` itself says the same thing with its own words: it IS the trocar, so it cannot send anyone to itself
  const t = await brokenTrocar()
  const mt = readManifest(t.dir); const myst2 = path.join(t.home, 'mystery.cfg'); fs.writeFileSync(myst2, 'x')
  mt.entries.push({ phase: 'on', harness: 'codex', path: myst2, kind: 'mystery', undo_by_hand: 'rm it' }); saveManifest(t.dir, mt)
  const io = fakeIo()
  assert.equal(await runOffCli(['--json'], cliCtx(t, io)), 1, 'trocar off is not done either: an item left is a not-done off')
  assert.ok(!/trocar off/.test(io.json().left.find((l) => l.path === myst2).reason), 'but it does not tell anyone to run itself')
})

test('V35: a manifest newer than the copy knows is left alone — ok:false, exit 1, the hint is `trocar off`; the routing is still taken off', async () => {
  const s = await brokenTrocar()
  const file = manifestPath(s.dir)
  const m = JSON.parse(fs.readFileSync(file, 'utf8')); m.version = MANIFEST_VERSION + 1
  fs.writeFileSync(file, JSON.stringify(m))
  const userBefore = s.userFiles()
  const r = await runWritten(s, ['--json'])
  assert.equal(r.status, 1, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, false)
  assert.match(out.problems.join('\n'), new RegExp(`version ${MANIFEST_VERSION + 1}[^\\n]*trocar off`), 'the version it does not read, and what to run')
  assert.deepEqual(s.userFiles(), userBefore, 'no entry was touched')
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], 'the desired state is off all the same')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, MANIFEST_VERSION + 1, 'and the manifest is as the newer trocar wrote it')
  const io = fakeIo(), t = await brokenTrocar()
  const f2 = manifestPath(t.dir); const m2 = JSON.parse(fs.readFileSync(f2, 'utf8')); m2.version = MANIFEST_VERSION + 1; fs.writeFileSync(f2, JSON.stringify(m2))
  assert.equal(await runOffCli(['--json'], cliCtx(t, io)), 1)
  assert.ok(!/run `trocar off`/.test(io.json().problems.join('\n')), '`trocar off` does not send anyone to itself')
})

test('the execute bit is only a POSIX fact: on win32 a copy without it is current, on linux it is not (Windows test machine run 2, 2026-10-18 Q4)', () => {
  const home = tmpDir('trocar-chk-win-')
  writeStandalone({ home, version: OFF_VERSION })
  fs.chmodSync(standalonePath(home), 0o600) // what Windows reports for a file install just wrote
  assert.equal(checkStandalone({ home, version: OFF_VERSION, platform: 'win32' }).ok, true, 'win32: nothing carries an execute bit, so it says nothing')
  const posix = checkStandalone({ home, version: OFF_VERSION, platform: 'linux' })
  assert.equal(posix.ok, false)
  assert.match(posix.reason, /not executable/)
})

test('V35: the check reports a copy that is stale, missing or not what src/off generates; writing it makes it equal; a second write changes nothing', async () => {
  const home = tmpDir('trocar-chk-')
  const file = standalonePath(home)
  const missing = checkStandalone({ home, version: OFF_VERSION })
  assert.deepEqual([missing.ok, missing.path, missing.found, missing.expected], [false, file, null, String(OFF_VERSION)])
  assert.match(missing.reason, /not there/)
  const w = writeStandalone({ home, version: OFF_VERSION })
  assert.deepEqual([w.path, w.written, fs.statSync(file).mode & 0o777, fs.readFileSync(file, 'utf8') === buildStandalone({ version: OFF_VERSION })], [file, true, 0o700, true])
  assert.deepEqual([checkStandalone({ home, version: OFF_VERSION }).ok, writeStandalone({ home, version: OFF_VERSION }).written], [true, false], 'equal to what is generated: nothing to do')
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'the directory it made is the user\'s alone')
  // an older copy (its version line says so)
  fs.writeFileSync(file, '#!/usr/bin/env node\n// trocar-off 0 — generated from src/off by trocar on; do not edit\n', { mode: 0o700 })
  const old = checkStandalone({ home, version: OFF_VERSION })
  assert.deepEqual([old.ok, old.found, old.expected], [false, '0', String(OFF_VERSION)])
  assert.match(old.reason, /version 0.*version/, 'says which version it is and which is current')
  // the same version line over other content: still not what `on` writes
  fs.writeFileSync(file, buildStandalone({ version: OFF_VERSION }) + '// edited\n', { mode: 0o700 })
  const edited = checkStandalone({ home, version: OFF_VERSION })
  assert.deepEqual([edited.ok, edited.found], [false, String(OFF_VERSION)])
  assert.match(edited.reason, /differ/)
  // a copy somebody made unusable
  fs.writeFileSync(file, buildStandalone({ version: OFF_VERSION })); fs.chmodSync(file, 0o600)
  assert.equal(checkStandalone({ home, version: OFF_VERSION }).ok, false, 'not executable')
  assert.deepEqual([writeStandalone({ home, version: OFF_VERSION }).written, fs.statSync(file).mode & 0o700], [true, 0o700], 'written again, and executable')
  // the version is a parameter, and OFF_VERSION is the default
  assert.deepEqual([checkStandalone({ home }).ok, checkStandalone({ home, version: 'other' }).ok], [true, false])
  // a copy that cannot be read is said, with why
  fs.rmSync(file); fs.mkdirSync(file)
  const dir = checkStandalone({ home })
  assert.deepEqual([dir.ok, dir.found], [false, null]); assert.match(dir.reason, /EISDIR|cannot be read/)
})

test('V35: `trocar doctor` says nothing of a copy that is current, and makes a finding that says what is wrong when it is not — and writes nothing', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const dir = tmpDir('trocar-stub-'), bin = path.join(dir, 'bin'), log = path.join(dir, 'calls.log')
  fs.mkdirSync(bin)
  for (const name of ['security', 'systemctl', 'launchctl', 'certutil', 'loginctl', 'ss', 'ip']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`, { mode: 0o755 }) // doctor's trust check finds these, and only these (`ss` and `ip` are the reads of its network facts, which only read) (its dependency probe looks at files on PATH, it starts no `which`)
  for (const name of ['ps', 'socktable', 'route', 'ifconfig', 'scutil']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 }) // the flip (4.9 §4): the doctor's status block on a Mac is the NEW status now — it reads the process table and the darwin network facts, all read-only, all stubbed to the empty world
  const doctor = () => spawnSync(process.execPath, [path.join(REPO, 'bin', 'trocar.mjs'), 'doctor'], { env: { TROCAR_SOURCE: tmpDir('trocar-src-'), PATH: bin, TROCAR_NATIVE_DIR: bin, HOME: s.home, TMPDIR: os.tmpdir(), TROCAR_TEST_SANDBOX: '1', TROCAR_MIHOMO_SOCK: path.join(dir, 'none.sock') }, encoding: 'utf8', timeout: 60_000 }) // the VPN probe is pinned to a socket nobody listens on, so it asks no `ps` and can never reach the developer's own core
  const flat = (r) => r.stdout.replace(/\n\s+/g, ' ') // §3.7 findings wrap at the §1.1 width; the fact is the sentence
  const file = standalonePath(s.home)
  const good = fs.readFileSync(file, 'utf8')
  assert.ok(!flat(doctor()).includes(file), 'a copy that is current is no finding: doctor says nothing about it (§3.7)')
  fs.writeFileSync(file, good.replace(`// trocar-off ${OFF_VERSION} —`, '// trocar-off 0 —'))
  assert.match(flat(doctor()), new RegExp(`is not the current version[^.]*\\.[^]*is version 0, this trocar writes version ${OFF_VERSION}`))
  fs.rmSync(file)
  assert.match(flat(doctor()), new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not there`))
  assert.ok(!fs.existsSync(file), 'doctor reads: it does not write the copy')
  assert.deepEqual((fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter((c) => /^(systemctl|loginctl) |^certutil (?!-L )|^launchctl (?!list |getenv )/.test(c)), [], 'and runs none of the tools that change a machine (`certutil -L` is the question doctor asks of the user trust store on Linux, `launchctl list` / `getenv` the ones it asks on a Mac; 1.6 §2)')
})

test('V35: every `on` writes the copy again — after the first on it is what src/off generates, and a copy that was changed is put back by the next on', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const file = standalonePath(s.home)
  assert.equal(fs.readFileSync(file, 'utf8'), buildStandalone({ version: OFF_VERSION }), 'the first on wrote it')
  assert.equal(fs.statSync(file).mode & 0o777, 0o700)
  assert.deepEqual(checkStandalone({ home: s.home }), { ok: true, path: file, found: String(OFF_VERSION), expected: String(OFF_VERSION) })
  fs.writeFileSync(file, '#!/usr/bin/env node\n// trocar-off 0 — generated from src/off by trocar on; do not edit\n', { mode: 0o700 })
  const again = await s.on()
  assert.equal(again.exit, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), buildStandalone({ version: OFF_VERSION }), 'the next on, with nothing else to do, wrote it again')
  assert.ok(again.receipt.created.includes(file), 'and the receipt lists it, like every file trocar writes')
  const quiet = await s.on()
  assert.ok(!quiet.receipt.created.includes(file), 'an on that finds it as it should be does not touch it')
})

// ── the receipt and the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('install names the copy, lists it among what it created and in the plan it prints, and the file is there and runs; the dry run lists it too (D55: trocar-off is install\'s)', async () => {
  const home = tmpDir('trocar-on-std-'); seedClaude(home)
  const io = fakeIo()
  assert.equal(await runInstallCli(['--dry-run', '--json'], onCtx(home, io)), 0)
  const dry = io.json()
  assert.ok(dry.created.includes(standalonePath(home)) && !fs.existsSync(standalonePath(home)), 'the dry run says it will be written, and writes nothing')
  const io2 = fakeIo()
  assert.equal(await runInstallCli(['--yes', '--json'], onCtx(home, io2)), 0)
  const r = io2.json()
  assert.ok(r.created.includes(standalonePath(home)) && r.standalone === standalonePath(home))
  assert.equal(io2.stderrText(), '', '--json writes nothing on stderr (1.6 §1.2)')
  assert.ok(r.planned.some((x) => String(x.path).includes('trocar-off')), 'the plan, now a key of the one JSON document, names it before the first write')
  assert.deepEqual(r.created.slice().sort(), dry.created.slice().sort(), 'the dry run and the run list the same files')
  const run = spawnSync(process.execPath, [standalonePath(home), '--bogus'], { env: { ...process.env, NODE_PATH: '' }, cwd: path.dirname(standalonePath(home)), encoding: 'utf8' })
  assert.deepEqual([run.status, /unknown option '--bogus'/.test(run.stderr)], [2, true], 'the path the receipt prints is a file that runs')
  assert.match(formatPlan({ first: true, files: [], entries: [], standalone: '/home/a/.trocar/bin/trocar-off' }, { home: '/home/a' }), /~\/\.trocar\/bin\/trocar-off/)
})

test('a copy that cannot be written stops the install before one file of the agents\' is touched, says why, exits 1 and leaves a failure line in flows/ (R3, R11)', async () => {
  const home = tmpDir('trocar-on-nostd-'); const settings = seedClaude(home)
  const refuses = new Proxy(fs, { get: (t, k) => (k === 'openSync' ? (p, ...a) => { if (String(p).includes('trocar-off')) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' }); return t.openSync(p, ...a) } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })
  const before = fs.readFileSync(settings, 'utf8')
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes', '--json'], onCtx(home, io, { deps: { fs: refuses } })), 1)
  const r = io.json()
  assert.equal(r.ok, false)
  assert.match(r.notes.join('\n'), /trocar-off[^\n]*the undo that works without the source tree, could not be written \(EACCES[^\n]*no file of the agents' was changed/)
  assert.equal(r.standalone, undefined, 'the receipt names no path that is not a file')
  assert.deepEqual([fs.existsSync(standalonePath(home)), fs.readFileSync(settings, 'utf8') === before], [false, true], 'no copy, and the agent\'s settings are as they were')
  const failure = flowEvents(path.join(home, '.trocar', 'collector')).find((e) => e.event === 'failure' && /trocar-off/.test(e.reason))
  assert.ok(failure && failure.where === 'install' && failure.code === 'EACCES', JSON.stringify(failure))
  const retry = fakeIo()
  assert.equal(await runInstallCli(['--yes', '--json'], onCtx(home, retry)), 0, 'and once that is put right, the same install finishes')
})

// ── the old capture: the copy takes it out too, with the repository out of reach ────────────

// The pre-D39⑥ shape went with the old capture (executed 2026-10-11): the standalone copy no longer carries undoLegacy /
// legacyOffCli — it is the NEW off only, on every platform, and what the old capture left on a machine is cleaned by hand (README).
// The copy's own behavior (the new off, no repository needed) is the cells above and below.
