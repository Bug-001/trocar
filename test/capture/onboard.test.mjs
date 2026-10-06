import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import {
  generateCa, leafHosts, installCa, verifyUserTrustOnly, uninstallCa,
  writeCliSteer, clearCliSteer, atraceOn, atraceOff,
} from '../../src/capture/onboard.mjs'
import { CA_CN } from '../../src/capture/trust-store.mjs'

// D22 landed: onboard is now a REAL cross-platform (macOS + Linux) CA-trust installer.
// Trust-store mutation is always injected here, so no test ever touches the real keychain /
// NSS db (必拒 采集安全#3). CA generation runs real OpenSSL into throwaway tmp dirs.

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }
// Every steer call MUST inject stashPath — the default lives under the real ~/.atrace (B2).
function steerPaths() {
  const dir = tmp('asight-settings-')
  return { settingsPath: path.join(dir, 'settings.json'), stashPath: path.join(dir, 'steer-backup.json') }
}
function recorder(result = { status: 0 }) {
  const calls = []
  return { calls, run: (file, args) => { calls.push({ file, args }); return result } }
}

test('generateCa produces a real CA + leaf (openssl), CA subject carries the CN', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const out = generateCa({ caDir })
  assert.equal(out.existed, false)
  for (const f of [out.caCrt, out.caKey, out.leafKey, out.leafCrt]) assert.ok(fs.existsSync(f), `${f} exists`)
  const subj = execFileSync('openssl', ['x509', '-in', out.caCrt, '-noout', '-subject'], { encoding: 'utf8' })
  assert.ok(subj.includes(CA_CN), `CA subject carries ${CA_CN}`)
  assert.equal(generateCa({ caDir }).existed, true) // idempotent short-circuit
})

test('generateCa keys are 0600 (private material not world-readable)', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const out = generateCa({ caDir })
  assert.equal(fs.statSync(out.caKey).mode & 0o777, 0o600)
  assert.equal(fs.statSync(out.leafKey).mode & 0o777, 0o600)
})

// ── B3: a Ctrl-C between the CA and the leaf must not poison the dir forever ──────────────────
test('B3 a half-written CA dir (ca.crt only) is REGENERATED, not reported as existing', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  fs.mkdirSync(caDir, { recursive: true })
  fs.writeFileSync(path.join(caDir, 'atrace-ca.crt'), 'interrupted before leaf.crt existed\n')
  const out = generateCa({ caDir })
  assert.equal(out.existed, false, 'must not short-circuit on ca.crt alone')
  for (const f of [out.caCrt, out.caKey, out.leafKey, out.leafCrt]) assert.ok(fs.existsSync(f), `${f} regenerated`)
})

test('B3 EVERY one of the four artifacts is required for the idempotent short-circuit', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const full = generateCa({ caDir })
  assert.equal(generateCa({ caDir }).existed, true, 'complete dir short-circuits')
  for (const missing of [full.caCrt, full.caKey, full.leafKey, full.leafCrt]) {
    const saved = fs.readFileSync(missing)
    fs.rmSync(missing)
    assert.equal(generateCa({ caDir }).existed, false, `${path.basename(missing)} missing → regenerate`)
    fs.writeFileSync(missing, saved) // restore for the next iteration (regen already rewrote all four)
  }
})

test('B3 an interrupted --force regen leaves the previous complete CA intact (no CA/leaf mismatch)', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const before = generateCa({ caDir })
  const originalCa = fs.readFileSync(before.caCrt, 'utf8')
  const originalLeaf = fs.readFileSync(before.leafCrt, 'utf8')
  let n = 0
  const flaky = (file, args) => { if (++n > 2) throw new Error('simulated Ctrl-C mid-regen'); return defaultRunLike(file, args) }
  assert.throws(() => generateCa({ caDir, force: true, run: flaky }), /Ctrl-C/)
  assert.equal(fs.readFileSync(before.caCrt, 'utf8'), originalCa, 'old CA untouched by the failed regen')
  assert.equal(fs.readFileSync(before.leafCrt, 'utf8'), originalLeaf, 'old leaf still matches that CA')
})
function defaultRunLike(file, args) { execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'] }); return { status: 0 } }

// ── B4: the leaf must authorize the host the MITM is actually asked to terminate ──────────────
const sanOf = (crt) => execFileSync('openssl', ['x509', '-in', crt, '-noout', '-text'], { encoding: 'utf8' })

test('B4 generateCa({hosts}) drives BOTH the leaf CN and the SAN (not a hardcoded anthropic)', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const out = generateCa({ caDir, hosts: ['api.deepseek.com'] })
  const text = sanOf(out.leafCrt)
  assert.match(text, /Subject:.*CN\s*=\s*api\.deepseek\.com/, 'CN follows the requested host')
  assert.match(text, /DNS:api\.deepseek\.com/, 'SAN follows the requested host')
  assert.doesNotMatch(text, /api\.anthropic\.com/, 'no stale hardcoded host')
})

test('B4 multiple hosts all land in the SAN (one leaf can serve several capture targets)', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const out = generateCa({ caDir, hosts: ['api.anthropic.com', 'api.deepseek.com'] })
  const text = sanOf(out.leafCrt)
  assert.match(text, /DNS:api\.anthropic\.com/)
  assert.match(text, /DNS:api\.deepseek\.com/)
})

test('B4 default stays api.anthropic.com (no behaviour change for the existing capture path)', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  assert.match(sanOf(generateCa({ caDir }).leafCrt), /DNS:api\.anthropic\.com/)
  assert.deepEqual(leafHosts(caDir), ['api.anthropic.com'], 'covered hosts are recorded, not guessed')
})

test('B4 asking for a host the existing leaf does NOT cover regenerates instead of short-circuiting', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  generateCa({ caDir }) // the anthropic-only leaf
  const out = generateCa({ caDir, hosts: ['api.deepseek.com'] })
  assert.equal(out.existed, false, 'a leaf that cannot authorize the target is not reusable')
  assert.match(sanOf(out.leafCrt), /DNS:api\.deepseek\.com/)
  assert.equal(generateCa({ caDir, hosts: ['api.deepseek.com'] }).existed, true, 'now it IS reusable')
})

test('B4 a legacy CA dir with no recorded hosts is treated as anthropic-only', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  generateCa({ caDir })
  fs.rmSync(path.join(caDir, 'leaf.hosts')) // pre-B4 dir: four artifacts, no sidecar
  assert.deepEqual(leafHosts(caDir), ['api.anthropic.com'], 'legacy leaves only ever covered anthropic')
  assert.equal(generateCa({ caDir }).existed, true, 'still reusable for anthropic')
  assert.equal(generateCa({ caDir, hosts: ['api.deepseek.com'] }).existed, false, 'but not for anything else')
})

// The behaviour the SAN assertions above stand in for: a real TLS peer accepts the generated leaf
// for the host it was generated for, and rejects it for one it was not. Ephemeral port (0) only.
test('B4 a host-driven leaf actually authorizes that host in a real TLS handshake', async () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const ca = generateCa({ caDir, hosts: ['api.deepseek.com'] })
  const srv = tls.createServer({ key: fs.readFileSync(ca.leafKey), cert: fs.readFileSync(ca.leafCrt) }, (s) => s.end())
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const shake = (servername) => new Promise((resolve) => {
    const s = tls.connect({ port, host: '127.0.0.1', servername, ca: [fs.readFileSync(ca.caCrt)] },
      () => { s.end(); resolve('ok') })
    s.on('error', (e) => resolve(e.code || e.message))
  })
  assert.equal(await shake('api.deepseek.com'), 'ok', 'the requested host authorizes')
  assert.equal(await shake('api.anthropic.com'), 'ERR_TLS_CERT_ALTNAME_INVALID', 'a host outside the SAN does not')
  srv.close()
})

test('installCa dispatches to the per-OS installer via injected runner (no real store)', () => {
  const rec = recorder()
  const r = installCa({ caCrt: '/x/ca.crt', platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' } })
  assert.equal(r.platform, 'linux')
  assert.equal(r.ok, true)
  assert.equal(rec.calls[0].file, 'certutil')
  assert.ok(rec.calls[0].args.includes('sql:/tmp/nss'))
})

test('verifyUserTrustOnly maps installer status; uninstall dispatches', () => {
  assert.equal(verifyUserTrustOnly({ platform: 'darwin', installerOpts: { run: () => ({ status: 0 }) } }), true)
  assert.equal(verifyUserTrustOnly({ platform: 'darwin', installerOpts: { run: () => ({ status: 44 }) } }), false) // errSecItemNotFound
  assert.throws(() => verifyUserTrustOnly({ platform: 'darwin', installerOpts: { run: () => ({ status: 1, stderr: 'boom' }) } }), /could not be checked: boom/)
  const rec = recorder()
  uninstallCa({ platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' } })
  assert.ok(rec.calls[0].args.includes('-D'))
})

test('CLI steer writes HTTPS_PROXY into settings.json, preserving other keys; clear reverts', () => {
  const { settingsPath, stashPath } = steerPaths()
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }))
  const env = writeCliSteer({ settingsPath, stashPath, proxyUrl: 'http://127.0.0.1:8899' })
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:8899')
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost')
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.equal(after.model, 'opus') // untouched
  assert.equal(after.env.FOO, 'bar') // untouched
  clearCliSteer({ settingsPath, stashPath })
  const reverted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.equal(reverted.env.HTTPS_PROXY, undefined)
  assert.equal(reverted.env.NO_PROXY, undefined)
  assert.equal(reverted.env.FOO, 'bar') // still preserved
})

// ── B1: a settings.json we cannot parse MUST NOT be silently replaced ────────────────────────
test('B1 writeCliSteer REFUSES to write when the existing settings.json is unparseable', () => {
  const { settingsPath, stashPath } = steerPaths()
  const original = '{\n  // a comment some tools accept, strict JSON does not\n  "model": "opus",\n  "permissions": {"allow": ["Bash"]}\n}\n'
  fs.writeFileSync(settingsPath, original)
  assert.throws(
    () => writeCliSteer({ settingsPath, stashPath, proxyUrl: 'http://127.0.0.1:8899' }),
    (e) => e.message.includes(settingsPath) && /refus/i.test(e.message),
    'throws, naming the file, saying asight refused',
  )
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'file byte-identical — never written on a failed read')
})

test('B1 clearCliSteer also refuses on an unparseable settings.json (no half-revert)', () => {
  const { settingsPath, stashPath } = steerPaths()
  const original = '{ this is not json at all }'
  fs.writeFileSync(settingsPath, original)
  assert.throws(() => clearCliSteer({ settingsPath, stashPath }), /refus/i)
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original)
})

test('B1 a missing settings.json is still fine (ENOENT → fresh {}), and no backup is made', () => {
  const { settingsPath, stashPath } = steerPaths()
  const env = writeCliSteer({ settingsPath, stashPath, proxyUrl: 'http://127.0.0.1:8899' })
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:8899')
  assert.equal(fs.existsSync(settingsPath + '.asight-bak'), false, 'nothing existed → nothing to back up')
})

test('B1 an existing settings.json is copied to .asight-bak before the first overwrite', () => {
  const { settingsPath, stashPath } = steerPaths()
  const original = JSON.stringify({ model: 'opus', mcpServers: { x: { command: 'y' } } }, null, 2) + '\n'
  fs.writeFileSync(settingsPath, original)
  writeCliSteer({ settingsPath, stashPath, proxyUrl: 'http://127.0.0.1:8899' })
  assert.equal(fs.readFileSync(settingsPath + '.asight-bak', 'utf8'), original, 'pre-steer bytes recoverable')
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.deepEqual(after.mcpServers, { x: { command: 'y' } }, 'user keys survive the steer')
})

// ── B2: a pre-existing corporate proxy must survive an on → off round trip ────────────────────
test('B2 on() stashes a displaced pre-existing HTTPS_PROXY/NO_PROXY; off() restores them verbatim', () => {
  const dir = tmp('asight-settings-')
  const settingsPath = path.join(dir, 'settings.json')
  const stashPath = path.join(dir, 'steer-backup.json')
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'opus',
    env: { HTTPS_PROXY: 'http://corp.proxy:3128', NO_PROXY: '*.corp.internal', OTHER: 'keep' },
  }))
  writeCliSteer({ settingsPath, stashPath, proxyUrl: 'http://127.0.0.1:8899' })
  assert.deepEqual(JSON.parse(fs.readFileSync(stashPath, 'utf8')).env,
    { HTTPS_PROXY: 'http://corp.proxy:3128', NO_PROXY: '*.corp.internal' }, 'displaced values stashed')
  const off = clearCliSteer({ settingsPath, stashPath })
  assert.equal(off.HTTPS_PROXY, 'http://corp.proxy:3128', 'corporate proxy restored, not deleted')
  assert.equal(off.NO_PROXY, '*.corp.internal', 'corporate NO_PROXY restored, not deleted')
  assert.equal(off.OTHER, 'keep')
  assert.equal(fs.existsSync(stashPath), false, 'stash consumed on restore')
})

test('B2 keys asight itself introduced are deleted on off (nothing invented from an empty stash)', () => {
  const dir = tmp('asight-settings-')
  const settingsPath = path.join(dir, 'settings.json')
  const stashPath = path.join(dir, 'steer-backup.json')
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { FOO: 'bar' } }))
  writeCliSteer({ settingsPath, stashPath, proxyUrl: 'http://127.0.0.1:8899' })
  const off = clearCliSteer({ settingsPath, stashPath })
  assert.equal(off.HTTPS_PROXY, undefined, 'asight-introduced key removed')
  assert.equal(off.NO_PROXY, undefined)
  assert.equal(off.FOO, 'bar')
})

test('B2 an explicit restoreProxy still wins over the stash (4.1:61 — point back at the VPN)', () => {
  const dir = tmp('asight-settings-')
  const settingsPath = path.join(dir, 'settings.json')
  const stashPath = path.join(dir, 'steer-backup.json')
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { HTTPS_PROXY: 'http://corp.proxy:3128' } }))
  writeCliSteer({ settingsPath, stashPath, proxyUrl: 'http://127.0.0.1:8899' })
  const off = clearCliSteer({ settingsPath, stashPath, restoreProxy: 'http://127.0.0.1:7897' })
  assert.equal(off.HTTPS_PROXY, 'http://127.0.0.1:7897', 'caller-specified restore takes precedence')
})

test('B2 atraceOn/atraceOff thread the stash end-to-end (the round trip users actually run)', () => {
  const dir = tmp('asight-settings-')
  const settingsPath = path.join(dir, 'settings.json')
  const stashPath = path.join(dir, 'steer-backup.json')
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const rec = recorder()
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { HTTPS_PROXY: 'http://corp.proxy:3128', NO_PROXY: '*.corp.internal' } }))
  atraceOn({ caDir, settingsPath, stashPath, platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' } })
  atraceOff({ settingsPath, stashPath, platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' } })
  const env = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env
  assert.equal(env.HTTPS_PROXY, 'http://corp.proxy:3128', 'survives the full on→off round trip')
  assert.equal(env.NO_PROXY, '*.corp.internal')
})

// ── B9: never steer the harness at a MITM whose CA was never trusted ─────────────────────────
// installCa maps a non-zero installer exit to ok:false. Writing the steer anyway leaves the harness
// pointed at a MITM it cannot validate → EVERY request dies in a TLS error the user cannot explain.
// The steer is a write whose precondition (CA is trusted) MUST be verified first.
test('B9 atraceOn does NOT write the CLI steer when the CA trust install failed', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const { settingsPath, stashPath } = steerPaths()
  const failing = () => ({ status: 1, stdout: '', stderr: 'certutil: could not open the database' })
  assert.throws(
    () => atraceOn({ caDir, settingsPath, stashPath, platform: 'linux', installerOpts: { run: failing, nssdb: '/tmp/nss' } }),
    (e) => /trust|CA/i.test(e.message) && /steer/i.test(e.message) && /certutil: could not open the database/.test(e.message),
    'throws, saying the CA install failed, that no steer was written, and what the installer said',
  )
  assert.equal(fs.existsSync(settingsPath), false, 'settings.json was never written — the harness is left untouched (still direct)')
})

test('B9 the failed-install error still tells the user the machine state (CA generated, not trusted)', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const { settingsPath, stashPath } = steerPaths()
  const failing = () => ({ status: 1, stderr: 'nope' })
  let err
  try { atraceOn({ caDir, settingsPath, stashPath, platform: 'linux', installerOpts: { run: failing, nssdb: '/tmp/nss' } }) } catch (e) { err = e }
  assert.ok(err, 'it threw')
  assert.equal(err.install.ok, false, 'the install result is attached for programmatic callers')
  assert.ok(fs.existsSync(err.ca.caCrt), 'the CA it generated is named, so the user can retry the install')
  assert.match(err.message, new RegExp(err.ca.caCrt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'and the message names the CA path')
})

test('B9 an existing settings.json is left byte-identical when the CA install fails', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const { settingsPath, stashPath } = steerPaths()
  const original = JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }, null, 2) + '\n'
  fs.writeFileSync(settingsPath, original)
  assert.throws(() => atraceOn({ caDir, settingsPath, stashPath, platform: 'linux', installerOpts: { run: () => ({ status: 1 }), nssdb: '/tmp/nss' } }))
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'untouched')
  assert.equal(fs.existsSync(stashPath), false, 'and no half-written stash to confuse a later off()')
})

test('atraceOn/atraceOff full onboard, fully injected (hermetic — no real keychain/settings)', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const { settingsPath, stashPath } = steerPaths()
  const rec = recorder()
  const on = atraceOn({ caDir, settingsPath, stashPath, platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' }, proxyUrl: 'http://127.0.0.1:8899' })
  assert.ok(fs.existsSync(on.ca.caCrt))
  assert.equal(on.install.ok, true)
  assert.equal(on.steer.HTTPS_PROXY, 'http://127.0.0.1:8899')
  // atraceOff without removeCa must NOT touch the trust store
  const before = rec.calls.length
  const off = atraceOff({ settingsPath, stashPath, platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' } })
  assert.equal(off.ca, null)
  assert.equal(rec.calls.length, before) // no extra installer call
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env.HTTPS_PROXY, undefined)
})

// REGRESSION GUARD (collateral-damage audit, 2026-07-19).
// The `!install.ok` abort added above treats a non-zero installer exit as "the CA is not trusted".
// On macOS the installer is `security add-certificates -k login.keychain-db <ca>`, which EXITS
// NON-ZERO WHEN THE CERT IS ALREADY PRESENT ("already in <keychain>"). So on any machine that has
// already been onboarded — including the developer's own — the SUCCESS path reported ok:false and
// `asight on` aborted without writing the steer, and the board's 监测 toggle silently did nothing.
// The precondition we actually care about is "is the CA trusted", not "did the installer exit 0".
const keychainRun = ({ certPresent }) => (file, args) => {
  const a = (args || []).join(' ')
  if (a.includes('add-certificates')) return { status: 1, stdout: '', stderr: 'security: ca.crt: already in login.keychain-db' }
  if (a.includes('find-certificate')) return { status: certPresent ? 0 : 1, stdout: '', stderr: '' }
  return { status: 0, stdout: '', stderr: '' }
}

test('atraceOn proceeds when the installer fails BECAUSE the CA is already trusted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-dup-ca-'))
  const settingsPath = path.join(dir, 'settings.json')
  try {
    atraceOn({
      caDir: path.join(dir, 'ca'), settingsPath, stashPath: path.join(dir, 'stash.json'),
      platform: 'darwin',
      installerOpts: { run: keychainRun({ certPresent: true }), keychain: path.join(dir, 'kc') },
    })
    assert.ok(fs.existsSync(settingsPath),
      'the steer MUST be written when the CA is verifiably trusted — a duplicate-install exit code '
      + 'is a SUCCESS signal on macOS, and aborting on it breaks every already-onboarded machine')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('atraceOn still aborts when the CA is genuinely NOT trusted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-no-ca-'))
  const settingsPath = path.join(dir, 'settings.json')
  try {
    assert.throws(() => atraceOn({
      caDir: path.join(dir, 'ca'), settingsPath, stashPath: path.join(dir, 'stash.json'),
      platform: 'darwin',
      installerOpts: { run: keychainRun({ certPresent: false }), keychain: path.join(dir, 'kc') },
    }), /ABORTED/, 'a real install failure must still abort rather than steer into a broken TLS path')
    assert.ok(!fs.existsSync(settingsPath), 'no steer may be written when the CA is absent')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
