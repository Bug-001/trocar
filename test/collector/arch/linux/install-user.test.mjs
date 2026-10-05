// Unit tests for the D36 per-user installer (installUser/uninstallUser). No root, no systemd:
// everything is fs + node:crypto, so these run on the Mac. They pin the per-user CA shape, the
// byte-identical env restore, capture-keeping, the never-`rm -rf ~/.asight` rule, and the
// refuses-root guard. The root helper half (setupHelper/setcap) is covered elsewhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { installUser, uninstallUser, readInstall } from '../../../../src/collector/arch/linux/install.mjs'

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'asight-home-')) }

test('installUser mints a per-user CA under ~/.asight/collector/ca, separate from the legacy CA', () => {
  const home = tmpHome()
  try {
    // A legacy CA already present at ~/.asight/ca must never be touched.
    const legacyDir = path.join(home, '.asight', 'ca')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'asight-ca.pem'), 'LEGACY-ATRACE-CA')

    const rec = installUser({ home, envTargets: [] })
    const caDir = path.join(home, '.asight', 'collector', 'ca')
    const caKey = path.join(caDir, 'ca.key')
    const caPem = path.join(caDir, 'asight-ca.pem')
    assert.ok(fs.existsSync(caKey) && fs.existsSync(caPem), 'CA key + pem created')
    assert.equal(fs.statSync(caDir).mode & 0o777, 0o700, 'ca dir is 0700')
    assert.equal(fs.statSync(caKey).mode & 0o777, 0o600, 'ca.key is 0600')
    const cert = new X509Certificate(fs.readFileSync(caPem, 'utf8'))
    assert.equal(cert.ca, true, 'minted cert is a CA (BasicConstraints CA:TRUE)')
    assert.equal(rec.ca.created_by_asight, true)
    // Legacy CA untouched.
    assert.equal(fs.readFileSync(path.join(legacyDir, 'asight-ca.pem'), 'utf8'), 'LEGACY-ATRACE-CA')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('env injection restores byte-identically on uninstall when the file is untouched', () => {
  const home = tmpHome()
  try {
    const file = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const original = JSON.stringify({ env: { EXISTING: '1' }, other: true }, null, 2) + '\n'
    fs.writeFileSync(file, original)
    const originalBytes = fs.readFileSync(file)

    installUser({ home, envTargets: [{ file, key: 'NODE_EXTRA_CA_CERTS' }] })
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(after.env.NODE_EXTRA_CA_CERTS.endsWith('asight-ca.pem'), 'injected CA path value')
    assert.equal(after.env.EXISTING, '1', 'kept the existing key')

    uninstallUser({ home })
    assert.ok(fs.readFileSync(file).equals(originalBytes), 'file restored byte-identically')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('env injection into a new JSON settings file removes that file entirely on uninstall', () => {
  const home = tmpHome()
  try {
    // A GENERIC JSON settings file + generic add-semantics key (per-harness injection is a later
    // step; this just exercises the create-then-remove path).
    const file = path.join(home, '.some-tool', 'settings.json')
    installUser({ home, envTargets: [{ file, key: 'EXTRA_CA', value: '/abs/ca.pem' }] })
    assert.ok(fs.existsSync(file), 'created the env file')
    uninstallUser({ home })
    assert.ok(!fs.existsSync(file), 'removed the env file we created')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('a second install keeps the first-recorded original (restore still works after re-install)', () => {
  const home = tmpHome()
  try {
    const file = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const original = JSON.stringify({ env: { EXISTING: '1' } }, null, 2) + '\n'
    fs.writeFileSync(file, original)
    const originalBytes = fs.readFileSync(file)
    installUser({ home, envTargets: [{ file, key: 'NODE_EXTRA_CA_CERTS' }] })
    installUser({ home, envTargets: [{ file, key: 'NODE_EXTRA_CA_CERTS' }] }) // re-install over the injected file
    uninstallUser({ home })
    assert.ok(fs.readFileSync(file).equals(originalBytes), 're-install did not corrupt the recorded original')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('a file we created but the user edited is not deleted; only our key is removed', () => {
  const home = tmpHome()
  try {
    const file = path.join(home, '.some-tool', 'settings.json')
    installUser({ home, envTargets: [{ file, key: 'EXTRA_CA', value: '/abs/ca.pem' }] })
    // User edits the file we created, adding their own key.
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    obj.userKey = 'mine'; obj.env.USER_SET = 'x'
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
    uninstallUser({ home })
    assert.ok(fs.existsSync(file), 'edited file we created is kept')
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after.userKey, 'mine', "user's edit preserved")
    assert.equal(after.env && after.env.USER_SET, 'x', "user's env key preserved")
    assert.ok(!(after.env && 'EXTRA_CA' in after.env), 'only our key was removed')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('a non-JSON settings file is refused, never rewritten as JSON', () => {
  const home = tmpHome()
  try {
    const file = path.join(home, '.some-tool', 'config.yaml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const yaml = 'model: gpt\nkey: value\n'
    fs.writeFileSync(file, yaml)
    assert.throws(() => installUser({ home, envTargets: [{ file, key: 'EXTRA_CA', value: '/abs/ca.pem' }] }), /not valid JSON/)
    assert.equal(fs.readFileSync(file, 'utf8'), yaml, 'the non-JSON file was left untouched')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('a replace-semantics env key is refused (built-in library keys + caller-named ones)', () => {
  const home = tmpHome()
  try {
    const file = path.join(home, '.t', 's.json')
    for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) {
      assert.throws(() => installUser({ home, envTargets: [{ file, key }] }),
        /replaces the whole trust store/, `${key} refused by default`)
    }
    // arch/ names no harness: a caller that knows a tool-specific replace-semantics variable passes
    // it in, and it is refused exactly the same way.
    assert.throws(() => installUser({ home, replaceKeys: ['SOMETOOL_CA_BUNDLE'], envTargets: [{ file, key: 'SOMETOOL_CA_BUNDLE' }] }),
      /replaces the whole trust store/, 'a caller-named replace-semantics key is refused')
    assert.ok(!fs.existsSync(file), 'no refused key was written')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('a refused target aborts the whole install atomically: no earlier target is left injected', () => {
  const home = tmpHome()
  try {
    const good = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(good), { recursive: true })
    fs.writeFileSync(good, JSON.stringify({ env: { EXISTING: '1' } }, null, 2) + '\n')
    const goodBytes = fs.readFileSync(good)
    const bad = path.join(home, '.some-tool', 'config.yaml')
    fs.mkdirSync(path.dirname(bad), { recursive: true })
    fs.writeFileSync(bad, 'not: json: at: all\n')
    // good first, the non-JSON target second. installUser MUST validate both before writing either,
    // so the throw leaves the good file untouched and no install.json is recorded to revert from.
    assert.throws(() => installUser({ home, envTargets: [
      { file: good, key: 'NODE_EXTRA_CA_CERTS' }, { file: bad, key: 'EXTRA_CA', value: '/abs/ca.pem' },
    ] }), /not valid JSON/)
    assert.ok(fs.readFileSync(good).equals(goodBytes), 'the earlier valid target was NOT written before the refusal')
    assert.equal(readInstall(home), null, 'no install.json recorded for the aborted install')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('a user edit made between two installs is preserved on uninstall (not lost to a byte-restore)', () => {
  const home = tmpHome()
  try {
    const file = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ env: { EXISTING: '1' } }, null, 2) + '\n')
    installUser({ home, envTargets: [{ file, key: 'NODE_EXTRA_CA_CERTS' }] })
    const edited = JSON.parse(fs.readFileSync(file, 'utf8'))
    edited.theme = 'dark' // the user edits the file between installs
    fs.writeFileSync(file, JSON.stringify(edited, null, 2) + '\n')
    installUser({ home, envTargets: [{ file, key: 'NODE_EXTRA_CA_CERTS' }] }) // re-install over the edited file
    uninstallUser({ home })
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after.theme, 'dark', "user's between-install edit preserved (no byte-restore to the pre-edit original)")
    assert.equal(after.env && after.env.EXISTING, '1', 'original key preserved')
    assert.ok(!(after.env && 'NODE_EXTRA_CA_CERTS' in after.env), 'only our key removed')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('a re-install with fewer targets still reverts the dropped target on uninstall', () => {
  const home = tmpHome()
  try {
    const a = path.join(home, '.a', 's.json')
    const b = path.join(home, '.b', 's.json')
    installUser({ home, envTargets: [{ file: a, key: 'EXTRA_CA', value: '/x' }, { file: b, key: 'EXTRA_CA', value: '/x' }] })
    assert.ok(fs.existsSync(a) && fs.existsSync(b), 'both created')
    installUser({ home, envTargets: [{ file: a, key: 'EXTRA_CA', value: '/x' }] }) // b dropped from this install's targets
    uninstallUser({ home })
    assert.ok(!fs.existsSync(a), 'a removed')
    assert.ok(!fs.existsSync(b), 'b carried forward and still reverted despite being dropped from the re-install targets')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('uninstall keeps captures by default and removes them only with purgeData, never rm -rf ~/.asight', () => {
  const home = tmpHome()
  try {
    installUser({ home, envTargets: [] })
    const collectorDir = path.join(home, '.asight', 'collector')
    const capture = path.join(collectorDir, 'session-1.ndjson')
    fs.writeFileSync(capture, '{"t":1}\n')
    // An unrelated legacy file at the ~/.asight root must survive any uninstall.
    const legacy = path.join(home, '.asight', 'legacy-marker')
    fs.writeFileSync(legacy, 'keep me')

    uninstallUser({ home })
    assert.ok(fs.existsSync(capture), 'capture kept by default')
    assert.ok(!fs.existsSync(path.join(collectorDir, 'ca')), 'CA dir removed')
    assert.ok(!fs.existsSync(path.join(collectorDir, 'install.json')), 'install.json removed')
    assert.ok(fs.existsSync(legacy), '~/.asight root was not wiped')

    const res = uninstallUser({ home, purgeData: true })
    assert.ok(!fs.existsSync(capture), 'purgeData removed the capture')
    assert.equal(res.purged, 1)
    assert.ok(fs.existsSync(legacy), '~/.asight root still intact after purge')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('withUnit writes a systemd --user unit that sets neither NoNewPrivileges nor CapabilityBoundingSet', () => {
  const home = tmpHome()
  try {
    installUser({ home, envTargets: [], withUnit: true })
    const unit = path.join(home, '.config', 'systemd', 'user', 'asight-collector.service')
    assert.ok(fs.existsSync(unit), 'unit written')
    const text = fs.readFileSync(unit, 'utf8')
    assert.ok(!/NoNewPrivileges/.test(text), 'unit must not set NoNewPrivileges (would strip helper caps)')
    assert.ok(!/CapabilityBoundingSet/.test(text), 'unit must not set CapabilityBoundingSet')
    uninstallUser({ home })
    assert.ok(!fs.existsSync(unit), 'unit removed on uninstall')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('installUser and uninstallUser refuse to run as root', () => {
  const realGetuid = process.getuid
  try {
    process.getuid = () => 0
    assert.throws(() => installUser({ home: tmpHome() }), /refusing to run as root/)
    assert.throws(() => uninstallUser({ home: tmpHome() }), /refusing to run as root/)
  } finally { process.getuid = realGetuid }
})

test('install → uninstall → install → uninstall stays clean', () => {
  const home = tmpHome()
  try {
    const file = path.join(home, '.claude', 'settings.json')
    for (let i = 0; i < 2; i++) {
      installUser({ home, envTargets: [{ file, key: 'NODE_EXTRA_CA_CERTS' }] })
      assert.ok(readInstall(home), 'install.json present after install')
      uninstallUser({ home })
      assert.equal(readInstall(home), null, 'install.json gone after uninstall')
      assert.ok(!fs.existsSync(file), 'env file (new) removed each round')
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
