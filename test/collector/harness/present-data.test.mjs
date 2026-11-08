// test/collector/harness/present-data.test.mjs — every descriptor's Linux footprint (`present`, spec 4.6 「这个 harness 装好了没有」) is read by the
// one reader (isPresent): nothing on an empty machine, and each item alone is enough. Generated from the data; no harness named.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../helpers/tmp.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { driverCtx } from '../../../src/collector/driver-setup.mjs'
import { isPresent, resolveLoc } from '../../../src/collector/core/proxymode/sources.mjs'

const withInject = (await loadHarnesses()).filter((d) => typeof d.inject === 'function')
// an empty machine: nothing outside the test's temp dirs exists (an `abs` place is read through ctx.exists, so the host's own /opt never answers)
const ctxFor = (env = {}) => { const ctx = driverCtx({ os: 'linux', home: tmpDir('trocar-present-'), env }); ctx.exists = (f) => f.startsWith(path.dirname(ctx.home)) && fs.existsSync(f); return ctx }
const make = (p) => fs.mkdirSync(p, { recursive: true })

for (const d of withInject) {
  test(`${d.name}: absent in an empty HOME with nothing on PATH; each present item alone makes it present`, () => {
    assert.equal(isPresent(d, ctxFor()), false)
    for (const [i, el] of d.present.entries()) {
      const only = { present: [el] }
      if ('command' in el) {
        const ctx = ctxFor()
        ctx.which = (n) => (n === el.command ? path.join(ctx.home, 'bin', n) : null)
        assert.equal(isPresent(only, ctx), true, `present[${i}]`)
        continue
      }
      const ctx = ctxFor()
      const [at] = resolveLoc(el, ctx)
      if (el.base === 'abs') ctx.exists = (f) => f === at
      else make(at)
      assert.equal(isPresent(only, ctx), true, `present[${i}]`)
      if (!el.env) continue
      const moved = ctxFor({ [el.env]: path.join(tmpDir('trocar-present-env-'), 'moved') })
      make(resolveLoc(el, moved)[0])
      assert.equal(isPresent(only, moved), true, `present[${i}] under $${el.env}`)
      const left = ctxFor({ [el.env]: path.join(tmpDir('trocar-present-env-'), 'moved') })
      make(resolveLoc(el, { ...left, env: new Map() })[0])
      assert.equal(isPresent(only, left), false, `present[${i}]: the default place does not count while $${el.env} moves it`)
    }
  })
}

test("no { command } in a footprint is one of trocar's own shims (spec 4.6: trocar's shim on PATH is not the harness)", () => {
  const shims = fs.readdirSync(fileURLToPath(new URL('../../../src/collector/harness/shims/', import.meta.url))).map((n) => path.parse(n).name)
  const commands = withInject.flatMap((d) => d.present.filter((el) => 'command' in el).map((el) => el.command))
  assert.deepEqual(commands.filter((c) => shims.includes(c)), [])
})
