// The Windows product table (RFC 4.7 §6; plan Task 6 (c)). N10: no product is written to (D43). Every product's data directory, Verge's included, is byte-for-byte what it was after every reader of src/netenv
// has run over it, and the one adapter the code has is Verge's (a reader of its settings). The table is data: nothing in it is read from the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCTS_WIN32, productsOfImage } from '../../src/netenv/products-win32.mjs'
import { detect } from '../../src/netenv/probe.mjs'
import * as verge from '../../src/netenv/adapters/clash-verge-rev.mjs'
import { snapshot, startWorld } from './fixtures/verge-world.mjs'
import { proc, vergeProcs } from './fixtures/win-facts.mjs'

test('the table is 4.7 §6: five products, the images each is told by, and Verge alone adapted (it has a reader of its own settings)', () => {
  assert.deepEqual(PRODUCTS_WIN32.map((p) => [p.id, p.adapted]), [['clash-verge-rev', true], ['clash-party', false], ['flclash', false], ['gui-for-singbox', false], ['v2rayn', false]])
  const images = Object.fromEntries(PRODUCTS_WIN32.map((p) => [p.id, [...p.images, ...p.shared]]))
  assert.deepEqual(images['clash-verge-rev'], ['clash-verge.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe', 'clash-verge-service.exe'])
  assert.deepEqual(images['clash-party'], ['mihomo-party.exe'])
  assert.deepEqual(images.flclash, ['FlClash.exe', 'FlClashCore.exe'])
  assert.deepEqual(images['gui-for-singbox'], ['GUI.for.SingBox.exe', 'sing-box.exe'])
  assert.deepEqual(images.v2rayn, ['v2rayN.exe', 'xray.exe', 'sing-box.exe'])
  assert.ok(Object.isFrozen(PRODUCTS_WIN32) && PRODUCTS_WIN32.every((p) => Object.isFrozen(p) && Object.isFrozen(p.images)))
  assert.equal(new Set(PRODUCTS_WIN32.map((p) => p.id)).size, PRODUCTS_WIN32.length)
})

test('productsOfImage: an image of its own is the product\'s, a shared one is each candidate\'s, an unknown one is nobody\'s', () => {
  assert.deepEqual(productsOfImage('Verge-Mihomo.exe'), { own: ['clash-verge-rev'], shared: [] })
  assert.deepEqual(productsOfImage('sing-box.exe'), { own: [], shared: ['gui-for-singbox', 'v2rayn'] })
  assert.deepEqual(productsOfImage('chrome.exe'), { own: [], shared: [] })
  assert.deepEqual(productsOfImage('mihomo-foo.exe').own, ['clash-party'])
  assert.deepEqual(productsOfImage('MiHoMo-Foo.EXE').own, ['clash-party']) // image names are compared without case, pattern or not
  assert.deepEqual(productsOfImage('xmihomo.exe').own, [])
})

test('N10: the probe and every read of the Verge adapter leave the data directory of every product, Verge\'s own included, byte for byte as it was', async (t) => {
  const w = await startWorld(t)
  const roaming = path.dirname(w.home) // %APPDATA%: where the other products keep theirs, next to Verge's
  const dirs = { 'mihomo-party': ['config.yaml', 'profile.yaml', 'override/x.js'], FlClash: ['config.json', 'profiles/1.yaml'], 'GUI.for.SingBox': ['data/profiles.yaml', 'plugins/p.js'], v2rayN: ['guiConfigs/guiNConfig.json', 'binConfigs/config.json'] }
  for (const [d, files] of Object.entries(dirs)) for (const f of files) { const p = path.join(roaming, d, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `secret: s3cr3t\n# ${d} ${f}\n`) }
  const before = snapshot(roaming)
  assert.equal(Object.keys(before).length, 9 + Object.keys(snapshot(w.home)).length, 'the other products\' nine files and Verge\'s own')
  // every product of the table running; the probe reads, and the adapter does everything it can do
  const procs = [...vergeProcs(), ...['mihomo-party.exe', 'FlClash.exe', 'GUI.for.SingBox.exe', 'sing-box.exe', 'v2rayN.exe', 'xray.exe'].map((name, i) => proc({ pid: 7000 + i, name }))]
  const facts = async () => ({ procs: { ok: true, rows: procs }, listeners: { ok: true, rows: procs.map((p) => ({ pid: p.pid, port: 8000 + p.pid % 100 })) }, systemProxy: { ok: true, enable: true, server: '127.0.0.1:7897', autoConfigUrl: '' }, interfaces: { ok: true, rows: [], defaultIface: 'Ethernet' }, focusPorts: procs.map((p) => 8000 + p.pid % 100), verge: await w.adapter.facts() })
  const r = detect(await facts())
  assert.deepEqual(r.products.map((p) => p.id).sort(), ['clash-party', 'clash-verge-rev', 'flclash', 'gui-for-singbox', 'v2rayn'])
  assert.deepEqual(r.products.filter((p) => !p.adapted).map((p) => p.controller), ['not-applicable', 'not-applicable', 'not-applicable', 'not-applicable'])
  await w.adapter.readFields()
  await w.adapter.readConfigs()
  assert.deepEqual(snapshot(roaming), before, 'nothing under %APPDATA% changed: a read leaves no trace, not even in Verge\'s directory')
  // the one adapter the code has is Verge's: no factory for another product, and no other data directory in the table
  assert.deepEqual(Object.keys(verge).filter((k) => /^create.*Adapter$/.test(k)), ['createVergeAdapter'])
  assert.deepEqual(PRODUCTS_WIN32.filter((p) => !p.adapted && p.dataDir), [])
  const sources = fs.readdirSync(new URL('../../src/netenv', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => String(f).replaceAll('\\', '/'))
  assert.deepEqual(sources.filter((f) => f.startsWith('adapters/')), ['adapters/clash-verge-rev.mjs'])
})

test('N10: the probe and the product table import nothing: no fs, no socket, no process, so there is no write in them to run', () => {
  for (const f of ['probe.mjs', 'products-win32.mjs']) {
    const text = fs.readFileSync(new URL(`../../src/netenv/${f}`, import.meta.url), 'utf8')
    const imports = [...text.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    assert.deepEqual(imports.filter((x) => !/^\.\/products-win32\.mjs$/.test(x)), [], f)
    assert.ok(!/\b(writeFile|appendFile|rename|unlink|rmSync|mkdir|copyFile|createWriteStream|spawn|execFile|execSync|fetch|createConnection)\b/.test(text), `${f} names a write or a call out`)
  }
})

test('N10: a read-only product\'s running core on a port the probe is asked about is a read of the process table and the socket table, nothing else', () => {
  const calls = []
  const spy = new Proxy({}, { get: (_, k) => { calls.push(k); return undefined } })
  detect({ procs: { ok: true, rows: [proc({ pid: 1, name: 'FlClash.exe' })] }, listeners: { ok: true, rows: [{ pid: 1, port: 7890 }] }, focusPorts: [7890], systemProxy: { ok: true, enable: false }, interfaces: { ok: true, rows: [] }, productFacts: spy })
  assert.deepEqual([...new Set(calls)], ['flclash']) // the lookup of the product's own word, and nothing a write would need
})
