// test/collector/core/registry.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry, matchPattern, validateDescriptor } from '../../../src/collector/core/registry.mjs'

const trust = { chain: [{ var: 'X_CA', semantic: 'append' }] }
const alpha = {
  name: 'alpha', runtime: 'node', hosts: ['api.alpha.test'], trust,
  signatures: { linux: {
    match: [{ exe: /\/alpha\/versions\/[^/]+( \(deleted\))?$/ }],
    exclude: [{ 'argv.0': /(^|\/)rg$/ }],
    longLived: [{ argv: [/--daemon$/] }],
  } },
}
const beta = {
  name: 'beta', runtime: 'node', hosts: [], trust,
  signatures: { linux: { match: [{ exe: /\/electron$/, argv: [/\/beta\.cjs$/], env: { RUN_AS_NODE: '1' } }] } },
}
const facts = (o) => ({ os: 'linux', pid: 10, ppid: 1, uid: 1000, exe: null, argv: [], env: new Map(), cwd: '/', source: 'exec', ...o })

test('registry: matches by exe on the facts OS and names the agent', () => {
  const r = createRegistry([alpha, beta])
  const m = r.match(facts({ exe: '/home/u/.local/share/alpha/versions/2.1.0 (deleted)', argv: ['alpha'] }))
  assert.equal(m.agent, 'alpha'); assert.equal(m.reason, 'match'); assert.equal(m.descriptor, alpha)
})

// Review B-1 (4.6 exe-unreadable): which descriptors COULD claim a process whose exe cannot be read. Only a pattern with a
// condition on a readable fact (argv, comm) names a harness; a harness known by its exe alone proves nothing.
test('registry: couldMatch judges an unreadable-exe process on its readable facts only — a pattern of exe alone names nobody, an argv condition that holds does, an exclusion still excludes', () => {
  const gamma = { name: 'gamma', runtime: 'node', hosts: [], trust,
    signatures: { linux: { match: [{ exe: /\/node$/, 'argv.1': /\/gamma\.js$/ }, { exe: /\/node$/, 'argv.1': /^-/, 'argv.2': /\/gamma\.js$/ }], exclude: [{ argv: [/^__plugin$/] }] } } }
  const r = createRegistry([alpha, beta, gamma])
  const could = (argv) => r.couldMatch(facts({ exe: null, env: null, argv }))
  assert.deepEqual(could(['/usr/bin/node', '/opt/gamma.js']), ['gamma'], 'argv.1 fits; the exe (unknown) is not tested')
  assert.deepEqual(could(['node', '--x', '/opt/gamma.js']), ['gamma'], 'the second pattern')
  assert.deepEqual(could(['/usr/bin/node', '/opt/gamma.js', '__plugin']), [], 'an exclusion that holds on the readable facts excludes it')
  assert.deepEqual(could(['sshd: u@notty']), [], 'a session process fits nothing')
  assert.deepEqual(could(['/home/u/.local/share/alpha/versions/2.1.0']), [], 'alpha is known by its exe alone (and an excluded argv0 pattern with no match): the command line proves nothing, so it is not named')
  assert.deepEqual(could(['/opt/electron', '/opt/beta.cjs']), ['beta'], 'beta: argv holds, exe and env unknown')
  assert.deepEqual(r.couldMatch({ os: 'darwin', exe: null, argv: ['/usr/bin/node', '/opt/gamma.js'] }), [], 'no signature for that OS')
  assert.deepEqual(could([]), [], 'no readable command line: nothing to judge on')
})

test('registry: an exclusion beats a match (same exe, helper argv0)', () => {
  const m = createRegistry([alpha]).match(facts({ exe: '/x/alpha/versions/2.1.0', argv: ['/tmp/rg', '--files'] }))
  assert.deepEqual([m.agent, m.reason], [null, 'excluded'])
})

test('registry: env is read only when a pattern needs it, and is then required', () => {
  let reads = 0
  const lazy = (env) => { const f = facts({ exe: '/opt/beta/electron', argv: ['/opt/beta/electron', '/opt/beta/beta.cjs'] }); Object.defineProperty(f, 'env', { get() { reads++; return env } }); return f }
  const r = createRegistry([alpha, beta])
  assert.equal(r.match(lazy(new Map())).agent, null)
  assert.equal(r.match(lazy(new Map([['RUN_AS_NODE', '1']]))).agent, 'beta')
  const before = reads
  r.match(facts({ exe: '/bin/ls', argv: ['ls'] }))      // exe fails first: env never touched
  assert.equal(reads, before)
})

test('registry: two matching descriptors are ambiguous, never folded into one', () => {
  const twin = { ...alpha, name: 'alpha-twin' }
  const m = createRegistry([alpha, twin]).match(facts({ exe: '/x/alpha/versions/1' }))
  assert.equal(m.agent, null); assert.equal(m.reason, 'ambiguous'); assert.deepEqual(m.candidates, ['alpha', 'alpha-twin'])
})

test('registry: a descriptor without signatures for this OS never matches', () => {
  const m = createRegistry([alpha]).match(facts({ os: 'darwin', exe: '/x/alpha/versions/1' }))
  assert.deepEqual([m.agent, m.reason], [null, 'no-match'])
})

test('registry: longLived patterns are reported per process', () => {
  const r = createRegistry([alpha])
  assert.equal(r.isLongLived(alpha, facts({ exe: '/x/alpha/versions/1', argv: ['alpha', '--daemon'] })), true)
  assert.equal(r.isLongLived(alpha, facts({ exe: '/x/alpha/versions/1', argv: ['alpha'] })), false)
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
  assert.throws(() => validateDescriptor({ ...alpha, signatures: {} }), /signatures/)
  assert.throws(() => validateDescriptor({ ...alpha, signatures: { linux: { match: [{}] } } }), /pattern/)
  assert.throws(() => validateDescriptor({ ...alpha, signatures: { linux: { match: [{ exe: /x/g }] } } }), /stateful/)
  assert.throws(() => validateDescriptor({ ...alpha, trust: { chain: [] } }), /trust\.chain/)
  assert.throws(() => createRegistry([alpha, alpha]), /twice/)
})
