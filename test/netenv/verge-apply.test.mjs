// verge-apply.test.mjs — what asight does to Verge's groups and what it reads back (RFC 4.8 §4.1 · §4.3 · §4.4, 4.7 §3.4; acceptance W11 W55 W56): verify() from the provider list, the strategies, the switch of a
// single harness's groups, Verge not running or its controller unreadable. The controller is a fake core (fixtures/fake-core.mjs, W57 holds it to the real mihomo); Verge's data directory is a sandbox.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startWorld, GROUPS } from './fixtures/verge-world.mjs'
import { names } from '../../src/netenv/mihomo/rules.mjs'

const CC = 'claude-code.cli'
const CODEX = 'codex.app'
const lines = (w, g) => w.block().files[names(g).routeFile].split('\n').filter(Boolean).length

// ---- W11: verify -------------------------------------------------------------------------------------------------------------------------------------------------------

test('W11 verify: on = the select is on the fallback group AND the provider has rules; the count comes from the list while the single-provider read is 405', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  const on = await w.adapter.verify(CC)
  assert.deepEqual(on, { live: true, now: names(CC).fb, fbNow: names(CC).in, ruleCount: lines(w, CC), reason: null })
  const off = await w.adapter.verify(CODEX)
  assert.deepEqual(off, { live: false, now: 'PASS', fbNow: names(CODEX).in, ruleCount: 0, reason: 'off' })
  assert.ok(!w.core.requests.some((r) => /^\/providers\/rules\/./.test(r.path)), 'the 405 read is never made')
})

test('W11 verify: off is the select on PASS or an empty provider (one key is enough); a block that is not in the runtime is off; on needs both', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  fs.writeFileSync(w.file(names(CC).routeFile), '') // the provider's file is emptied and re-read, the select left on the fallback group
  w.core.reloadProvider(names(CC).provider)
  assert.deepEqual(await w.adapter.verify(CC), { live: false, now: names(CC).fb, fbNow: names(CC).in, ruleCount: 0, reason: 'empty-provider' })
  w.core.select(names(CODEX).sw, names(CODEX).fb) // selected, but its provider is empty (the file was written empty): not on
  assert.equal((await w.adapter.verify(CODEX)).live, false)
  const bare = await startWorld(t)
  assert.deepEqual(await bare.adapter.verify(CC), { live: false, now: null, fbNow: null, ruleCount: null, reason: 'block-not-in-runtime' })
})

test('W11 verify: the fallback group on asight-re while the daemon is alive is fallback-active (on, but the engine does not answer mihomo); with the daemon not alive, or not said, it is not claimed', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  w.core.engineAlive = false
  w.core.healthCheck()
  const re = names(CC).re
  assert.deepEqual(await w.adapter.verify(CC, { daemonAlive: true }), { live: true, now: names(CC).fb, fbNow: re, ruleCount: lines(w, CC), reason: 'fallback-active' })
  assert.equal((await w.adapter.verify(CC, { daemonAlive: false })).reason, null)
  w.state.daemon = true
  assert.equal((await w.adapter.verify(CC)).reason, 'fallback-active', 'the adapter\'s own daemonAlive() is the default')
  w.state.daemon = undefined
  assert.equal((await w.adapter.verify(CC)).reason, null, 'a daemon state that is not known is not claimed')
})

test('W11 verify: what cannot be read is 「不知道」: live null with the reason, never a guess', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  w.core.failOn('GET', /^\/providers\/rules$/, 500)
  assert.deepEqual(await w.adapter.verify(CC), { live: null, now: names(CC).fb, fbNow: names(CC).in, ruleCount: null, reason: 'unreadable' }, 'on needs the count')
  assert.equal((await w.adapter.verify(CODEX)).live, false, 'PASS is off whatever the provider list says')
  w.core.failures.length = 0
  w.core.failOn('GET', /^\/proxies\/asight-sw-/, 500)
  assert.deepEqual(await w.adapter.verify(CC), { live: null, now: null, fbNow: null, ruleCount: null, reason: 'unreadable' })
  await w.core.stop()
  assert.deepEqual(await w.adapter.verify(CC), { live: null, now: null, fbNow: null, ruleCount: null, reason: 'controller-unreadable' })
})
