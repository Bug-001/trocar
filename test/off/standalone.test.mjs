// test/off/standalone.test.mjs — the single-file ~/.asight/bin/asight-off (RFC 1.6 R3; plan Task 8): what buildStandalone makes of src/off, what it refuses, and that the file runs (V11);
// the copy on disk (writeStandalone, checkStandalone: V35's version check), that every `on` writes it, lists it and says when it cannot. The file that comes out is run in a child process,
// in a directory of its own (no relative import could find the repo), with no NODE_PATH. Nothing here runs a real OS tool or touches a real process.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { buildStandalone, writeStandalone, checkStandalone } from '../../src/off/standalone.mjs'
import { OFF_VERSION } from '../../src/off/manifest.mjs'
import { standalonePath } from '../../src/off/paths.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { formatPlan } from '../../src/cli/receipt.mjs'
import { fakeIo, onCtx, seedClaude } from '../cli/fixtures/on-ctx.mjs'
import { installedHome, flowEvents } from './fixtures/off-ctx.mjs'


/** Runs `text` as a file called asight-off in a directory of its own; resolves { status, stdout, stderr }. */
function runCopy(text, argv, { env = {}, nodeArgs = [], sibling = null } = {}) {
  const dir = tmpDir('asight-std-')
  const file = path.join(dir, 'asight-off')
  fs.writeFileSync(file, text, { mode: 0o755 })
  for (const [name, body] of Object.entries(sibling || {})) fs.writeFileSync(path.join(dir, name), body)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, file, ...argv], { cwd: dir, env: { NODE_PATH: '', ASIGHT_TEST_SANDBOX: '1', TMPDIR: os.tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = [], err = []
    child.stdout.on('data', (d) => out.push(d)); child.stderr.on('data', (d) => err.push(d))
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`asight-off did not exit in 30 s; stdout so far: ${Buffer.concat(out)}`)) }, 30_000)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }) })
  })
}

// ── what it is made of ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('V11: what is generated imports node:* and nothing else — no import or export statement, no require, no dynamic import; every built-in comes in through the one loader, by a literal name', () => {
  const text = buildStandalone({ version: 'test' })
  assert.match(text, /^#!\/usr\/bin\/env node\n\/\/ asight-off test — generated from src\/off by asight on; do not edit\n/, 'the shebang and the version line, first')
  assert.equal(buildStandalone({ version: 'test' }), text, 'the same text every time: `on` compares it with what is on disk')
  const calls = [...text.matchAll(/__asightLoad\(/g)].length
  const specs = [...text.matchAll(/__asightLoad\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2])
  assert.ok(specs.length >= 8, `it loads the built-ins the undo side uses: ${specs}`)
  assert.equal(specs.length, calls, 'every call of the loader names a built-in by a literal')
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), [], 'node:* only')
  const bare = text.split('\n').filter((l) => /^\s*(import|export)\s/.test(l) || /\brequire\s*\(/.test(l.replace(/typeof require/g, '')) || /\bimport\s*\(/.test(l))
  assert.deepEqual(bare, [], 'nothing else brings code in')
  assert.ok(!/from\s+['"]\.{1,2}\//.test(text.replace(/\/\/.*$/gm, '')), 'and no relative path is left')
})

// The file has no extension: which kind of module Node takes it for is up to the Node (and a package.json somewhere above it). It is written to be right either way.
test('the file runs however Node takes a file with no extension: not as an ES module (no detection), and as one (a package.json of type module above it)', async () => {
  const text = buildStandalone({ version: 'test' })
  const usage = async (opts) => { const r = await runCopy(text, ['--bogus'], opts); assert.deepEqual([r.status, /unknown option --bogus/.test(r.stderr)], [2, true], `${JSON.stringify(opts)}: ${r.stderr}`) }
  await usage({}) // parses its own arguments and prints on the process's streams
  if (spawnSync(process.execPath, ['--no-experimental-detect-module', '-e', '0']).status === 0) await usage({ nodeArgs: ['--no-experimental-detect-module'] })
  if (typeof process.getBuiltinModule === 'function') await usage({ sibling: { 'package.json': '{"type":"module"}\n' } })
})

// ── what the generator refuses ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const tree = (files) => { const dir = tmpDir('asight-gen-'); for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t); return dir }
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
  assert.equal([...text.matchAll(/__asightLoad\('node:fs'\)/g)].length, 1, 'node:fs is loaded once, for both names it goes by')
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

// ── V35 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('V35: the check reports a copy that is stale, missing or not what src/off generates; writing it makes it equal; a second write changes nothing', async () => {
  const home = tmpDir('asight-chk-')
  const file = standalonePath(home)
  const missing = checkStandalone({ home, version: OFF_VERSION })
  assert.deepEqual([missing.ok, missing.path, missing.found, missing.expected], [false, file, null, String(OFF_VERSION)])
  assert.match(missing.reason, /not there/)
  const w = writeStandalone({ home, version: OFF_VERSION })
  assert.deepEqual([w.path, w.written, fs.statSync(file).mode & 0o777, fs.readFileSync(file, 'utf8') === buildStandalone({ version: OFF_VERSION })], [file, true, 0o700, true])
  assert.deepEqual([checkStandalone({ home, version: OFF_VERSION }).ok, writeStandalone({ home, version: OFF_VERSION }).written], [true, false], 'equal to what is generated: nothing to do')
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'the directory it made is the user\'s alone')
  // an older copy (its version line says so)
  fs.writeFileSync(file, '#!/usr/bin/env node\n// asight-off 0 — generated from src/off by asight on; do not edit\n', { mode: 0o700 })
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

test('V35: every `on` writes the copy again — after the first on it is what src/off generates, and a copy that was changed is put back by the next on', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const file = standalonePath(s.home)
  assert.equal(fs.readFileSync(file, 'utf8'), buildStandalone({ version: OFF_VERSION }), 'the first on wrote it')
  assert.equal(fs.statSync(file).mode & 0o777, 0o700)
  assert.deepEqual(checkStandalone({ home: s.home }), { ok: true, path: file, found: String(OFF_VERSION), expected: String(OFF_VERSION) })
  fs.writeFileSync(file, '#!/usr/bin/env node\n// asight-off 0 — generated from src/off by asight on; do not edit\n', { mode: 0o700 })
  const again = await s.on()
  assert.equal(again.exit, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), buildStandalone({ version: OFF_VERSION }), 'the next on, with nothing else to do, wrote it again')
  assert.ok(again.receipt.created.includes(file), 'and the receipt lists it, like every file asight writes')
  const quiet = await s.on()
  assert.ok(!quiet.receipt.created.includes(file), 'an on that finds it as it should be does not touch it')
})

// ── the receipt and the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the first on names the copy, lists it among what it created and in the plan it prints, and the file is there and runs; the dry run lists it too', async () => {
  const home = tmpDir('asight-on-std-'); seedClaude(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--dry-run', '--json'], onCtx(home, io)), 0)
  const dry = io.json()
  assert.ok(dry.created.includes(standalonePath(home)) && !fs.existsSync(standalonePath(home)), 'the dry run says it will be written, and writes nothing')
  const io2 = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, io2)), 0)
  const r = io2.json()
  assert.ok(r.created.includes(standalonePath(home)) && r.standalone === standalonePath(home) && r.undo.includes(standalonePath(home)))
  assert.match(io2.stderrText(), /asight-off/, 'the plan printed before the first write names it')
  assert.deepEqual(r.created.slice().sort(), dry.created.slice().sort(), 'the dry run and the run list the same files')
  const run = spawnSync(process.execPath, [standalonePath(home), '--bogus'], { env: { ...process.env, NODE_PATH: '' }, cwd: path.dirname(standalonePath(home)), encoding: 'utf8' })
  assert.deepEqual([run.status, /unknown option --bogus/.test(run.stderr)], [2, true], 'the path the receipt prints is a file that runs')
  assert.match(formatPlan({ first: true, files: [], entries: [], standalone: '/home/a/.asight/bin/asight-off' }, { home: '/home/a' }), /~\/\.asight\/bin\/asight-off/)
})

test('a copy that cannot be written stops the on before one file of the agents\' is touched, says why, exits 1 and leaves a failure line in flows/ (R3, R11)', async () => {
  const home = tmpDir('asight-on-nostd-'); const settings = seedClaude(home)
  const refuses = new Proxy(fs, { get: (t, k) => (k === 'openSync' ? (p, ...a) => { if (String(p).includes('asight-off')) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' }); return t.openSync(p, ...a) } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) })
  const before = fs.readFileSync(settings, 'utf8')
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, io, { deps: { fs: refuses } })), 1)
  const r = io.json()
  assert.equal(r.ok, false)
  assert.match(r.notes.join('\n'), /asight-off[^\n]*the undo that works without the source tree, could not be written \(EACCES[^\n]*no file of the agents' was changed/)
  assert.equal(r.standalone, undefined, 'the receipt names no path that is not a file')
  assert.deepEqual([fs.existsSync(standalonePath(home)), fs.readFileSync(settings, 'utf8') === before], [false, true], 'no copy, and the agent\'s settings are as they were')
  const failure = flowEvents(path.join(home, '.asight', 'collector')).find((e) => e.event === 'failure' && /asight-off/.test(e.reason))
  assert.ok(failure && failure.where === 'install' && failure.code === 'EACCES', JSON.stringify(failure))
  const retry = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, retry)), 0, 'and once that is put right, the same on finishes')
})
