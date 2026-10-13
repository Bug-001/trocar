// test/collector/core/registry.test.mjs — the registry judges a process by the D51 name list (RFC 4.6 「按名单认」, plan 2026-10-14 §2.3): one row
// per reason of the table (match · excluded · pending · args-mismatch · no-match · ambiguous), the user's list merged and swapped in place,
// couldMatch on the readable facts, longLived, the lazy env, the descriptor checks, and the liveness snapshot. Descriptors here are made up: the
// seven presets are test/collector/core/identity-presets.test.mjs's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry, matchPattern, validateDescriptor, livenessOf } from '../../../src/collector/core/registry.mjs'
import { reviveSignature, matchHarness } from '../../../src/off/signature.mjs'

const trust = { chain: [{ var: 'X_CA', semantic: 'append' }] }
const alpha = {
  name: 'alpha', runtime: 'node', hosts: ['api.alpha.test'], trust,
  processes: { names: [{ name: 'alpha' }], exclude: [{ name0: 'rg' }], longLived: [{ args: '(^| )--daemon( |$)' }] },
}
const beta = {
  name: 'beta', runtime: 'node', hosts: [], trust,
  processes: { names: [{ name: 'node', args: '/beta\\.cjs( |$)' }], exclude: [{ name: 'node', env: { BETA_HELPER: '1' } }] },
}
const facts = (o) => ({ os: 'linux', pid: 10, ppid: 1, uid: 1000, exe: null, argv: [], env: new Map(), cwd: '/', source: 'exec', ...o })
const said = (m) => [m.agent, m.reason, m.harness ?? m.candidates ?? null]

test('registry, the reason table: each row of 4.6 「按名单认」 once', () => {
  const r = createRegistry([alpha, beta])
  const rows = [
    ['match', facts({ exe: '/home/u/.local/share/alpha/versions/2.1.0 (deleted)', argv: ['alpha'] }), ['alpha', 'match', null]],
    ['excluded (names its harness)', facts({ exe: '/x/alpha', argv: ['rg', '--files'] }), [null, 'excluded', 'alpha']],
    ['excluded by an env item', facts({ exe: '/usr/bin/node', argv: ['node', '/opt/beta.cjs'], env: new Map([['BETA_HELPER', '1']]) }), [null, 'excluded', 'beta']],
    ['pending (win32 command line not known yet)', { os: 'win32', exe: 'C:\\n\\node.exe', argv: [], env: null, cmdlineState: 'pending' }, [null, 'pending', null]],
    ['args-mismatch', facts({ exe: '/usr/bin/node', argv: ['node', '/opt/other.js'] }), [null, 'args-mismatch', null]],
    ['no-match', facts({ exe: '/bin/ls', argv: ['ls'] }), [null, 'no-match', null]],
  ]
  for (const [why, f, want] of rows) assert.deepEqual(said(r.match(f)), want, why)
  const twin = { ...alpha, name: 'alpha-twin' }
  assert.deepEqual(said(createRegistry([alpha, twin]).match(facts({ exe: '/x/alpha', argv: ['alpha'] }))), [null, 'ambiguous', ['alpha', 'alpha-twin']], 'ambiguous: never folded into one')
  assert.equal(r.match(facts({ exe: '/x/alpha', argv: ['alpha'] })).descriptor, alpha, 'a match carries its descriptor')
  assert.deepEqual(said(r.match({ os: 'darwin', exe: '/x/alpha', argv: ['/x/alpha'], env: null })), ['alpha', 'match', null], 'the same list on every OS')
})

test('registry: env is read only once a name of a harness with an env item hit; an unreadable env (null) excludes nothing', () => {
  let reads = 0
  const lazy = (argv, env) => { const f = facts({ exe: argv[0] === 'node' ? '/usr/bin/node' : `/bin/${argv[0]}`, argv }); Object.defineProperty(f, 'env', { get() { reads++; return env } }); return f }
  const r = createRegistry([alpha, beta])
  r.match(lazy(['ls'], new Map())) // no name of beta: env untouched
  assert.equal(reads, 0)
  assert.equal(r.match(lazy(['node', '/opt/beta.cjs'], new Map())).agent, 'beta')
  assert.ok(reads > 0)
  assert.equal(r.match(facts({ exe: '/usr/bin/node', argv: ['node', '/opt/beta.cjs'], env: null })).agent, 'beta')
})

test('registry: an env item with null asks for the key to be absent — on an OS that reads the environment only', () => {
  const gui = { ...alpha, name: 'gui', processes: { names: [{ name: 'gui' }], exclude: [{ name: 'gui', env: { AS_NODE: null } }] } }
  const r = createRegistry([gui])
  assert.deepEqual(said(r.match(facts({ exe: '/opt/gui', argv: ['gui'] }))), [null, 'excluded', 'gui'])
  assert.equal(r.match(facts({ exe: '/opt/gui', argv: ['gui'], env: new Map([['AS_NODE', '1']]) })).agent, 'gui')
  assert.equal(r.match({ os: 'darwin', exe: '/opt/gui', argv: ['gui'], env: null }).agent, 'gui', 'env null is not "absent"')
})

test('registry: the user\'s list — a custom name joins its harness, ignore drops a name (and the exclude items naming it), replaceAgentList swaps in place', () => {
  const r = createRegistry([alpha, beta], { agentList: [{ harness: 'alpha', name: 'alpha-nightly' }, { harness: 'nobody', name: 'x' }] })
  const { match } = r
  assert.equal(match(facts({ exe: '/opt/alpha-nightly', argv: ['alpha-nightly'] })).agent, 'alpha')
  r.replaceAgentList([{ harness: 'beta', name: 'node', ignore: true }])
  assert.deepEqual(said(match(facts({ exe: '/usr/bin/node', argv: ['node', '/opt/beta.cjs'] }))), [null, 'no-match', null], 'beta\'s only name is gone; its env item went with it')
  assert.equal(match(facts({ exe: '/opt/alpha-nightly', argv: ['alpha-nightly'] })).agent, null, 'the earlier custom item is gone')
  r.replaceAgentList([])
  assert.equal(match(facts({ exe: '/usr/bin/node', argv: ['node', '/opt/beta.cjs'] })).agent, 'beta')
})

// Review B-1 (4.6 exe-unreadable): which harnesses COULD claim a process whose exe and env cannot be read — the name from argv[0] alone.
test('registry: couldMatch judges an unreadable-exe process on argv only — argv[0] gives the name, the rest the args; an exclude on readable facts still excludes', () => {
  const r = createRegistry([alpha, beta])
  const could = (argv) => r.couldMatch({ os: 'linux', exe: null, env: null, argv, comm: 'x' })
  assert.deepEqual(could(['/usr/bin/node', '/opt/beta.cjs']), ['beta'], 'beta\'s env item cannot hold on an unreadable env')
  assert.deepEqual(could(['node', '/opt/other.js']), [], 'args that do not hold')
  assert.deepEqual(could(['/x/alpha']), ['alpha'])
  assert.deepEqual(could(['rg']), [], 'no name')
  assert.deepEqual(could(['sshd: u@notty']), [])
  assert.deepEqual(could([]), [], 'no readable command line: nothing to judge on')
  const helper = { ...alpha, name: 'helped', processes: { names: [{ name: 'helped' }], exclude: [{ name: 'helped', args: '^--helper' }] } }
  assert.deepEqual(createRegistry([helper]).couldMatch({ os: 'linux', exe: null, env: null, argv: ['helped', '--helper'] }), [])
})

test('registry: longLived reads the args of a process of that harness', () => {
  const r = createRegistry([alpha])
  assert.equal(r.isLongLived(alpha, facts({ exe: '/x/alpha', argv: ['alpha', '--daemon'] })), true)
  assert.equal(r.isLongLived(alpha, facts({ exe: '/x/alpha', argv: ['alpha'] })), false)
})

test('registry: matchPattern supports positional argv and every-of argv lists', () => {
  const f = facts({ argv: ['node', '/usr/lib/x/dist/main.mjs', '--json'] })
  assert.equal(matchPattern({ 'argv.1': /\/dist\/main\.mjs$/ }, f), true)
  assert.equal(matchPattern({ argv: [/main\.mjs$/, /^--json$/] }, f), true)
  assert.equal(matchPattern({ argv: [/main\.mjs$/, /^--yaml$/] }, f), false)
})

test('registry: rejects malformed descriptors', () => {
  assert.throws(() => validateDescriptor({ ...alpha, name: 'Alpha' }), /kebab-case/)
  assert.throws(() => validateDescriptor({ ...alpha, runtime: 'go' }), /runtime/)
  assert.throws(() => validateDescriptor({ ...alpha, processes: { names: [] } }), /processes\.names/)
  assert.throws(() => validateDescriptor({ ...alpha, processes: undefined }), /processes\.names/)
  assert.throws(() => validateDescriptor({ ...alpha, processes: { names: [{ name: 'node' }] } }), /interpreter name/)
  assert.throws(() => validateDescriptor({ ...alpha, processes: { names: [{ name: 'a', args: /x/g }] } }), /stateful/)
  assert.throws(() => validateDescriptor({ ...alpha, processes: { names: [{ name: 'a' }], exclude: [{ name: 'b' }] } }), /not one of the names/)
  assert.throws(() => validateDescriptor({ ...alpha, trust: { chain: [] } }), /trust\.chain/)
  assert.throws(() => createRegistry([alpha, alpha]), /twice/)
})

test('livenessOf: the compiled name list as JSON (off matches the same processes from the manifest alone); an arch signature still wins while it exists', () => {
  const l = livenessOf(alpha, 'linux')
  assert.deepEqual([l.rereads, l.until], [false, 'restart'])
  const live = { alpha: JSON.parse(JSON.stringify(l)) }
  assert.equal(matchHarness(live, facts({ exe: '/x/alpha', argv: ['alpha'] })), 'alpha')
  assert.equal(matchHarness(live, facts({ exe: '/x/alpha', argv: ['rg'] })), null, 'its exclude survives')
  assert.ok(reviveSignature(l.signature).match.length > 0)
  assert.equal(livenessOf(alpha, 'darwin', () => ({ match: [{ exe: /x/ }] })).signature.match[0].exe.re, 'x')
})
