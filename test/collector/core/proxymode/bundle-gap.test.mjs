// bundle-gap.test.mjs — CM40 (4.11 P4b, 1.6 附录 B / C.3 `setup.missing.what`): a merged bundle (a replace key with `merges`) holds the CAs its sources
// named at install; a CA added to a source since makes `setup` needed (`bundle-lacks-ca`), the form's certificate not in effect with `trocar install`,
// and install clears it. A CA the bundle holds, a CA taken out of the source, an unreadable source and an older record without `user_fps` say nothing.
// Generated over every harness whose descriptor has a merged bundle, never one named harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../../../helpers/model-world.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'
import { certPem } from '../../../../src/collector/core/tls/cert.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { modelNetForms } from '../../../../src/collector/arch/model-backends.mjs'
import { readManifest, saveManifest } from '../../../../src/off/manifest.mjs'
import { findingFor } from '../../../../src/netenv/findings.mjs'

const OS = 'darwin'
const newCa = (cn) => { const c = custodyStub(); c.create({ subject: cn }); return certPem(c.rootDer) }
// the harnesses with a merged bundle on this OS, and the first variable its `merges` names (the source the test edits)
const merged = (await loadHarnesses()).flatMap((d) => Object.values((d.proxyMode && d.proxyMode.certs) || {})
  .filter((c) => c.semantics === 'replace' && Array.isArray(c.merges) && c.merges.some((s) => s.env)).slice(0, 1)
  .map((c) => ({ desc: d, v: c.merges.find((s) => s.env).env })))
  .filter(({ desc }) => desc.proxyMode.forms.some((f) => f.os.includes(OS)))

async function worldFor({ desc, v }) {
  const forms = desc.proxyMode.forms.filter((f) => f.os.includes(OS))
  const commands = forms.flatMap((f) => f.present || []).filter((p) => p.command).map((p) => p.command)
  const w = await modelWorld({ os: OS, commands, env: (home) => ({ [v]: path.join(home, 'certs', 'mine.pem') }) })
  for (const p of forms.flatMap((f) => f.present || []).filter((p) => !p.command)) for (const at of resolveLoc(p, w.ctx)) if (at.startsWith(w.home)) fs.mkdirSync(at, { recursive: true })
  const src = w.env[v]
  fs.mkdirSync(path.dirname(src), { recursive: true })
  const status = async (env = w.env) => {
    const r = await modelNetForms({ os: OS, home: w.home, env, status: { cert: { root: { state: 'in-place' } }, daemon: null, harnesses: [], holders: [] }, harnesses: w.harnesses, procs: {}, dirs: w.ctx.dirs, fs })
    return { setup: r.setup[desc.name], forms: r.forms[desc.name] || [] }
  }
  return { w, src, status }
}

const quiet = (s, why) => assert.deepEqual([s.setup.state, s.setup.missing], ['ready', []], why)

test('CM40: at least one harness has a merged bundle on this OS (the cases below are generated over them)', () => assert.ok(merged.length > 0))

for (const h of merged) {
  test(`CM40 · ${h.desc.name}: a CA added to a merged source after install → needed, bundle-lacks-ca, the certificate not in effect with trocar install; install again clears it`, async () => {
    const { w, src, status } = await worldFor(h)
    fs.writeFileSync(src, newCa('user ca one'))
    assert.equal((await w.install()).exit, 0)
    quiet(await status(), 'right after install')
    fs.appendFileSync(src, newCa('user ca two'))
    const s = await status()
    assert.equal(s.setup.state, 'needed')
    const what = s.setup.missing.map((x) => x.what)
    assert.ok(what.length && what.every((x) => x === 'bundle-lacks-ca'), JSON.stringify(s.setup))
    const bad = s.forms.filter((f) => !f.certificate.in_effect)
    assert.ok(bad.length, 'some form shows its certificate not in effect')
    for (const f of bad) {
      assert.deepEqual([f.certificate.code, f.certificate.command], ['bundle-lacks-ca', 'trocar install'])
      const fd = findingFor('bundle-lacks-ca', { platform: OS, h: h.desc.name, fm: f })
      assert.ok(fd.commands.some((c) => c.run === 'trocar install'), JSON.stringify(fd.commands))
    }
    assert.equal((await w.install()).exit, 0)
    quiet(await status(), 'after install again')
  })

  test(`CM40 · ${h.desc.name}: a CA the bundle holds, a CA taken out of the source, an unreadable source and a record without user_fps say nothing`, async () => {
    const { w, src, status } = await worldFor(h)
    const one = newCa('user ca one')
    fs.writeFileSync(src, one)
    assert.equal((await w.install()).exit, 0)
    fs.appendFileSync(src, `${one}\n${certPem(w.custody.rootDer)}`) // the same CA twice, and trocar's own root (another harness's block in this file): both in the bundle
    quiet(await status(), 'a CA already in the bundle')
    fs.writeFileSync(src, '')
    quiet(await status(), 'a CA taken out of the source')
    quiet(await status({ ...w.env, [h.v]: path.join(w.home, 'certs', 'gone.pem') }), 'a source that cannot be read')
    const own = path.join(w.dir, 'elsewhere.pem') // a file under ~/.trocar: install never merges those (they are trocar's), so it is not judged either
    fs.writeFileSync(own, newCa('a file of trocar\'s own'))
    quiet(await status({ ...w.env, [h.v]: own }), 'a source under ~/.trocar')
    fs.mkdirSync(path.join(w.home, 'certs', 'adir'))
    quiet(await status({ ...w.env, [h.v]: path.join(w.home, 'certs', 'adir') }), 'a source that is a directory')
    fs.writeFileSync(src, `${one}\n${newCa('user ca two')}`)
    const m = readManifest(w.dir, fs)
    const items = m.files.filter((x) => x.role === 'bundle' && x.harness === h.desc.name)
    assert.ok(items.length && items.every((f) => Array.isArray(f.user_fps)), 'install recorded the bundle with its user_fps')
    for (const f of items) { delete f.user_fps; delete f.sources }
    saveManifest(w.dir, m, fs)
    quiet(await status(), 'an older record with no user_fps')
  })
}
