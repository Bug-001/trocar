// test/cli/plan-paths.test.mjs — V85's plan side (1.6 §V85, the counterpart of V3's receipt side in receipt.test.mjs): the set of paths in the
// `--dry-run --json` plan of `install` / `on` / `uninstall` equals the set the same command then writes with `--yes`. The plan is read by walking the
// whole document for strings that are paths under the sandbox HOME — no key name of the document is assumed (`planned` may be reshaped). The world is
// the injected CLI sandbox (dispatch-ctx): no OS tool, no socket, HOME is a temp directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { sandbox, snapshot } from './fixtures/dispatch-ctx.mjs'

/** Every string anywhere in `doc` that is a path under `home`. */
function pathsIn(doc, home) {
  const out = new Set()
  const walk = (v) => {
    if (typeof v === 'string') { if (v.startsWith(home + path.sep)) out.add(path.normalize(v)) }
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(doc)
  return out
}
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k] && a[k] !== 'dir' && b[k] !== 'dir').sort()
// trocar's own record and backups are not a plan item: the receipt side (V3) holds them out the same way — they are what the run writes ABOUT itself
const OWN = ['backup', 'flows', 'index', 'logs']
const own = (rel) => OWN.some((d) => rel.split(path.sep).includes(d))

test('V85 · the paths in the install / on / uninstall plan are the paths the run with --yes then writes', async () => {
  const s = sandbox({ platform: 'linux', install: false })
  for (const cmd of ['install', 'on', 'uninstall']) {
    const dry = await s.run([cmd, '--dry-run', '--json'])
    assert.equal(dry.exit, 0, `${cmd} --dry-run: ${dry.io.text()}`)
    const plan = pathsIn(dry.io.json(), s.home)
    const before = snapshot(s.home)
    const real = await s.run([cmd, '--yes', '--json'])
    assert.equal(real.exit, 0, `${cmd} --yes: ${real.io.text()}`)
    const touched = diff(before, snapshot(s.home)).filter((rel) => !own(rel)).map((rel) => path.join(s.home, rel))
    // in the plan: the path itself, or a directory of the plan it lies under (a plan may name the directory it fills)
    const unplanned = touched.filter((f) => !plan.has(f) && ![...plan].some((p) => f.startsWith(p + path.sep)))
    assert.deepEqual(unplanned, [], `${cmd}: written with --yes but not named in the plan`)
    assert.ok(plan.size > 0 && touched.length > 0, `${cmd}: neither the plan nor the run is empty (${plan.size} planned, ${touched.length} written)`)
  }
})
