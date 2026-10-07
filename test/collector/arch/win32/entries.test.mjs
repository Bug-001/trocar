// test/collector/arch/win32/entries.test.mjs — the proxy entries' writer, undo and check (RFC 4.8 §2.1 · §2.3; W12's entry
// half, W19's combined case; plan Task 8(c)). The redirector decides WHEN (after the kernel's read-back); this is WHAT is
// written: `proxyEntries`' edits through the install journal (so `off` and the standalone can undo them by the same records),
// the dotenv lines of Codex and Hermes JOINING the sentinel block their trust entry wrote (`joinBlock`, the four W19
// conditions hold — win32-trust.test.mjs's GATE), and the user's proxy credentials reaching the manifest only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createProxyEntries } from '../../../../src/collector/arch/win32/entries.mjs'
import { groupsOf, proxyRecordsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { installCollector } from '../../../../src/collector/install.mjs'
import { readManifest } from '../../../../src/collector/core/trust/journal.mjs'
import { readText, readTextOrError } from '../../../../src/collector/core/config-read.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const one = (name) => ALL.find((d) => d.name === name)
const GROUPS = groupsOf(ALL)
const groupOf = (g) => GROUPS.find((x) => x.g === g)

/** A sandbox %USERPROFILE% with the harness's trust entries really installed (`on`'s own writer) — the state production has when the proxy entry is written. */
async function sandbox(names, rels = []) {
  const home = tmpDir('asight-entries-')
  for (const [rel, text = ''] of rels) { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const ds = names.map(one)
  await installCollector({ home, env: { HOME: home, USERPROFILE: home }, osName: 'win32', harnesses: ds, freePort: async () => 47011, roots: { node: [], osText: '' } })
  const dir = path.join(home, '.asight', 'collector')
  const ctx = { os: 'win32', home, env: new Map([['HOME', home], ['USERPROFILE', home]]), running: [], readText: (f) => readText(f), readTextOrError, readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir }
  const made = (over = {}) => createProxyEntries({
    dir, home, groups: GROUPS, ctx, ingress: () => ({ groupPorts: { 'codex.env': 18801, 'claude-code.settings': 18802, 'hermes.cli': 18803 }, listenerToken: 'fedcba9876543210fedcba9876543210' }),
    manifest: () => readManifest(dir), ...over,
  })
  return { home, dir, ctx, made }
}
const sha = (f) => fs.readFileSync(f)
const harnessOf = (g) => groupOf(g).harness

test('write puts each group\'s proxy entry through the journal: the file, the record, prior_value; a second write changes nothing (idempotent, W12)', async () => {
  const b = await sandbox(['claude-code'])
  const f = path.join(b.home, '.claude', 'settings.json')
  fs.writeFileSync(f, JSON.stringify({ env: { HTTPS_PROXY: 'http://user-proxy.example:3128' }, other: true }, null, 2))
  const e = b.made()
  const before = sha(f)
  assert.deepEqual(e.write([{ g: 'claude-code.settings', harness: harnessOf('claude-code.settings'), entry: 'auto' }]), [{ g: 'claude-code.settings', ok: true }])
  const rec = proxyRecordsOf(readManifest(b.dir), groupOf('claude-code.settings').group, 'claude-code')
  assert.equal(rec.length, 1, 'one record of the proxy entry')
  assert.equal(rec[0].prior_value, 'http://user-proxy.example:3128', 'the user\'s proxy is the record\'s prior_value')
  const after = sha(f)
  assert.notDeepEqual(after, before)
  assert.deepEqual(e.write([{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }]), [{ g: 'claude-code.settings', ok: true }])
  assert.deepEqual(sha(f), after, 'the second write is a no-op (skip-intact): the entry the agents read never moves under them')
  assert.match(after.toString(), /18802/)
})

test('Codex and Hermes: the proxy lines JOIN the sentinel block the trust entry wrote — one block, both halves (W19\'s combined case, the gate 8(c) passes)', async () => {
  for (const [harness, g, file, varName] of [['codex', 'codex.env', path.join('.codex', '.env'), 'HTTPS_PROXY'], ['hermes', 'hermes.cli', path.join('AppData', 'Local', 'hermes', '.env'), 'HTTPS_PROXY']]) {
    const b = await sandbox([harness], harness === 'codex' ? [[path.join('.codex', '.env'), 'API_KEY=1\n']] : [[path.join('AppData', 'Local', 'hermes', '.env'), 'X=1\n']])
    const f = path.join(b.home, file)
    const e = b.made()
    assert.deepEqual(e.write([{ g, harness, entry: 'auto' }]), [{ g, ok: true }])
    const text = fs.readFileSync(f, 'utf8')
    const begins = [...text.matchAll(/^# >>> asight/gm)].length
    assert.equal(begins, 1, `${harness}: one sentinel block, not two`)
    assert.match(text, new RegExp(`^${varName}=http://`, 'm'), `${harness}: the proxy line is in the file`)
    assert.match(text, /SSL_CERT_FILE=/, `${harness}: the trust line is in the same block`)
    // and undo takes the PROXY lines out only (the trust half is `off`'s to take): the block keeps its trust line, byte for byte as before the write
    const rec = proxyRecordsOf(readManifest(b.dir), groupOf(g).group, harness)
    assert.equal(rec.length, 1)
    const withTrust = fs.readFileSync(f, 'utf8').replace(new RegExp(`^${varName}=.*$\n^NO_PROXY=.*$\n`, 'm'), '')
    assert.deepEqual(e.undo([{ g, harness, entry: null }]), [{ g, ok: true }])
    assert.equal(fs.readFileSync(f, 'utf8'), withTrust, `${harness}: undo leaves the block's trust half exactly as it was`)
  }
})

test('undo restores a group the user\'s own proxy was put out of effect for, byte for byte, and only asight\'s value goes when the user edited around it', async () => {
  const b = await sandbox(['claude-code'], [['/.claude/settings.json', '{"env":{"HTTPS_PROXY":"http://u:p@relay.example:8080"},"keep":1}\n']])
  const f = path.join(b.home, '.claude', 'settings.json')
  const was = fs.readFileSync(f, 'utf8')
  const e = b.made()
  e.write([{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }])
  // the user edits around asight's key while it is in effect
  const edited = fs.readFileSync(f, 'utf8').replace('"keep":1', '"keep":2')
  fs.writeFileSync(f, edited)
  const r = e.undo([{ g: 'claude-code.settings', harness: 'claude-code', entry: null }])
  assert.deepEqual(r, [{ g: 'claude-code.settings', ok: true }])
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { env: { NODE_EXTRA_CA_CERTS: JSON.parse(edited).env.NODE_EXTRA_CA_CERTS, HTTPS_PROXY: 'http://u:p@relay.example:8080' }, keep: 2 }, 'the user\'s value is back, their own edit kept')
  // and the byte round trip when they did not touch it
  const withUserValue = fs.readFileSync(f, 'utf8')
  e.write([{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }])
  e.undo([{ g: 'claude-code.settings', harness: 'claude-code', entry: null }])
  assert.equal(fs.readFileSync(f, 'utf8'), withUserValue, 'byte for byte')
})

test('the user\'s proxy credentials reach the manifest and nothing else: no result, note or error of write or undo carries them', async () => {
  const secret = 's3cret-Pa55word'
  const b = await sandbox(['codex'], [[path.join('.codex', '.env'), `HTTPS_PROXY=http://alice:${secret}@relay.internal:8080\n`]])
  const f = path.join(b.home, '.codex', '.env')
  const e = b.made()
  const results = [e.write([{ g: 'codex.env', harness: 'codex', entry: 'auto' }]), e.undo([{ g: 'codex.env', harness: 'codex', entry: null }]), e.check([{ g: 'codex.env', harness: 'codex', entry: 'auto' }])]
  const seen = JSON.stringify(results)
  const m = readManifest(b.dir)
  const rec = proxyRecordsOf(m, groupOf('codex.env').group, 'codex')
  assert.ok(rec.length >= 1 && rec[0].prior_value && rec[0].prior_value.HTTPS_PROXY.includes(secret), 'the manifest holds the prior value with the credentials (0600, the only place)')
  assert.equal(fs.statSync(path.join(b.dir, 'install-manifest.json')).mode & 0o777, 0o600)
  assert.ok(!seen.includes(secret), 'no result of write, undo or check carries them (the file after undo holds the user\'s own line again, and the manifest holds the prior value)')
})

test('undo of a group asight never wrote is ok (nothing to take out); check says which files hold the group\'s address and which do not', async () => {
  const b = await sandbox(['claude-code'])
  const e = b.made()
  assert.deepEqual(e.undo([{ g: 'claude-code.settings', harness: 'claude-code', entry: null }]), [{ g: 'claude-code.settings', ok: true }])
  assert.deepEqual(e.check([{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }]), [{ g: 'claude-code.settings', ok: false }], 'not written: not in effect')
  e.write([{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }])
  assert.deepEqual(e.check([{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }]), [{ g: 'claude-code.settings', ok: true }])
  const f = path.join(b.home, '.claude', 'settings.json')
  fs.writeFileSync(f, JSON.stringify({ env: { HTTPS_PROXY: 'http://elsewhere:1' } }))
  assert.deepEqual(e.check([{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }]), [{ g: 'claude-code.settings', ok: false }])
  // an entry kind that is not a file (an opt-in policy value, Task 14's) has nothing here
  assert.deepEqual(e.write([{ g: 'claude-code.desktop', harness: 'claude-code', entry: 'opt-in' }]), [{ g: 'claude-code.desktop', ok: true }])
  assert.deepEqual(e.undo([{ g: 'claude-code.desktop', harness: 'claude-code', entry: null }]), [{ g: 'claude-code.desktop', ok: true }])
})

test('a write that the journal refuses (a file asight\'s text is in from an install the manifest does not list) is that group\'s ok:false, not an exception', async () => {
  const b = await sandbox(['codex'], [[path.join('.codex', '.env'), 'API_KEY=1\n']])
  const f = path.join(b.home, '.codex', '.env')
  fs.rmSync(path.join(b.dir, 'install-manifest.json')) // the manifest that listed the trust block is gone: the file holds a block no manifest lists
  fs.writeFileSync(path.join(b.dir, 'install-manifest.json'), JSON.stringify({ version: 2, entries: [], files: [], dirs: [], complete: true }))
  const e = b.made()
  const r = e.write([{ g: 'codex.env', harness: 'codex', entry: 'auto' }])
  assert.equal(r.length, 1)
  assert.equal(r[0].g, 'codex.env')
  assert.equal(r[0].ok, false)
  assert.match(r[0].reason, /already holds asight/)
})

test('proxyRecordsOf finds the proxy entry\'s records by harness and entry, never the trust entry\'s, and both slash styles', () => {
  const g = groupOf('codex.env').group
  const m = { entries: [
    { harness: 'codex', kind: 'text', format: 'dotenv-block', path: String.raw`C:\u\.codex\.env`, vars: { SSL_CERT_FILE: 'x' }, prior_value: null },
    { harness: 'codex', kind: 'text', format: 'dotenv-block', path: 'C:/u/.codex/.env', vars: { HTTPS_PROXY: 'http://a', NO_PROXY: 'x' }, prior_value: { HTTPS_PROXY: 'http://user' } },
    { harness: 'codex', kind: 'json-key', path: 'C:/u/.codex/.env', keys: ['env', 'HTTPS_PROXY'] },
    { harness: 'claude-code', kind: 'json-key', path: 'C:/u/.claude/settings.json', keys: ['env', 'HTTPS_PROXY'], prior_value: 'http://b' },
  ] }
  const got = proxyRecordsOf(m, g, 'codex')
  assert.equal(got.length, 1)
  assert.equal(got[0].prior_value.HTTPS_PROXY, 'http://user')
  const cc = proxyRecordsOf(m, groupOf('claude-code.settings').group, 'claude-code')
  assert.equal(cc.length, 1, 'the json-key record of the claude-code group is found by its keys')
  assert.deepEqual(proxyRecordsOf(m, groupOf('hermes.cli').group, 'hermes'), [], 'a group of another harness has none')
})
