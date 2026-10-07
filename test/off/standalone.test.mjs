// test/off/standalone.test.mjs — the single-file ~/.asight/bin/asight-off (RFC 1.6 R3; plan Task 8): what buildStandalone makes of src/off, what it refuses, and that the file runs (V11).
// The file that comes out is run in a child process, in a directory of its own (no relative import could find the repo), with no NODE_PATH. Nothing here runs a real OS tool.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { buildStandalone } from '../../src/off/standalone.mjs'
import { OFF_VERSION } from '../../src/off/manifest.mjs'


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
