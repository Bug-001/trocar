// entries-forms.test.mjs — which routes `on` writes (spec 4.11 §3, CM31), generated over every descriptor × OS × form: only the route of a present form
// is written (Kimi CLI only → the VS Code settings untouched); no present form → nothing; a form a blocker matches gets no entry and says where;
// hostTree forms and descriptor `effects` come back as harness-note data.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { writeRoutes, planRoutes } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { world, door } from './fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const OSES = ['darwin', 'win32']
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((n) => fs.statSync(path.join(dir, n)).isFile()) : [])
const routeFile = (r, ctx) => (r.file ? resolveLoc(r.file, ctx)[0] : null)

for (const h of harnesses) for (const os of OSES) {
  const forms = h.proxyMode.forms.filter((f) => f.os.includes(os))
  for (const f of forms) {
    test(`CM31 ${h.name} · ${os} · only ${f.id} present → only route ${f.route} is planned and touched${f.hostTree ? ', with the hostTree note' : ''}`, () => {
      const w = world({ os })
      w.present(f)
      const out = writeRoutes(h, w.ctx, () => door())
      assert.deepEqual(out.results.map((x) => x.route), [f.route])
      assert.ok(planRoutes(h, w.ctx).routes[0].forms.includes(f.id))
      for (const [id, r] of Object.entries(h.proxyMode.routes).filter(([id]) => id !== f.route)) { const p = routeFile(r, w.ctx); if (p) assert.equal(fs.existsSync(p), false, `${id} untouched`) }
      assert.equal(out.notes.filter((n) => n.form === f.id && n.code === 'harness-note').length, f.hostTree ? 1 : 0)
      assert.equal(out.notes.filter((n) => n.id).length, (h.proxyMode.effects || []).length, 'descriptor effects are listed as notes')
      assert.ok(out.notes.every((n) => n.code === 'harness-note' && typeof n.text === 'string'))
      if (h.proxyMode.routes[f.route].absent === 'not-routed') assert.deepEqual([out.results[0].ok, out.results[0].code, out.results[0].reason], [false, 'not-routed', 'absent'])
      else assert.equal(out.results[0].ok, true, JSON.stringify(out.results[0]))
    })
  }

  test(`CM31 ${h.name} · ${os} · no form present → no route, no note, no file`, () => {
    const w = world({ os })
    const out = writeRoutes(h, w.ctx, () => door())
    assert.deepEqual([out.results, out.notRouted, out.notes], [[], [], []])
    assert.deepEqual(files(w.home), [])
  })

  for (const [i, b] of (h.proxyMode.blockers || []).entries()) {
    test(`ruling ⑩ ${h.name} · ${os} · blocker ${i} (${Object.keys(b.at)[0]}) → the forms it covers get no entry; not-routed says where`, (t) => {
      const w = world({ os })
      for (const f of forms) w.present(f)
      if (!w.plant(b.at)) { t.skip(`the blocker names nothing on ${os}`); return }
      const out = writeRoutes(h, w.ctx, () => door())
      const covered = forms.filter((f) => !b.forms || b.forms.includes(f.id)).map((f) => f.id)
      assert.deepEqual(out.notRouted.map((x) => x.form).sort(), covered.sort())
      assert.ok(out.notRouted.every((x) => x.code === 'not-routed' && x.reason === 'blocker' && typeof x.at === 'string' && x.at.length > 0))
      const free = new Set(forms.filter((f) => !covered.includes(f.id)).map((f) => f.route))
      assert.deepEqual(out.results.map((x) => x.route).sort(), [...free].sort(), 'a route only blocked forms use is not written')
    })
  }
}
