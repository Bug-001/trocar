// entries-status.test.mjs — what `status` / `doctor` read of the routes `on` just wrote, through the REAL writers (core/proxymode/entries.mjs writeRoutes),
// not a hand-made journal record: for every descriptor × the model's OSes, a form whose route was written reads `entry_intact` (4.11 §4「一个文件一份记录」,
// 1.6 §9.4). The mac machine 2026-10-19 showed why this seam needs its own test: the created config-library entry had two records of one file (an owned-file
// with the hash of the empty object, then the json-key written into it), so a byte-intact entry came out as `entry-missing` + `proxy-changed`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { writeRoutes } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { modelFormFacts } from '../../../../src/collector/core/proxymode/status-facts.mjs'
import { world, put } from './fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const ROOT_OK = { state: 'in-place', code: null, command: null }

for (const os of ['darwin', 'win32']) {
  for (const desc of harnesses.filter((d) => d.proxyMode && d.proxyMode.forms.some((f) => f.os.includes(os)))) {
    test(`4.11 §4 ${os} ${desc.name}: right after on, every form whose route was written reads entry_intact — no record of one file disagrees with another`, async () => {
      const w = world({ os })
      const m = w.ctx.manifest
      m.install = { state: 'complete', at: '2026-10-16T00:00:00.000Z', pending: [], harnesses: [desc.name], items: {} }
      const forms = desc.proxyMode.forms.filter((f) => f.os.includes(os))
      for (const f of forms) w.present(f)
      const ids = Object.keys(desc.proxyMode.routes)
      // a route that does not create its own file (`absent: 'not-routed'`) needs the agent's file there, as after the agent's own first run
      for (const [, r] of Object.entries(desc.proxyMode.routes)) {
        if (r.absent !== 'not-routed' || !r.file) continue
        const f = resolveLoc(r.file, w.ctx)[0]
        if (f) put(f, r.kind === 'json-key' ? '{}\n' : '')
      }
      const port = (rid) => 18100 + ids.indexOf(rid)
      const res = writeRoutes(desc, w.ctx, (rid) => `http://127.0.0.1:${port(rid)}`)
      const written = res.results.filter((r) => r.ok).map((r) => r.route)
      assert.ok(written.length > 0, `${desc.name} wrote no route on ${os}: ${JSON.stringify(res.results)}`)
      const doors = Object.fromEntries(written.map((rid) => [`${desc.name}:${rid}`, port(rid)]))
      const out = await modelFormFacts({ harnesses, os, manifest: m, reply: { doors }, root: ROOT_OK, ctx: w.ctx })
      for (const x of out[desc.name].filter((f) => written.includes(f.route))) {
        assert.deepEqual([x.id, x.proxy.entry_intact, x.entry && x.entry.intact], [x.id, true, true], `${x.id}: the entry trocar just wrote is intact`)
        assert.equal(x.proxy.connected, true, `${x.id}: connected`)
      }
    })
  }
}

// 1.6 附录 B: the place of a prior value is the key and file it was READ from. A route with two spellings of one variable records one entry per key, and the
// user's value may sit in the second one alone — the place then names that spelling, not the route's first key (the mac machine 2026-10-19 named the key
// trocar had written as the one for the user to remove).
const PRIOR = 'http://proxy.corp:8080'
for (const os of ['darwin', 'win32']) {
  for (const desc of harnesses.filter((d) => d.proxyMode)) {
    for (const [rid, r] of Object.entries(desc.proxyMode.routes).filter(([, x]) => x.kind === 'json-key' && !x.select && (x.proxyKeys || []).length > 1)) {
      test(`1.6 附录 B ${os} ${desc.name}.${rid}: the prior in the route's second key is attributed to that key, not to the first`, async () => {
        const w = world({ os })
        const m = w.ctx.manifest
        m.install = { state: 'complete', at: '2026-10-16T00:00:00.000Z', pending: [], harnesses: [desc.name], items: {} }
        const forms = desc.proxyMode.forms.filter((f) => f.os.includes(os) && f.route === rid)
        if (!forms.length) return
        for (const f of forms) w.present(f)
        const file = resolveLoc(r.file, w.ctx)[0]
        const last = r.proxyKeys[r.proxyKeys.length - 1]
        put(file, `${JSON.stringify(last.reduceRight((inner, k) => ({ [k]: inner }), PRIOR))}\n`)
        const res = writeRoutes(desc, w.ctx, () => 'http://127.0.0.1:18200')
        assert.deepEqual(res.results.map((x) => [x.route, x.ok]).filter(([id]) => id === rid), [[rid, true]])
        const out = await modelFormFacts({ harnesses, os, manifest: m, reply: { doors: { [`${desc.name}:${rid}`]: 18200 } }, root: ROOT_OK, ctx: w.ctx })
        const fm = out[desc.name].find((x) => x.route === rid)
        assert.deepEqual(fm.setting.source, [{ kind: 'file', where: file, key: last.join('.') }], 'the key the prior was read from')
        assert.equal(fm.proxy.prior, PRIOR)
      })
    }
  }
}
