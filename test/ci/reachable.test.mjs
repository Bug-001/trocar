// test/ci/reachable.test.mjs — spec 0.1 §3 convention 9 and §5 「测死代码」: a module under src/ that no product entry reaches must not exist.
//
// A module nothing in the product imports still gets tests, and those tests keep it green and "covered" while it does nothing
// (2026-10-13 audit: the retired old capture, src/capture/{steer-watch,reverse-proxy,...}, was exactly that). So the check starts
// from the entries — bin/asight.mjs and src/off/main.mjs (the root of the standalone asight-off) — follows every edge by a text scan,
// and fails on any src/**/*.{mjs,cjs,js} left over. test/ is not scanned: a test that imports a module does not make it live.
//
// Edges followed (relative to the importing file):
//   - `from './x'`, `export … from './x'`, `import('./x')`, `require('./x')`
//   - `new URL('./x.mjs', import.meta.url)`            a file;   `new URL('./dir/', import.meta.url)`   every file under that dir
//   - `via('./x.mjs', …)`                               src/cli/commands.mjs's lazy command bodies
//   - `r('src', 'etl', 'cli.mjs')`                      src/cli/legacy-commands.mjs's `r = (...p) => path.join(ROOT, ...p)`
//   - the harness loader (src/collector/harness/index.mjs): every harness/*.mjs but index.mjs and _* (no subdirectory: the per-OS overlays are gone)
// A comment that quotes one of these counts as an edge too (the scan is text, not a parse); that can only hide a dead module, never invent one.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SOURCE = /\.(mjs|cjs|js)$/
const ENTRIES = ['bin/asight.mjs', 'src/off/main.mjs']

/** Modules that are not reached yet. The list only shrinks: adding one needs a reason in the PR (0.1 §6); a listed module that
 *  became reachable or no longer exists fails below, so it gets removed here. */
export const UNREACHED = Object.freeze({
  'src/collector/core/redirector.mjs': 'the Redirector contract (4.6:333) plus createStaticRedirector, which only tests use',
  'src/collector/core/engine/codes.mjs': 'regrouping of src/health/codes.mjs that only tests use',
  'src/query/index.mjs': 'spec 3.5:44 names runNamed as the server\'s only entry, but src/server.mjs does not use it',
  'src/capture/desktop-steer.mjs': 'old CC-Desktop Clash Verge steer; only src/netenv/clash.mjs reached it (for socket discovery), and D49 deleted that. Removal waits on the backlog',
  'src/off/clash.mjs': 'the Verge strip / reload half of that steer, reached only through src/capture/desktop-steer.mjs; same backlog items',
  'src/capture/keep.mjs': 'kept until the data-format branch (D59/D60) replaces or reuses it',
  'src/dissect/session-headers.mjs': 'kept until the data-format branch (D59/D60) replaces or reuses it',
  'src/etl/cli.mjs': 'kept until the data-format branch (D59/D60) replaces or reuses it',
  'src/etl/shard.mjs': 'kept until the data-format branch (D59/D60) replaces or reuses it',
  'src/raw/session-key.mjs': 'kept until the data-format branch (D59/D60) replaces or reuses it',
  'src/raw/verify.mjs': 'kept until the data-format branch (D59/D60) replaces or reuses it',
  // D59/D60 wave 1: the read core and the class table land before the entries that drive them (T8 `asight query` / `asight classes`, T9 the server), in the same PR series.
  'src/classes/table.mjs': 'the editable traffic-class table (D60-3); its callers are the collector (T5) and `asight classes` (T8), later in this series',
  'src/query/index-build.mjs': 'the segment index the read core builds; reached once `asight query` (T8) / GET /api/<name> (T9) exist',
  'src/query/named/index.mjs': 'the named-query registry (QUERIES / runQuery); same two entries, T8 and T9',
  'src/query/named/segments.mjs': 'a named query, reached only through src/query/named/index.mjs',
  'src/query/named/classes.mjs': 'a named query, reached only through src/query/named/index.mjs',
})

const walk = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : []

/** The files that `file` (its text) reaches by an edge above, as absolute paths; may name files that do not exist. */
function edgesOf(file, text, root) {
  const dir = path.dirname(file), out = []
  const rel = (s) => out.push(path.resolve(dir, s))
  for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) rel(m[1])
  for (const m of text.matchAll(/\bvia\(\s*['"](\.{1,2}\/[^'"]+)['"]/g)) rel(m[1])
  for (const m of text.matchAll(/new URL\(\s*['"`](\.{1,2}\/[^'"`$]+)['"`]/g)) {
    if (m[1].endsWith('/')) out.push(...walk(path.resolve(dir, m[1]))); else rel(m[1])
  }
  if (/\br\s*=\s*\(\s*\.\.\.\w+\s*\)\s*=>\s*path\.join\(\s*ROOT/.test(text)) {
    for (const m of text.matchAll(/\bimport\(\s*r\(\s*((?:'[^']+'\s*,\s*)*'[^']+')\s*\)/g)) out.push(path.join(root, ...m[1].split(',').map((x) => x.trim().slice(1, -1))))
  }
  if (file === path.join(root, 'src/collector/harness/index.mjs') && /loadHarnesses/.test(text)) {
    for (const n of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs' && !n.startsWith('_'))) {
      out.push(path.join(dir, n))
    }
  }
  return out
}

/** Every src/**\/*.{mjs,cjs,js} under `root` that no entry reaches, as root-relative posix paths, sorted. */
export function unreachable(root, entries = ENTRIES) {
  const seen = new Set(), queue = entries.map((e) => path.join(root, e))
  while (queue.length) {
    const f = queue.pop()
    if (seen.has(f) || !SOURCE.test(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) continue
    seen.add(f)
    queue.push(...edgesOf(f, fs.readFileSync(f, 'utf8'), root))
  }
  return walk(path.join(root, 'src')).filter((f) => SOURCE.test(f) && !seen.has(f)).map((f) => path.relative(root, f).split(path.sep).join('/')).sort()
}

test('self-check: the analysis reports an orphan and follows via(), directory URLs, r() and the harness loader', () => {
  const root = tmpDir('asight-reach-')
  const put = (p, t) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t) }
  put('bin/asight.mjs', "import '../src/a.mjs'\n")
  put('src/a.mjs', "const via = (f) => f\nvia('./c.mjs', 'run')\nconst d = new URL('./plug/', import.meta.url)\nconst ROOT = '/'\nconst r = (...p) => path.join(ROOT, ...p)\nawait import(r('src', 'etl', 'cli.mjs'))\n")
  put('src/c.mjs', 'export {}\n')
  put('src/plug/p.mjs', 'export {}\n')
  put('src/etl/cli.mjs', 'export {}\n')
  put('src/collector/harness/index.mjs', 'export function loadHarnesses() {}\n')
  put('src/b.mjs', 'export {}\n') // the orphan
  assert.deepEqual(unreachable(root), ['src/b.mjs', 'src/collector/harness/index.mjs'])
  // the loader: a harness file is reached only through index.mjs, which here nothing imports; once a.mjs imports it, every top-level harness file follows
  put('src/a.mjs', fs.readFileSync(path.join(root, 'src/a.mjs'), 'utf8') + "import './collector/harness/index.mjs'\n")
  put('src/collector/harness/x.mjs', 'export {}\n'); put('src/collector/harness/_h.mjs', 'export {}\n'); put('src/collector/harness/win32/x.mjs', 'export {}\n') // no subdirectory is an overlay any more (darwin's and win32's are gone): a file there is reached by nothing
  assert.deepEqual(unreachable(root), ['src/b.mjs', 'src/collector/harness/_h.mjs', 'src/collector/harness/win32/x.mjs'])
})

test('every src module is reachable from bin/asight.mjs or src/off/main.mjs, except the shrink-only list', () => {
  const left = unreachable(REPO)
  const gone = Object.keys(UNREACHED).filter((p) => !fs.existsSync(path.join(REPO, p)))
  assert.deepEqual(gone, [], `deleted, so remove from UNREACHED: ${gone.join(', ')}`)
  const nowReached = Object.keys(UNREACHED).filter((p) => !left.includes(p))
  assert.deepEqual(nowReached, [], `reachable now, so remove from UNREACHED (the list only shrinks): ${nowReached.join(', ')}`)
  const extra = left.filter((p) => !(p in UNREACHED))
  assert.deepEqual(extra, [], `no entry reaches ${extra.join(', ')}: delete the module, or wire it in; if the scan missed an edge, teach unreachable() that edge (adding to UNREACHED needs a reason in the PR, 0.1 §6)`)
})
