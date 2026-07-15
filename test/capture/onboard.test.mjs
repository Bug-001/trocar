import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  generateCa, installCa, verifyUserTrustOnly, uninstallCa,
  writeCliSteer, clearCliSteer, atraceOn, atraceOff,
} from '../../src/capture/onboard.mjs'
import { CA_CN } from '../../src/capture/trust-store.mjs'

// D22 landed: onboard is now a REAL cross-platform (macOS + Linux) CA-trust installer.
// Trust-store mutation is always injected here, so no test ever touches the real keychain /
// NSS db (必拒 采集安全#3). CA generation runs real OpenSSL into throwaway tmp dirs.

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }
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
  assert.equal(verifyUserTrustOnly({ platform: 'darwin', installerOpts: { run: () => ({ status: 1 }) } }), false)
  const rec = recorder()
  uninstallCa({ platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' } })
  assert.ok(rec.calls[0].args.includes('-D'))
})

test('CLI steer writes HTTPS_PROXY into settings.json, preserving other keys; clear reverts', () => {
  const settingsPath = path.join(tmp('asight-settings-'), 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }))
  const env = writeCliSteer({ settingsPath, proxyUrl: 'http://127.0.0.1:8899' })
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:8899')
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost')
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.equal(after.model, 'opus') // untouched
  assert.equal(after.env.FOO, 'bar') // untouched
  clearCliSteer({ settingsPath })
  const reverted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.equal(reverted.env.HTTPS_PROXY, undefined)
  assert.equal(reverted.env.NO_PROXY, undefined)
  assert.equal(reverted.env.FOO, 'bar') // still preserved
})

test('atraceOn/atraceOff full onboard, fully injected (hermetic — no real keychain/settings)', () => {
  const caDir = path.join(tmp('asight-ca-'), 'ca')
  const settingsPath = path.join(tmp('asight-settings-'), 'settings.json')
  const rec = recorder()
  const on = atraceOn({ caDir, settingsPath, platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' }, proxyUrl: 'http://127.0.0.1:8899' })
  assert.ok(fs.existsSync(on.ca.caCrt))
  assert.equal(on.install.ok, true)
  assert.equal(on.steer.HTTPS_PROXY, 'http://127.0.0.1:8899')
  // atraceOff without removeCa must NOT touch the trust store
  const before = rec.calls.length
  const off = atraceOff({ settingsPath, platform: 'linux', installerOpts: { run: rec.run, nssdb: '/tmp/nss' } })
  assert.equal(off.ca, null)
  assert.equal(rec.calls.length, before) // no extra installer call
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env.HTTPS_PROXY, undefined)
})
