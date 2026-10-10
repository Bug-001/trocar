// no-vpn-writes.test.mjs — 4.7 N15 (D43): asight has no write path into a VPN / proxy product's data directory. Two scans that can see their target, because a count of
// write-function names is never zero (asight writes its own files) and so can never be the test:
//   (a) static: a module that names a product's data directory, and anything under src/netenv/, calls a write function only inside a helper the allowlist names; the Verge adapter exports no write
//       function; `own: true` (a controller client that may write) appears only in forwarder.mjs;
//   (b) runtime: detect and the adapter's reads, run over a recording fs in a sandbox, put no write under any product directory.
// The allowlist is by the NAME of one helper per legitimate writer (4.7 N15): `writeNetenv` writes ~/.asight/netenv.json (it is the CLI's, src/netenv/index.mjs, T9). The helpers of arch/win32 that write
// asight's own directory are registered by name in OWN_WRITERS when their files exist (Tasks 7, 8, 9, 14) ONLY if that module names a product directory or sits in src/netenv/: this scan watches nothing else.
// Those writers are held by the runtime half ((b), extended by Tasks 8(c), 9(b) and 14 with `on`, `off` and `uninstall`) and later by the lab's W53. The Verge adapter has no write site (Task 6r took the
// last two out: it only reads), so it is not on the list.
// The OLD capture is exempt as a whole (OLD_CAPTURE: src/capture/ and the src/off/legacy*.mjs files): its Clash steer writes Verge's Script.js and merge file by design until it is retired, which D43 and 4.7 §4
// leave to 1.6 §4 and §6 (the old Clash block is booked there). The exemption is a pinned list, not a switch.
// Two planted counter-examples turn each scan red.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writesOf, balanced, callArgs, PRODUCT_DIR_NAMES, WRITE_FNS } from './fixtures/write-scan.mjs'
import { startWorld, snapshot } from './fixtures/verge-world.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { detect } from '../../src/netenv/probe.mjs'
import { vergeProcs } from './fixtures/win-facts.mjs'
import { PRODUCTS_WIN32 } from '../../src/netenv/products-win32.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.(mjs|cjs|js)$/.test(e.name) ? [p] : []
  })
}
const SOURCES = walk(path.join(ROOT, 'src'))

// The old capture is exempt as a WHOLE, by file (the shared pinned list is fixtures/old-capture.mjs, so the D43 scan of no-sysproxy-no-elevation.test.mjs exempts the same two and nothing else).
export { OLD_CAPTURE, isOldCapture } from './fixtures/old-capture.mjs'
import { OLD_CAPTURE, isOldCapture } from './fixtures/old-capture.mjs'

/** The legitimate writers, by the name of one helper each (4.7 N15). */
const OWN_WRITERS = Object.freeze(['writeNetenv'])
/** The writes of one module that the rule forbids: it names a product directory or sits in src/netenv/, it is not the old capture's, and the write is not in an allowlisted helper. */
export function violations(file, src) {
  if (isOldCapture(file)) return []
  const watched = file.startsWith('src/netenv/') || PRODUCT_DIR_NAMES.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))
  if (!watched) return []
  return writesOf(src).filter((w) => !OWN_WRITERS.includes(w.helper)).map((w) => `${file}:${w.line} ${w.call}() in ${w.helper || 'the top level'}`)
}

test('N15 (a) the scanner is what it says: it finds the write calls of every kind, the helper they are in, and nothing in a comment, a string, a template or a regex', () => {
  const src = [
    "import fs from 'node:fs'",
    'export async function writeNetenv(file, text) {',
    '  fs.mkdirSync(path.dirname(file), { recursive: true })',
    "  await fsp.writeFile(file, text)  // fs.rmSync(not a call, a comment)",
    '}',
    "const quiet = () => { const s = 'fs.unlinkSync(x)'; const t = `fs.rmSync(${a ? `fs.renameSync(a)` : \"\"}) ${fs.copyFileSync(a, b)}`; return /fs\\.unlinkSync\\(/.test(s + t) }",
    'const tail = (p) => fs.appendFileSync(p, "x")',
    "function opener(p) { fs.openSync(p, 'r'); return fs.openSync(p, 'w') }",
    'const obj = { method(p) { rename(p, p + 1) } }',
    "fs.createWriteStream('x')",
  ].join('\n')
  assert.ok(balanced(src))
  assert.deepEqual(writesOf(src).map((w) => [w.call, w.helper]), [
    ['mkdir', 'writeNetenv'], ['writeFile', 'writeNetenv'], ['copyFile', 'quiet'], ['appendFile', 'tail'], ['open', 'opener'], ['rename', 'method'], ['createWriteStream', ''],
  ], 'in the order of the source')
  assert.ok(WRITE_FNS.includes('unlink') && WRITE_FNS.includes('rmdir') && WRITE_FNS.includes('copyFile'))
})

test('N15 (a) the scanner keeps its place in every file of src/: the braces balance in the code view of each one', () => {
  assert.ok(SOURCES.length > 50, 'the scan sees the whole of src/ (not an empty directory)')
  assert.deepEqual(SOURCES.filter((f) => !balanced(fs.readFileSync(f, 'utf8'))).map(rel), [])
})

test('N15 (a) a module that names a product data directory, or sits in src/netenv/, calls a write function only inside an allowlisted helper', () => {
  const found = SOURCES.flatMap((f) => violations(rel(f), fs.readFileSync(f, 'utf8')))
  assert.deepEqual(found, [])
  assert.ok(OWN_WRITERS.length >= 1, 'the allowlist is never empty: the legitimate writers are named')
  assert.ok(SOURCES.filter((f) => !isOldCapture(rel(f))).length > 50, 'and the exemption is the old capture\'s, not the tree\'s: the scan still sees the rest of src/')
})

// What the old capture's undo looked like (the shape src/off/legacy.mjs had: it names Verge's data directory; the file went with the old capture, D39⑥ executed 2026-10-11 —
// the excerpt stays as the shape the exemption must cover in the files that remain) and what the one writer of ~/.asight/netenv.json looks like (src/netenv/index.mjs).
const OLD_UNDO = [
  "import nodeFs from 'node:fs'",
  'export function legacyPaths({ home }) {',
  "  const verge = path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev')",
  '  return { verge }',
  '}',
  'function backupSettingsOnce(fs, p, bak) {',
  "  try { if (!fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(p, 'utf8')) } catch { /* best-effort */ }",
  '}',
  'export function undoLegacy({ fs, settingsPath, stashPath }) {',
  "  fs.writeFileSync(settingsPath, '{}')",
  '  fs.rmSync(stashPath, { force: true })',
  '}',
].join('\n')
const NETENV_WRITER = [
  "import nodeFs from 'node:fs'",
  'export function writeNetenv(home, result, { fs = nodeFs } = {}) {',
  '  const file = netenvFile(home)',
  '  const tmp = `${file}.${process.pid}.tmp`',
  '  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })',
  '  try {',
  '    fs.writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 })',
  '    fs.chmodSync(tmp, 0o600)',
  '    fs.renameSync(tmp, file)',
  '  } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch { /* the failure that matters is e */ } throw e }',
  '}',
].join('\n')

test('N15 (a) the writers are known: the old capture\'s remaining files are exempt as files of the old capture, `writeNetenv` is the one named helper of src/netenv, and neither opens a door elsewhere', () => {
  assert.deepEqual(violations('src/capture/desktop-steer.mjs', OLD_UNDO), [], 'src/capture/desktop-steer.mjs names Verge\'s directory and writes: the old capture\'s own (D43, 4.7 §4; the src/off/legacy*.mjs leg of the exemption went with those files, D39⑥ executed 2026-10-11)')
  assert.equal(violations('src/off/win32.mjs', OLD_UNDO).length, 3, 'the same text in a new module is three writes')
  assert.equal(violations('src/collector/arch/win32/forwarder.mjs', OLD_UNDO).length, 3)
  assert.deepEqual(violations('src/netenv/index.mjs', NETENV_WRITER), [], 'the CLI\'s writer of ~/.asight/netenv.json is `writeNetenv` (4.7 N15 names it)')
  assert.equal(violations('src/netenv/index.mjs', NETENV_WRITER.replace('writeNetenv', 'persist')).length, 5, 'any other name is five writes in src/netenv')
})

test('N15 (a) the old-capture exemption is a pinned list of one — src/capture/ — and nothing that only looks like it (the src/off/legacy*.mjs leg went with the files, D39⑥ executed 2026-10-11)', () => {
  assert.equal(OLD_CAPTURE.length, 1, 'one more entry is a decision, taken here and in 4.7 N15, not a drive-by')
  for (const f of ['src/capture/desktop-steer.mjs', 'src/capture/deep/x.mjs']) assert.ok(isOldCapture(f), f)
  for (const f of ['src/off/clash.mjs', 'src/off/win32.mjs', 'src/off/win32-optin.mjs', 'src/off/legacy.mjs', 'src/off/legacy-cli.mjs', 'src/off/legacy/x.mjs', 'src/off/legacy.mjs.bak', 'src/off/xlegacy.mjs', 'src/netenv/legacy.mjs', 'src/netenv/index.mjs',
    'src/capturer/x.mjs', 'src/collector/capture/x.mjs', 'src/collector/arch/win32/forwarder.mjs', 'test/off/legacy.mjs']) assert.ok(!isOldCapture(f), `${f}: a future file of that name is scanned, not exempted by a glob whose files are gone`)
})

test('N15 (a) planted counter-example: a module that writes a Verge path is red; so is a write in any other helper of src/netenv, and the same code in an allowlisted helper is not', () => {
  const verge = "import fs from 'node:fs'\nexport function tweak(roaming) {\n  fs.writeFileSync(path.join(roaming, 'io.github.clash-verge-rev.clash-verge-rev', 'profiles', 'Script.js'), 'x')\n}\n"
  assert.deepEqual(violations('src/collector/arch/win32/x.mjs', verge), ['src/collector/arch/win32/x.mjs:3 writeFile() in tweak'], 'it names the directory: watched, wherever it sits')
  const elsewhere = "import fs from 'node:fs'\nexport function save(p) { fs.mkdirSync(p) }\n"
  assert.deepEqual(violations('src/netenv/y.mjs', elsewhere), ['src/netenv/y.mjs:2 mkdir() in save'], 'src/netenv/ is watched whatever it names')
  assert.deepEqual(violations('src/collector/arch/win32/z.mjs', elsewhere), [], 'asight\'s own directory writers elsewhere are not this scan\'s (the runtime half checks where they land)')
  const named = "import fs from 'node:fs'\nexport function writeNetenv(p, t) { fs.writeFileSync(p, t) }\n"
  assert.deepEqual(violations('src/netenv/cache.mjs', named), [], 'the named helper may write')
  assert.deepEqual(violations('src/netenv/cache.mjs', named.replace('writeNetenv', 'writeSomethingElse')), ['src/netenv/cache.mjs:2 writeFile() in writeSomethingElse'])
  const open = "import fs from 'node:fs'\nexport function h(p) { return fs.openSync(p, 'w') }\n"
  assert.deepEqual(violations('src/netenv/o.mjs', open), ['src/netenv/o.mjs:2 open() in h'])
})

test('N15 (a) planted counter-example: a write through any receiver or an alias of node:fs is red, the same words from another module are not', () => {
  const at = (src, file = 'src/netenv/a.mjs') => violations(file, src).map((v) => v.replace(/^src\/\S+:/, ''))
  assert.deepEqual(at("import * as io from 'node:fs'\nexport function tweak(p) { io.writeFileSync(p, 'x') }\n"), ['2 writeFile() in tweak'], 'a namespace import under any name')
  assert.deepEqual(at("import io from 'fs'\nexport function tweak(p) { io.rmSync(p) }\n"), ['2 rm() in tweak'], 'a default import under any name')
  assert.deepEqual(at("import { promises as fp } from 'node:fs'\nexport async function tweak(p) { await fp.writeFile(p, 'x') }\n"), ['2 writeFile() in tweak'], 'promises under another name')
  assert.deepEqual(at("import { writeFileSync as wf } from 'node:fs'\nexport function tweak(p) { wf(p, 'x') }\n"), ['2 writeFile() in tweak'], 'a write function under another name')
  assert.deepEqual(at("import { rm as del, mkdir } from 'node:fs/promises'\nexport async function tweak(p) { await del(p); await mkdir(p) }\n"), ['2 rm() in tweak', '2 mkdir() in tweak'], 'a promises import, aliased and plain')
  assert.deepEqual(at("const { unlinkSync: drop } = require('node:fs')\nfunction tweak(p) { drop(p) }\n"), ['2 unlink() in tweak'], 'a destructured require')
  assert.deepEqual(at("const { renameSync: mv } = fs\nfunction tweak(p) { mv(p, p + 1) }\n"), ['2 rename() in tweak'], 'destructured from an fs that is passed in')
  assert.deepEqual(at("const io = await import('node:fs')\nexport function tweak(p) { io.copyFileSync(p, p + 1) }\n"), ['2 copyFile() in tweak'], 'a dynamic import')
  assert.deepEqual(at("import { writeFileSync as wf } from './mine.mjs'\nexport function tweak(p) { wf(p, 'x') }\n"), [], 'an alias of something else is not a write')
  assert.deepEqual(at("import { writeFileSync as wf } from 'node:fs'\nexport function writeNetenv(p) { wf(p, 'x') }\n"), [], 'and the allowlisted helper may write through an alias too')
})

// the one place that makes a controller client that may write to a core: the own kernel's supervisor (4.7 §3.4) — win32's and darwin's forwarder are the one writer per platform. Other `own: true` in the tree (the tracker's proxy settings) are another thing.
const writesToCore = (src) => callArgs(src, ['createController', 'makeClient']).some((a) => /\bown\s*:\s*true\b/.test(a))
test('N15 (a) `createController({ own: true })` (a client that may write to a core) appears only in forwarder.mjs', () => {
  const users = SOURCES.filter((f) => writesToCore(fs.readFileSync(f, 'utf8'))).map(rel)
  assert.deepEqual(users.filter((f) => f !== 'src/collector/arch/win32/forwarder.mjs' && f !== 'src/collector/arch/darwin/forwarder.mjs'), [])
  assert.ok(writesToCore('const c = createController({ endpoint, secret, own: true })'), 'and the check can see one')
  assert.ok(writesToCore('makeClient({\n  endpoint,\n  own:true,\n})'))
  assert.ok(!writesToCore('createController({ endpoint, own: false }); const p = { own: true }'), 'another `own: true` in the same file is another thing')
})

// The Verge adapter exports no write function (4.7 N15): not from the module, and not on the adapter object. A write verb in a name is the tell (the adapter's surface is also pinned to its reads in verge-adapter.test.mjs).
const WRITE_VERB = /^(write|strip|put|push|remove|install|apply|refresh|reset|insert|delete|patch|post|save|update)/i
test('N15 (a) the Verge adapter exports no write function (module and adapter object)', async (t) => {
  const mod = await import('../../src/netenv/adapters/clash-verge-rev.mjs')
  const w = await startWorld(t)
  assert.deepEqual([...Object.keys(mod), ...Object.keys(w.adapter)].filter((k) => WRITE_VERB.test(k)), [])
  assert.ok(Object.keys(w.adapter).length >= 5, 'and the check looks at something: the adapter\'s reads')
  assert.ok(['writeConfig', 'saveChoice', 'applyChange', 'resetAll'].every((n) => WRITE_VERB.test(n)) && !WRITE_VERB.test('readFields'), 'and the pattern tells a write verb from a read')
})

// ---- (b) runtime: a recording fs ---------------------------------------------------------------------------------------------------------------------------

const TWO_PATHS = new Set(['rename', 'copyFile', 'cp', 'link', 'symlink']) // a write that has a source and a target: both are touched
const FD_WRITES = new Set(['write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes']) // a write on a descriptor: the path is the one it was opened with
const WRITE_OPEN = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND
/** Whether an `open`'s flags can change the file: a string with w, a or + (r+ too), or a number with any of the write bits. No flags is `r`. */
const writesOnOpen = (flags) => (typeof flags === 'number' ? (flags & WRITE_OPEN) !== 0 : typeof flags === 'string' && /[wa+]/.test(flags))
const pathText = (x, fdPaths) => (typeof x === 'number' ? fdPaths.get(x) ?? String(x) : x instanceof URL ? fileURLToPath(x) : String(x))
/**
 * `real` with every write recorded (and carried out: the sandbox is the test's own); reads pass through. The sync, callback and `promises.` forms (`fn: 'promises.writeFile'`), an `open` whose flags write
 * (the file is changed by the open itself: it is truncated or created; the descriptor it returns is remembered, so a `write` on it is recorded under that path too), a stream, and the descriptor writes.
 */
export function recordingFs(real, log, { prefix = '', fdPaths = new Map() } = {}) {
  return new Proxy(real, {
    get(target, key) {
      const v = target[key]
      if (key === 'promises' && v !== null && typeof v === 'object') return recordingFs(v, log, { prefix: 'promises.', fdPaths })
      if (typeof v !== 'function') return v
      const name = String(key)
      const base = name.replace(/Sync$/, '')
      const record = (a, count) => log.push({ fn: prefix + name, paths: a.slice(0, count).map((x) => pathText(x, fdPaths)) })
      if (base === 'open') return (...a) => { const writes = writesOnOpen(a[1]); if (writes) record(a, 1); const r = v.apply(target, a); if (writes && typeof r === 'number') fdPaths.set(r, pathText(a[0], fdPaths)); return r }
      if (FD_WRITES.has(base) || WRITE_FNS.includes(base)) return (...a) => { record(a, TWO_PATHS.has(base) ? 2 : 1); return v.apply(target, a) }
      return v.bind(target)
    },
  })
}
const under = (p, dir) => { const r = path.relative(dir, path.resolve(p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }
/** The writes in `log` that land under a product's data directory: the (b) check itself. */
export const writesUnder = (log, dirs) => log.filter((e) => e.paths.some((p) => dirs.some((d) => under(p, d))))

const PRODUCT_NAMES = ['io.github.clash-verge-rev.clash-verge-rev', 'mihomo-party', 'FlClash', 'GUI.for.SingBox', 'v2rayN']

test('N15 (b) detect and every read of the Verge adapter run over a recording fs: no write lands under a product directory, and Verge\'s data directory is byte for byte as it was', async (t) => {
  const log = []
  const w = await startWorld(t, { adapter: { fs: recordingFs(fs, log) } })
  const roaming = path.dirname(w.home)
  const dirs = PRODUCT_NAMES.map((n) => path.join(roaming, n))
  for (const d of dirs.slice(1)) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'config.yaml'), 'secret: s3cr3t\n') }
  const before = snapshot(roaming)
  log.length = 0 // what the fixture wrote to build the world is the test's, not asight's
  const procs = vergeProcs()
  const facts = { procs: { ok: true, rows: procs }, listeners: { ok: true, rows: [{ pid: 4101, port: 7897 }] }, systemProxy: { ok: true, enable: true, server: '127.0.0.1:7897', autoConfigUrl: '' }, interfaces: { ok: true, rows: [], defaultIface: 'Ethernet' }, focusPorts: [7897], verge: await w.adapter.facts() }
  await w.adapter.readFields()
  const r = detect(facts)
  assert.equal(r.products.length, 1, 'the run did something: Verge was read')
  assert.deepEqual(writesUnder(log, dirs), [])
  assert.deepEqual(snapshot(roaming), before)
  assert.ok(PRODUCTS_WIN32.some((p) => p.dataDir), 'the table still names a data directory to protect')
})

// The runs that do not exist for Windows yet, each with its owner in the plan (2026-10-07-win-collector.md): a deferral that is only a comment does not show up in the test output (audit F9).
test.todo('N15 (b) the `on` run (plan Task 8(c)): with the injected win32 platform, `on` over a recording fs puts no write under a product directory')
test.todo('N15 (b) the `off` and `uninstall` runs (plan Task 9(b)): with the injected win32 platform, both over a recording fs, `undoWin32` included, put no write under a product directory')
test.todo('N15 (b) the opt-in runs (plan Task 14): `on --opt-in` for every form and the `off` after it, over a recording fs, put no write under a product directory')

test('N15 (b) the recording fs sees every way to write: sync, callback and promises forms, an `open` with a write flag (a string or a number), a write on its fd, a stream; and not a read', async () => {
  const dir = tmpDir('asight-rec-')
  const log = []
  const rfs = recordingFs(fs, log)
  const at = (n) => path.join(dir, n)
  fs.writeFileSync(at('r.txt'), 'x') // outside the recorder: the test's own
  await rfs.promises.writeFile(at('a'), 'x')
  await (await rfs.promises.open(at('b'), 'a')).close()
  const fd = rfs.openSync(at('c'), 'w')
  rfs.writeSync(fd, 'x')
  rfs.closeSync(fd)
  rfs.closeSync(rfs.openSync(at('d'), fs.constants.O_WRONLY | fs.constants.O_CREAT))
  rfs.closeSync(rfs.openSync(at('r.txt'), 'r+'))
  await new Promise((resolve, reject) => rfs.open(at('e'), 'w', (err, h) => (err ? reject(err) : rfs.close(h, resolve))))
  await new Promise((resolve) => { const w = rfs.createWriteStream(at('f')); w.end('x', resolve) })
  rfs.writeFileSync(at('g'), 'x')
  assert.deepEqual(log.map((e) => [e.fn, path.basename(e.paths[0])]), [
    ['promises.writeFile', 'a'], ['promises.open', 'b'], ['openSync', 'c'], ['writeSync', 'c'], ['openSync', 'd'], ['openSync', 'r.txt'], ['open', 'e'], ['createWriteStream', 'f'], ['writeFileSync', 'g'],
  ])
  log.length = 0
  rfs.closeSync(rfs.openSync(at('r.txt'), 'r'))
  rfs.closeSync(rfs.openSync(at('r.txt')))
  rfs.closeSync(rfs.openSync(at('r.txt'), fs.constants.O_RDONLY))
  rfs.readFileSync(at('r.txt'))
  await rfs.promises.readFile(at('r.txt'))
  assert.deepEqual(log, [], 'reads are not writes: only a write flag makes an open one')
  const probe = recordingFs(fs, log)
  await probe.promises.writeFile(at('p'), 'x')
  assert.equal(writesUnder(log, [dir]).length, 1, 'the finding\'s probe (promises.writeFile) lands in the log and under the directory')
})

test('N15 (b) planted counter-example: an `on` that writes a file under a product directory is red, a write under asight\'s own directory is not', async (t) => {
  const log = []
  const w = await startWorld(t, { adapter: { fs: recordingFs(fs, log) } })
  const roaming = path.dirname(w.home)
  const dirs = PRODUCT_NAMES.map((n) => path.join(roaming, n))
  const rfs = recordingFs(fs, log)
  log.length = 0
  fs.mkdirSync(path.join(w.sandbox, '.asight'))
  rfs.writeFileSync(path.join(w.sandbox, '.asight', 'netenv.json'), '{}') // asight's own: fine
  assert.deepEqual(writesUnder(log, dirs), [])
  const wrongOn = () => { rfs.mkdirSync(path.join(roaming, 'v2rayN', 'guiConfigs'), { recursive: true }); rfs.writeFileSync(path.join(roaming, 'v2rayN', 'guiConfigs', 'x.json'), '{}') }
  wrongOn()
  assert.deepEqual(writesUnder(log, dirs).map((e) => e.fn), ['mkdirSync', 'writeFileSync'])
  log.length = 0
  rfs.renameSync(path.join(roaming, 'v2rayN', 'guiConfigs', 'x.json'), path.join(w.sandbox, 'moved.json'))
  assert.equal(writesUnder(log, dirs).length, 1, 'a rename OUT of a product directory is a write in it too')
})
