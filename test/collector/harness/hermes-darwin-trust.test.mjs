// test/collector/harness/hermes-darwin-trust.test.mjs — D51④ (RFC 4.6 R8's Hermes half): on macOS a Hermes process is trusted only when the
// route it really reads carries the ssl_ca_cert line asight wrote. The installed build's httpx honours a route's own ssl_ca_cert and nothing else
// (agent/ssl_verify.py resolve_httpx_verify(): with no route CA it uses the platform store alone; SSL_CERT_FILE is a dead arm for it —
// a measured gap), so the .env block's SSL_CERT_FILE is no darwin trust source. The active route = the model
// block's inline route, or the providers / custom_providers entry model.provider names; a built-in provider has no route block. Every verdict goes
// through the real registry and tracker (G1) with the darwin wiring's layer rule (`d.darwin.layers` before `d.layers`); the asight line is the
// one the real darwin inject writes; the config shape is the lab flow's v12 `providers:` map.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { createTrustChecker } from '../../../src/collector/core/trust/confirm.mjs'
import { createTracker } from '../../../src/collector/core/tracker.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { TRUST_REASONS } from '../../../src/health/codes.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const ca = createCa()
const ALL = await loadHarnesses()
const hermes = ALL.find((d) => d.name === 'hermes')
const START = Date.now() + 60_000 // every file on disk predates the process
const PY = '/Users/u/.hermes/tools/python-3.14.7/bin/python3.14'
const ARGV = [PY, '-I', '-c', 'import hermes_bootstrap; import hermes_cli.main']

function box() {
  const home = tmpDir('asight-hermes-darwin-')
  const collectorDir = path.join(home, '.asight', 'collector')
  const bundle = path.join(collectorDir, 'ca', 'combined-hermes.pem')
  const userCa = path.join(home, 'corp', 'ca.pem')
  for (const f of [bundle, userCa]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ca.certPem) } // both hold the asight CA: only who wrote the line differs
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  put('.hermes/hermes-agent/install-stamp.json', '{"tag":"v2026.10.2"}') // the main build (no release-ca-bundle variant)
  return { home, collectorDir, bundle, userCa, put }
}

/** config.yaml with asight's ssl_ca_cert lines: the entries the real darwin inject writes, applied after their header lines. */
function withAsightLines(b, text) {
  b.put('.hermes/config.yaml', text)
  const ctx = {
    env: new Map(), home: b.home, collectorDir: b.collectorDir, running: [],
    readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
  }
  const lines = text.split('\n')
  for (const e of hermes.darwin.inject(ctx).entries.filter((x) => x.format === 'line')) {
    const at = lines.findIndex((l) => new RegExp(e.after).test(l))
    lines.splice(at + 1, 0, e.line)
  }
  return b.put('.hermes/config.yaml', lines.join('\n'))
}

/** The real tracker over the real registry; osLayers is the darwin wiring's rule. */
async function verdict(b) {
  const r = new EventEmitter()
  r.calls = []
  r.watch = async (pid, v) => { r.calls.push(v.decrypt) }
  r.unwatch = async () => {}
  r.scan = async () => []
  const tracker = createTracker({ redirector: r, registry: createRegistry(ALL), trust: createTrustChecker({ caCertPem: ca.certPem }), home: b.home, alive: () => false, collectorDir: b.collectorDir,
    osLayers: { darwin: (d) => (d.darwin && d.darwin.layers) || d.layers } })
  tracker.start()
  r.emit('exec', { os: 'darwin', pid: 41, ppid: 1, exe: PY, argv: ARGV, env: new Map([['HOME', b.home]]), cwd: b.home, startedAt: START, source: 'exec' })
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res))
  const [row] = tracker.agents()
  assert.equal(row && row.agent, 'hermes', 'judged as Hermes')
  return { trusted: row.trusted, reason: row.reason, decrypt: r.calls.at(-1) }
}

const PROVIDERS = (extra = []) => ['model:', '  provider: lab', '  default: lab-model', 'providers:', '  lab:', '    base_url: https://relay.asight.test/v1', '    api_key: sk-lab-FAKE', '    api_mode: chat_completions', ...extra, 'updates:', '  check: false', ''].join('\n')
const UNTRUSTED = { trusted: false, reason: 'route-without-ca', decrypt: false }

test('route-without-ca is a trust reason the health codes know', () => {
  assert.ok(TRUST_REASONS.includes('route-without-ca'))
  assert.equal(typeof hermes.trust.hints['route-without-ca'], 'string')
})

test('a built-in provider (model.provider names no route block) is route-without-ca, though the .env block holds the asight bundle', async () => {
  const b = box()
  b.put('.hermes/config.yaml', 'model:\n  provider: openrouter\n  default: anthropic/claude-sonnet-4\n')
  b.put('.hermes/.env', `SSL_CERT_FILE=${b.bundle}\n`)
  assert.deepEqual(await verdict(b), UNTRUSTED)
})

test('the providers: entry model.provider names carries asight\'s ssl_ca_cert line and its file holds the CA → trusted, decrypted', async () => {
  const b = box()
  const file = withAsightLines(b, PROVIDERS())
  assert.match(fs.readFileSync(file, 'utf8'), /ssl_ca_cert: .*combined-hermes\.pem .*asight collector/, 'the darwin inject wrote its line into the lab route')
  assert.deepEqual(await verdict(b), { trusted: true, reason: 'ok', decrypt: true })
})

test('the inline model-block route with asight\'s line is the active route too', async () => {
  const b = box()
  withAsightLines(b, 'model:\n  provider: custom\n  base_url: https://relay.asight.test/v1\n  api_mode: chat_completions\n  default: m\n')
  assert.deepEqual(await verdict(b), { trusted: true, reason: 'ok', decrypt: true })
})

test('a custom_providers item model.provider names (by its name or as custom:<name>) is the active route', async () => {
  for (const named of ['relay', 'custom:relay']) {
    const b = box()
    withAsightLines(b, `model:\n  provider: ${named}\n  default: m\ncustom_providers:\n  - name: other\n    base_url: https://other.test/v1\n  - name: relay\n    base_url: https://relay.asight.test/v1\n    api_mode: chat_completions\n`)
    assert.deepEqual(await verdict(b), { trusted: true, reason: 'ok', decrypt: true }, named)
  }
})

test('the same route with the user\'s own ssl_ca_cert (asight leaves it alone) is route-without-ca, even when that file holds the CA', async () => {
  const b = box()
  withAsightLines(b, PROVIDERS([`    ssl_ca_cert: ${b.userCa}`]))
  assert.doesNotMatch(fs.readFileSync(path.join(b.home, '.hermes', 'config.yaml'), 'utf8'), /asight collector/, 'inject did not touch a route that holds the user\'s ssl_ca_cert')
  assert.deepEqual(await verdict(b), UNTRUSTED)
})

test('asight\'s line on a route the model does not use does not trust the process', async () => {
  const b = box()
  withAsightLines(b, PROVIDERS().replace('  provider: lab', '  provider: openrouter'))
  assert.deepEqual(await verdict(b), UNTRUSTED)
})

test('.env SSL_CERT_FILE with the asight bundle and no route line is route-without-ca', async () => {
  const b = box()
  b.put('.hermes/config.yaml', PROVIDERS())
  b.put('.hermes/.env', `SSL_CERT_FILE=${b.bundle}\n`)
  assert.deepEqual(await verdict(b), UNTRUSTED)
})

test('asight\'s line followed by a later user ssl_ca_cert in the same route is route-without-ca (YAML keeps the last key; that file lacks the CA)', async () => {
  const b = box()
  const corp = b.put('corp/corp.pem', 'not the asight CA\n')
  const file = withAsightLines(b, PROVIDERS())
  const text = fs.readFileSync(file, 'utf8').replace('    api_mode: chat_completions\n', `    api_mode: chat_completions\n    ssl_ca_cert: ${corp}\n`)
  b.put('.hermes/config.yaml', text)
  assert.match(text, /asight collector[^\n]*\n(?:.*\n)*?    ssl_ca_cert: .*corp\.pem/, 'asight\'s line sits above the user\'s')
  assert.deepEqual(await verdict(b), UNTRUSTED)
})
