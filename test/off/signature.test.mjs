// test/off/signature.test.mjs — src/off/signature.mjs (RFC 4.6 撤销顺序第 2 / 5 步, 1.6 R3): the process signatures a harness declares, kept in the
// install manifest as JSON (`liveness`) and matched again by `off` with no harness descriptor in sight. A signature that does not survive the
// JSON round trip, or a match that differs from the registry's, would make `off` call a live agent dead — so the two are held equal here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchPattern, serializeSignature, reviveSignature, matchHarness } from '../../src/off/signature.mjs'
import { createRegistry, matchPattern as registryMatchPattern } from '../../src/collector/core/registry.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

const harnesses = await loadHarnesses()
const SIGS = Object.fromEntries(harnesses.map((d) => [d.name, d.signatures.linux]))
const live = (names = Object.keys(SIGS)) => Object.fromEntries(names.map((n) => [n, { signature: JSON.parse(JSON.stringify(serializeSignature(SIGS[n]))) }]))
const proc = (exe, argv = [exe], env = null) => ({ exe, argv, env: env == null ? () => new Map() : () => new Map(Object.entries(env)) })

test('the registry matches with the function that moved to src/off/signature.mjs', () => {
  assert.equal(registryMatchPattern, matchPattern)
  assert.equal(matchPattern({ exe: /codex$/, argv: [/^app-server$/] }, { exe: '/x/codex', argv: ['codex', 'app-server'] }), true)
  assert.equal(matchPattern({ env: { A: '1' } }, { env: new Map([['A', '2']]) }), false)
})

test('a signature survives JSON: every RegExp comes back with its source and flags, and the revived one matches what the original does', () => {
  for (const d of harnesses) {
    const sig = d.signatures.linux
    const json = JSON.parse(JSON.stringify(serializeSignature(sig)))
    assert.doesNotMatch(JSON.stringify(json), /\{\}/, `${d.name}: no RegExp was flattened to {}`)
    const back = reviveSignature(json)
    const flat = (x) => JSON.stringify(x, (k, v) => (v instanceof RegExp ? `/${v.source}/${v.flags}` : v))
    assert.equal(flat(back), flat(sig), `${d.name}: the revived signature is the declared one`)
  }
  assert.deepEqual(reviveSignature(serializeSignature({ match: [{ 'argv.0': /^x$/i, env: { K: 'v', R: /r/ } }] })), { match: [{ 'argv.0': /^x$/i, env: { K: 'v', R: /r/ } }] })
})

test('matchHarness names the one harness whose match holds and whose exclude does not, from the snapshot alone, resolving a lazy env', () => {
  const l = live()
  const facts = [
    [proc('/x/claude/versions/2.1.289'), 'claude-code'],
    [proc('/x/claude/versions/2.1.289', ['rg']), null], // CC's own ripgrep: excluded
    [proc('/home/u/.local/bin/codex', ['codex']), 'codex'],
    [proc('/home/u/.local/bin/codex', ['codex-linux-sandbox', '--']), null], // an arg0 helper
    [proc('/opt/ZCode/zcode', ['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs', 'app-server', '--stdio'], { ELECTRON_RUN_AS_NODE: '1' }), 'z-code'],
    [proc('/opt/ZCode/zcode', ['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs', 'app-server', '--stdio']), null], // the same exe without ELECTRON_RUN_AS_NODE is the GUI's
    [proc('/home/u/.opencode/bin/opencode', ['opencode'], { BUN_BE_BUN: '1' }), null], // OpenCode's self-exec: an env exclude
    [proc('/home/u/.opencode/bin/opencode', ['opencode']), 'opencode'],
    [{ exe: '/usr/bin/bash', argv: ['bash'], env: null }, null],
    [{ exe: '/home/u/.opencode/bin/opencode', argv: ['opencode'], env: null }, 'opencode'], // an environment that cannot be read is not an exclusion
  ]
  for (const [f, want] of facts) assert.equal(matchHarness(l, f), want, `${f.exe} ${f.argv.slice(1).join(' ')}`)
  const reg = createRegistry(harnesses)
  for (const [f] of facts) {
    const env = f.env && f.env()
    assert.equal(matchHarness(l, f), reg.match({ os: 'linux', exe: f.exe, argv: f.argv, env: env || null }).agent, `the registry agrees on ${f.exe}`)
  }
})

test('two harnesses that both claim a process claim none of it, and a harness without a signature (another OS, a manifest from before) never matches', () => {
  const both = { a: { signature: serializeSignature({ match: [{ exe: /x$/ }] }) }, b: { signature: serializeSignature({ match: [{ argv: [/^go$/] }] }) } }
  assert.equal(matchHarness(both, proc('/bin/x', ['x', 'go'])), null)
  assert.equal(matchHarness(both, proc('/bin/x', ['x'])), 'a')
  assert.equal(matchHarness({ a: { signature: null }, b: {}, c: null }, proc('/bin/x')), null)
  assert.equal(matchHarness({}, proc('/bin/x')), null)
  assert.equal(matchHarness(undefined, proc('/bin/x')), null)
})
