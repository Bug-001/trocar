// no-vpn-writes.test.mjs — 4.7 N15 (D43): asight has no write path into a VPN / proxy product's data directory. Two scans that can see their target, because a count of
// write-function names is never zero (asight writes its own files) and so can never be the test:
//   (a) static: a module that names a product's data directory, and anything under src/netenv/, calls a write function only inside a helper the allowlist names; the Verge adapter exports no write
//       function; `own: true` (a controller client that may write) appears only in forwarder.mjs;
//   (b) runtime: detect and the adapter's reads, run over a recording fs in a sandbox, put no write under any product directory.
// The allowlist is by the NAME of one helper per legitimate writer (4.7 N15): `writeNetenvCache` writes ~/.asight/netenv.json, and the helpers of arch/win32 that write asight's own directory are
// registered by name in OWN_WRITERS when their files exist (Tasks 7, 8, 9, 14). The Verge adapter has no write site (Task 6r took the last two out: it only reads), so it is not on the list.
// Two planted counter-examples turn each scan red.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writesOf, balanced, callArgs, PRODUCT_DIR_NAMES, WRITE_FNS } from './fixtures/write-scan.mjs'
import { startWorld, snapshot } from './fixtures/verge-world.mjs'
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
// src/capture/ is the OLD capture's own (the Clash steer of D22 / D28 / D29, 1.6 §4): the CLI branch's, not this task's
const SOURCES = walk(path.join(ROOT, 'src')).filter((f) => !rel(f).startsWith('src/capture/'))

/** The two legitimate writers, by the name of one helper each (4.7 N15). */
const OWN_WRITERS = Object.freeze(['writeNetenvCache'])
/** The writes of one module that the rule forbids: it names a product directory or sits in src/netenv/, and the write is not in an allowlisted helper. */
export function violations(file, src) {
  const watched = file.startsWith('src/netenv/') || PRODUCT_DIR_NAMES.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))
  if (!watched) return []
  return writesOf(src).filter((w) => !OWN_WRITERS.includes(w.helper)).map((w) => `${file}:${w.line} ${w.call}() in ${w.helper || 'the top level'}`)
}

test('N15 (a) the scanner is what it says: it finds the write calls of every kind, the helper they are in, and nothing in a comment, a string, a template or a regex', () => {
  const src = [
    "import fs from 'node:fs'",
    'export async function writeNetenvCache(file, text) {',
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
    ['mkdir', 'writeNetenvCache'], ['writeFile', 'writeNetenvCache'], ['copyFile', 'quiet'], ['appendFile', 'tail'], ['open', 'opener'], ['rename', 'method'], ['createWriteStream', ''],
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
  assert.ok(OWN_WRITERS.length >= 1, 'the allowlist is never empty: the two legitimate writers are named')
})

test('N15 (a) planted counter-example: a module that writes a Verge path is red; so is a write in any other helper of src/netenv, and the same code in an allowlisted helper is not', () => {
  const verge = "import fs from 'node:fs'\nexport function tweak(roaming) {\n  fs.writeFileSync(path.join(roaming, 'io.github.clash-verge-rev.clash-verge-rev', 'profiles', 'Script.js'), 'x')\n}\n"
  assert.deepEqual(violations('src/collector/arch/win32/x.mjs', verge), ['src/collector/arch/win32/x.mjs:3 writeFile() in tweak'], 'it names the directory: watched, wherever it sits')
  const elsewhere = "import fs from 'node:fs'\nexport function save(p) { fs.mkdirSync(p) }\n"
  assert.deepEqual(violations('src/netenv/y.mjs', elsewhere), ['src/netenv/y.mjs:2 mkdir() in save'], 'src/netenv/ is watched whatever it names')
  assert.deepEqual(violations('src/collector/arch/win32/z.mjs', elsewhere), [], 'asight\'s own directory writers elsewhere are not this scan\'s (the runtime half checks where they land)')
  const named = "import fs from 'node:fs'\nexport function writeNetenvCache(p, t) { fs.writeFileSync(p, t) }\n"
  assert.deepEqual(violations('src/netenv/cache.mjs', named), [], 'the named helper may write')
  assert.deepEqual(violations('src/netenv/cache.mjs', named.replace('writeNetenvCache', 'writeSomethingElse')), ['src/netenv/cache.mjs:2 writeFile() in writeSomethingElse'])
  const open = "import fs from 'node:fs'\nexport function h(p) { return fs.openSync(p, 'w') }\n"
  assert.deepEqual(violations('src/netenv/o.mjs', open), ['src/netenv/o.mjs:2 open() in h'])
})

// the one place that makes a controller client that may write to a core: the own kernel's supervisor (4.7 §3.4). Other `own: true` in the tree (the tracker's proxy settings) are another thing.
const writesToCore = (src) => callArgs(src, ['createController', 'makeClient']).some((a) => /\bown\s*:\s*true\b/.test(a))
test('N15 (a) `createController({ own: true })` (a client that may write to a core) appears only in forwarder.mjs', () => {
  const users = SOURCES.filter((f) => writesToCore(fs.readFileSync(f, 'utf8'))).map(rel)
  assert.deepEqual(users.filter((f) => f !== 'src/collector/arch/win32/forwarder.mjs'), [])
  assert.ok(writesToCore('const c = createController({ endpoint, secret, own: true })'), 'and the check can see one')
  assert.ok(writesToCore('makeClient({\n  endpoint,\n  own:true,\n})'))
  assert.ok(!writesToCore('createController({ endpoint, own: false }); const p = { own: true }'), 'another `own: true` in the same file is another thing')
})

// The Verge adapter exports no write function: TODAY's are the ones Task 6r deletes, so the list is the debt and shrinks to nothing.
const WRITE_VERB = /^(write|strip|put|push|remove|install|apply|refresh|reset|insert)/i
const ADAPTER_WRITERS_TODAY = ['refreshProbe']
test('N15 (a) the Verge adapter exports no write function (module and adapter object)', async (t) => {
  const mod = await import('../../src/netenv/adapters/clash-verge-rev.mjs')
  const w = await startWorld(t)
  const names = [...Object.keys(mod), ...Object.keys(w.adapter)].filter((k) => WRITE_VERB.test(k))
  assert.deepEqual([...new Set(names)].filter((k) => !ADAPTER_WRITERS_TODAY.includes(k)), [], 'a write function that is not on the debt list')
  assert.deepEqual(ADAPTER_WRITERS_TODAY.filter((k) => !(k in mod) && !(k in w.adapter)), [], 'a function of the debt list that is gone: delete its name from ADAPTER_WRITERS_TODAY')
})

// ---- (b) runtime: a recording fs ---------------------------------------------------------------------------------------------------------------------------

const TWO_PATHS = new Set(['rename', 'copyFile', 'cp', 'link', 'symlink']) // a write that has a source and a target: both are touched
/** `real` with every write function recorded (and carried out: the sandbox is the test's own); reads pass through. */
export function recordingFs(real, log) {
  return new Proxy(real, {
    get(target, key) {
      const v = target[key]
      if (typeof v !== 'function') return v
      const base = String(key).replace(/Sync$/, '')
      if (WRITE_FNS.includes(base)) return (...a) => { log.push({ fn: String(key), paths: a.slice(0, TWO_PATHS.has(base) ? 2 : 1).map(String) }); return v.apply(target, a) }
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
  // Task 8(c) and Task 9(b) add `on`, `off` and `uninstall` (the injected platform) as runs of this same check: they do not exist for Windows yet
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
