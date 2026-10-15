// test/collector/arch/win32/routing.test.mjs — the routing object `asight on` consumes in proxy mode (plan Task 8(c); the 1.6 §9.5 routing contract, 4.8 §2.1 · §2.3):
// the Windows arch's { ownsProxyField, fieldOf, adopt }, beside prepare in loadArch's win32 arm. On Windows both halves of the contract are the daemon's, done inside
// the very `on` request this follows — the kernel's upstream out of its own read of the same files (priorOf), the field through the same journal `off` undoes by —
// so this side's adopt is the VERIFIER of that write: a group whose entry is in the ledger must hold the kernel's address, or the on did not finish (V47: exit 1,
// the harness named, no adopted record). A group with no record is the user's own field as it was: nothing to verify. No second writer lives here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { win32Routing } from '../../../../src/collector/arch/win32/wiring.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { createProxyEntries } from '../../../../src/collector/arch/win32/entries.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { installCollector } from '../../../../src/collector/install.mjs'
import { readManifest } from '../../../../src/collector/core/trust/journal.mjs'
import { readTextOrError } from '../../../../src/collector/core/config-read.mjs'
import { seedClaude, ROOTS } from '../../../cli/fixtures/on-ctx.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const CC = ALL.find((d) => d.name === 'claude-code') // loadHarnesses attaches the win32 data (groups, entries) the routing and the writer plan by
const GROUPS = groupsOf(ALL)
const TOKEN = 'fedcba9876543210fedcba9876543210'
const PORT = 18802

/** A sandbox %USERPROFILE% with the collector installed (`on`'s own writer), the harness's own proxy in its settings, and the ingress.json the daemon made at its start. */
async function world({ proxy = 'http://user-proxy.example:3128' } = {}) {
  const home = tmpDir('asight-routing-')
  seedClaude(home, `${JSON.stringify({ model: 'x', env: { HTTPS_PROXY: proxy } }, null, 2)}\n`)
  await installCollector({ home, env: { HOME: home, USERPROFILE: home }, osName: 'win32', harnesses: [CC], freePort: async () => 47011, roots: ROOTS })
  const dir = path.join(home, '.asight', 'collector')
  fs.writeFileSync(path.join(dir, 'ingress.json'), JSON.stringify({ enginePort: 18900, groupPorts: { 'claude-code.settings': PORT }, ingressToken: '0123456789abcdef0123456789abcdef', listenerToken: TOKEN }))
  fs.writeFileSync(path.join(dir, 'control.json'), `${JSON.stringify({ path: '\\\\.\\pipe\\asight-0123456789abcdef', token: 'f'.repeat(64) })}\n`) // the started daemon's endpoint record (4.8 §7) — install.mjs's per-poll controlEndpointFor finds the daemon through it
  const ctx = { os: 'win32', home, env: new Map([['HOME', home], ['USERPROFILE', home]]), running: [], readTextOrError, readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir }
  const daemonWriter = createProxyEntries({ dir, home, groups: GROUPS, ctx, ingress: () => ({ groupPorts: { 'claude-code.settings': PORT }, listenerToken: TOKEN }), manifest: () => readManifest(dir), fs })
  const settings = path.join(home, '.claude', 'settings.json')
  return {
    home, dir, settings,
    routing: win32Routing({ harnesses: [CC], home, env: { HOME: home, USERPROFILE: home } }),
    writeEntry: () => daemonWriter.write([{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }]), // the daemon's part, done inside the on request
  }
}

test('the shape (1.6 §9.5): ownsProxyField is always true — proxy mode owns the entry — and fieldOf names the file and the key of the harness\'s own entry, or null where it has none in use', () => {
  const home = tmpDir('asight-routing-shape-')
  seedClaude(home)
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', '.env'), 'API_KEY=1\n')
  const routing = win32Routing({ harnesses: ALL, home, env: {} })
  assert.equal(routing.ownsProxyField('claude-code'), true, 'proxy mode always owns the entry')
  assert.equal(routing.ownsProxyField('kimi-code'), true, 'even a harness whose entries are not files: adopt sorts that out, this is the gate')
  const f = routing.fieldOf('claude-code')
  assert.deepEqual([path.basename(f.path), f.key], ['settings.json', 'env.HTTPS_PROXY'], 'the json-key entry: the file and the dotted key')
  assert.equal(path.basename(routing.fieldOf('codex').path), '.env', 'the dotenv entry names the .env the trust block is in (a home in use)')
  assert.equal(routing.fieldOf('codex').key, 'HTTPS_PROXY', 'and its variable')
  const noCodex = win32Routing({ harnesses: ALL, home: tmpDir('asight-routing-bare-'), env: {} })
  assert.equal(noCodex.fieldOf('codex'), null, 'no Codex home in use: no file to name')
  assert.equal(routing.fieldOf('kimi-code'), null, 'no group of kimi\'s has a file entry: nothing to name')
  assert.equal(routing.fieldOf('no-such-harness'), null)
})

test('adopt verifies what the daemon wrote: the ledger and the field agree → it resolves; the field was flipped back underneath → it rejects with the group named (no path: a user name may be in one); no record → the field is the user\'s own, and it resolves', async () => {
  const w = await world()
  await w.writeEntry()
  await w.routing.adopt('claude-code', null) // the ledger says the entry, the file holds the kernel's address: done
  fs.writeFileSync(w.settings, `${JSON.stringify({ model: 'x', env: { HTTPS_PROXY: 'http://user-proxy.example:3128' } }, null, 2)}\n`) // the write did not take
  await assert.rejects(w.routing.adopt('claude-code', null), (e) => {
    assert.match(e.message, /claude-code\.settings/, 'the group is named')
    assert.ok(!e.message.includes(w.home), 'no path: a user name may be in one (4.8 §2.2)')
    return true
  })
  const bare = await world() // asight wrote nothing (the group was not routed, or not on): the user's own setting is correct as it is
  await bare.routing.adopt('claude-code', null)
  assert.match(fs.readFileSync(bare.settings, 'utf8'), /user-proxy\.example/, 'and nothing was written by the verify')
})

test('what cannot be read is said, never a vacuous pass (D38): a manifest that is not there or does not parse, an ingress.json that is not, a group with no port', async () => {
  const w = await world()
  await w.writeEntry()
  fs.rmSync(path.join(w.dir, 'ingress.json'))
  await assert.rejects(w.routing.adopt('claude-code', null), /ingress\.json/)
  fs.writeFileSync(path.join(w.dir, 'ingress.json'), JSON.stringify({ enginePort: 18900, groupPorts: {}, ingressToken: '0123456789abcdef0123456789abcdef', listenerToken: TOKEN }))
  await assert.rejects(w.routing.adopt('claude-code', null), /no port for claude-code\.settings/, 'a group with no port: the kernel\'s address cannot be named')
  const w2 = await world()
  await w2.writeEntry()
  fs.writeFileSync(path.join(w2.dir, 'install-manifest.json'), '{not json')
  await assert.rejects(w2.routing.adopt('claude-code', null), /manifest could not be read/)
  const w3 = await world()
  await w3.writeEntry()
  fs.rmSync(path.join(w3.dir, 'install-manifest.json'))
  await assert.rejects(w3.routing.adopt('claude-code', null), /manifest is not there/, 'after a successful on the ledger exists: one that is gone cannot be verified')
})

