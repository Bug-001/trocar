// test/cli/linux-os-roots.test.mjs — the OS roots of the Linux arch's combined bundles (4.6 「合并包」): the first OS PEM bundle of SYSTEM_BUNDLES this machine
// has, not the Debian path alone. On Fedora / RHEL / openSUSE the Debian file does not exist, and the bundles once carried Node's roots only — without the CA
// a user installed system-wide (a corporate proxy's), which a replace-semantics entry (Codex's SSL_CERT_FILE; rustls drops the system roots) then needs.
// Judged by the bundle `on` writes, through the real Linux arch's osRoots over an injected filesystem; none on the machine is said (D38), never an empty bundle alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { runOnCli } from '../../src/cli/on.mjs'
import { loadArch } from '../../src/collector/arch/index.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { SYSTEM_BUNDLES } from '../../src/collector/core/tls/roots.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { fakeDaemon, fakeIo } from './fixtures/on-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const codex = (await loadHarnesses()).find((d) => d.name === 'codex')
const linux = await loadArch('linux')
const FEDORA = createCa({ commonName: 'corp CA in the Fedora system bundle' })
const FEDORA_BUNDLE = '/etc/pki/tls/certs/ca-bundle.crt'
const fpOf = (pem) => certBlocks(pem)[0].fp

/** One Linux `on codex` over a machine whose /etc holds `disk` (path → text; any other path is ENOENT, as on a real machine that lacks it). */
async function onWith(disk) {
  const home = tmpDir('asight-linux-roots-')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\n')
  const read = (f) => { if (f in disk) return disk[f]; throw Object.assign(new Error(`ENOENT: no such file or directory, open '${f}'`), { code: 'ENOENT' }) }
  // the real Linux arch's osRoots, its filesystem injected; no other arch hook (unit, routing, …) is in play here
  const arch = { osRoots: (o = {}) => linux.osRoots({ ...o, read }) }
  const io = fakeIo()
  const exit = await runOnCli(['--yes', 'codex'], {
    io, home, platform: 'linux', env: { HOME: home, XDG_RUNTIME_DIR: path.join(home, 'run') },
    deps: {
      parts: { os: 'linux', osRootsFile: null, harnesses: [codex], scan: async () => [], match: () => ({ agent: null }), arch },
      request: fakeDaemon().request, helperState: () => ({ ok: true }), linger: () => true,
      netenv: async () => ({ at: '2026-10-13T00:00:00.000Z', products: [], unknown: [{ reason: 'a test: no VPN probe runs here' }] }),
      freePort: async () => 47011, script: '/repo/bin/asight.mjs', sleep: async () => {}, user: 'alice', getuid: () => 1000, fs,
    },
  })
  const named = /^SSL_CERT_FILE=(.+)$/m.exec(fs.readFileSync(path.join(home, '.codex', '.env'), 'utf8'))
  assert.ok(named, 'the codex trust entry was written')
  const bundle = named[1].trim()
  const flowsDir = path.join(home, '.asight', 'collector', 'flows')
  const flows = fs.readdirSync(flowsDir).flatMap((n) => fs.readFileSync(path.join(flowsDir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  return { exit, text: io.text(), bundle, held: certBlocks(fs.readFileSync(bundle, 'utf8')).map((b) => b.fp), flows }
}

test('Linux on: only the Fedora bundle exists → the combined bundle carries its CA, and nothing is said missing (4.6 「合并包」)', async () => {
  const r = await onWith({ [FEDORA_BUNDLE]: `# Fedora's extracted trust\n${FEDORA.certPem}` })
  assert.equal(r.exit, 0, r.text)
  assert.ok(r.held.includes(fpOf(FEDORA.certPem)), 'the CA installed system-wide is in combined-codex.pem')
  assert.ok(r.held.includes(fpOf(tls.rootCertificates[0])), 'with Node\'s roots')
  assert.deepEqual(r.flows.filter((f) => f.code === 'system-roots-unavailable'), [], 'no missing-roots record')
})

test('Linux on: no OS bundle on the machine → the bundle has Node\'s roots and the asight CA only, and that is said in the receipt and in flows/ (D38)', async () => {
  const r = await onWith({ '/etc/ssl/certs/ca-certificates.crt': '' }) // a Debian path that is there but holds no certificate counts as none, too
  assert.equal(r.exit, 0, r.text)
  const asightCa = fpOf(fs.readFileSync(path.join(path.dirname(r.bundle), 'asight-ca.pem'), 'utf8'))
  const node = new Set(tls.rootCertificates.map(fpOf))
  assert.deepEqual(r.held.filter((fp) => !node.has(fp)), [asightCa], 'nothing but Node\'s roots and the asight CA')
  const rec = r.flows.filter((f) => f.code === 'system-roots-unavailable')
  assert.equal(rec.length, 1, `one record: ${JSON.stringify(r.flows.map((f) => [f.event, f.code]))}`)
  assert.deepEqual([rec[0].event, rec[0].where, rec[0].kind, rec[0].harness], ['install-note', 'install', 'note', 'codex'])
  assert.ok(rec[0].reason.includes(r.bundle), 'it names the bundle')
  for (const f of SYSTEM_BUNDLES) assert.ok(rec[0].reason.includes(f), `and every path looked at: ${f}`)
  assert.match(r.text, /carries Node's roots only: no OS trust bundle holds a certificate/, 'the receipt says it too')
})

test('Linux on: an OS bundle that is there but cannot be read stops the on before the agent\'s file is touched (D38)', async () => {
  const home = tmpDir('asight-linux-roots-')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\n')
  const read = (f) => { throw Object.assign(new Error(`${f === SYSTEM_BUNDLES[0] ? 'EACCES: permission denied' : 'ENOENT: no such file'}, open '${f}'`), { code: f === SYSTEM_BUNDLES[0] ? 'EACCES' : 'ENOENT' }) }
  const io = fakeIo()
  const exit = await runOnCli(['--yes', 'codex'], {
    io, home, platform: 'linux', env: { HOME: home, XDG_RUNTIME_DIR: path.join(home, 'run') },
    deps: {
      parts: { os: 'linux', osRootsFile: null, harnesses: [codex], scan: async () => [], match: () => ({ agent: null }), arch: { osRoots: (o = {}) => linux.osRoots({ ...o, read }) } },
      request: fakeDaemon().request, helperState: () => ({ ok: true }), linger: () => true,
      netenv: async () => ({ at: '2026-10-13T00:00:00.000Z', products: [], unknown: [{ reason: 'a test: no VPN probe runs here' }] }),
      freePort: async () => 47011, script: '/repo/bin/asight.mjs', sleep: async () => {}, user: 'alice', getuid: () => 1000, fs,
    },
  }).catch((e) => e)
  assert.notEqual(exit, 0)
  assert.equal(fs.readFileSync(path.join(home, '.codex', '.env'), 'utf8'), 'OPENAI_API_KEY=sk-test\n', 'the user\'s file is as it was')
  assert.ok(!fs.existsSync(path.join(home, '.asight', 'collector', 'ca', 'combined-codex.pem')), 'no bundle written on a guess')
})
