// test/collector/harness/claude-code.test.mjs — R1 (signature), T12 (CC settings layers), T10 (CC injection plan).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import cc from '../../../src/collector/harness/claude-code.mjs'
import { sandbox, ctxFor, facts, judge, matchOf, CA, OTHER } from './_ctx.mjs'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'

test('claude-code: the versioned binary (also "(deleted)" after an update) and bg workers match; rg / apply-seccomp do not', () => {
  const exe = '/home/u/.local/share/claude/versions/2.1.289'
  assert.equal(matchOf([cc], facts({ exe, argv: ['claude', '-p', 'hi'] })).agent, 'claude-code')
  assert.equal(matchOf([cc], facts({ exe: exe + ' (deleted)', argv: ['claude'] })).agent, 'claude-code')
  assert.equal(matchOf([cc], facts({ exe, argv: ['claude', '--daemon-worker', 'x'] })).agent, 'claude-code')
  assert.equal(matchOf([cc], facts({ exe, argv: ['rg', '--files'] })).reason, 'excluded')
  assert.equal(matchOf([cc], facts({ exe, argv: ['apply-seccomp', 'x'] })).reason, 'excluded')
  assert.equal(matchOf([cc], facts({ exe: '/usr/bin/node', argv: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'] })).agent, null)
})

test('claude-code: settings env applies over the launch env; project/managed scopes override user (T12)', () => {
  const s = sandbox()
  try {
    const pem = s.put('ca/trocar.pem', CA.certPem); const foreign = s.put('ca/other.pem', OTHER.certPem)
    s.put('.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: pem, ANTHROPIC_BASE_URL: 'https://relay.example.com/anthropic' } }))
    const a = judge(cc, ctxFor({ home: s.home, env: { NODE_EXTRA_CA_CERTS: foreign } }))
    assert.deepEqual([a.trust.trusted, a.trust.via.startsWith('user settings env')], [true, true])
    assert.ok(a.layers.every((l) => l.live === false), 'policy (4.6 CC row, OPEN ④): a settings layer is never live')
    assert.ok(a.hosts.includes('relay.example.com'))
    const proj = path.join(s.home, 'repo'); s.put('repo/.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: foreign } }))
    const b = judge(cc, ctxFor({ home: s.home, cwd: proj }))
    assert.deepEqual([b.trust.trusted, b.trust.reason], [false, 'ca-not-in-file'])
  } finally { s.done() }
})

test('claude-code: a settings CA written after the process started is config-after-start, never trusted (coordinator 2026-10-06)', () => {
  const s = sandbox()
  try {
    const pem = s.put('ca/trocar.pem', CA.certPem)
    const file = s.put('.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: pem } }))
    const mtime = fs.statSync(file).mtimeMs
    const after = judge(cc, ctxFor({ home: s.home, startedAt: mtime - 60_000 }))
    assert.deepEqual([after.trust.trusted, after.trust.reason, after.trust.via.startsWith('user settings env')], [false, 'config-after-start', true])
    assert.equal(judge(cc, ctxFor({ home: s.home, startedAt: mtime + 1 })).trust.trusted, true, 'a process started after the edit is trusted')
    const unknown = judge(cc, ctxFor({ home: s.home, startedAt: null })).trust
    assert.deepEqual([unknown.trusted, unknown.reason], [false, 'start-time-unknown'], 'an unknown start time is not trusted (review 2 #5)')
    assert.equal(judge(cc, ctxFor({ home: s.home })).layers[0].file, file, 'a layer names its file, so the daemon can match it to the install manifest')
    assert.ok(cc.trust.hints['config-after-start'] && cc.trust.hints['start-time-unknown'], 'both say what to do: restart it')
  } finally { s.done() }
})

test('claude-code: launched with NODE_EXTRA_CA_CERTS = the trocar CA but a user settings file naming another CA — untrusted when the start time is unknown or the file changed after start (post-integration 1)', () => {
  const s = sandbox()
  try {
    const pem = s.put('ca/trocar.pem', CA.certPem); const foreign = s.put('ca/other.pem', OTHER.certPem)
    const file = s.put('.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: foreign } }))
    const mtime = fs.statSync(file).mtimeMs
    const unknown = judge(cc, ctxFor({ home: s.home, env: { NODE_EXTRA_CA_CERTS: pem }, startedAt: null })).trust
    assert.deepEqual([unknown.trusted, unknown.reason, unknown.via.startsWith('user settings env')], [false, 'start-time-unknown', true])
    const after = judge(cc, ctxFor({ home: s.home, env: { NODE_EXTRA_CA_CERTS: pem }, startedAt: mtime - 60_000 })).trust
    assert.deepEqual([after.trusted, after.reason], [false, 'config-after-start'])
    assert.equal(judge(cc, ctxFor({ home: s.home, env: { NODE_EXTRA_CA_CERTS: pem }, startedAt: mtime + 1 })).trust.trusted, false, 'there at start: settings win, other CA')
  } finally { s.done() }
})

test('claude-code: host-managed, --restricted and --setting-sources without user drop the settings CA (T12)', () => {
  const s = sandbox()
  try {
    const pem = s.put('ca/trocar.pem', CA.certPem)
    s.put('.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: pem, ANTHROPIC_BASE_URL: 'https://relay.example.com' } }))
    const managed = judge(cc, ctxFor({ home: s.home, env: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' } }))
    assert.deepEqual([managed.trust.trusted, managed.trust.reason], [false, 'settings-ignored-managed-by-host'])
    assert.ok(managed.hosts.includes('relay.example.com'), 'base URL from settings still applies under host management')
    assert.equal(judge(cc, ctxFor({ home: s.home, argv: ['claude', '--restricted'] })).trust.reason, 'settings-ignored-restricted')
    assert.equal(judge(cc, ctxFor({ home: s.home, argv: ['claude', '--setting-sources', 'project,local'] })).trust.reason, 'settings-ignored-setting-sources')
    // CLAUDE_CONFIG_DIR moves the user scope away from ~/.claude (run outside $HOME so no project file applies)
    assert.equal(judge(cc, ctxFor({ home: s.home, cwd: path.join(s.home, 'elsewhere'), env: { CLAUDE_CONFIG_DIR: path.join(s.home, 'nowhere') } })).trust.reason, 'var-missing')
  } finally { s.done() }
})

// T10, CC half: the plan writes exactly CC's one entry; extra-cc.pem when the user already relies on a value.
const injectCtx = (s, { env = {}, running = [] } = {}) => ({ ...ctxFor({ home: s.home, env }), running: running.map((e) => new Map(Object.entries(e))), collectorDir: path.join(s.home, '.trocar', 'collector'), caPem: path.join(s.home, '.trocar', 'collector', 'ca', 'trocar-ca.pem') })

test('claude-code: a settings file that does not parse or cannot be read is a broken layer — named as the reason when untrusted, never read as "no settings" (D-9)', () => {
  const s = sandbox()
  try {
    const pem = s.put('ca/trocar.pem', CA.certPem)
    const user = s.put('.claude/settings.json', '{ "env": { "NODE_EXTRA_CA_CERTS": "' + pem + '", } oops')
    const a = judge(cc, ctxFor({ home: s.home }))
    assert.deepEqual([a.trust.trusted, a.trust.reason, a.trust.via], [false, 'settings-unparsable', `user settings env (${user})`])
    const l = a.layers.find((x) => x.broken)
    assert.deepEqual([l.file, l.ignored, typeof l.error], [user, 'settings-unparsable', 'string'])
    fs.writeFileSync(user, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: pem } }))
    const unread = judge(cc, { ...ctxFor({ home: s.home }), readTextOrError: (f) => (f === user ? { text: null, error: { code: 'EACCES', message: 'permission denied' } } : { text: null, error: null }) })
    assert.deepEqual([unread.trust.trusted, unread.trust.reason], [false, 'settings-unreadable'])
    assert.match(unread.layers[0].error, /^EACCES: permission denied$/)
    // a broken project file does not take away trust the user settings give
    const proj = path.join(s.home, 'repo'); s.put('repo/.claude/settings.json', '{ nope')
    const b = judge(cc, ctxFor({ home: s.home, cwd: proj }))
    assert.deepEqual([b.trust.trusted, b.trust.reason, b.layers.filter((x) => x.broken).length], [true, 'ok', 1])
    assert.ok(cc.trust.hints['settings-unparsable'] && cc.trust.hints['settings-unreadable'])
  } finally { s.done() }
})

test('claude-code inject: a ~/.claude.json that cannot be read is a note, not "no value to carry over" (D-9)', () => {
  const s = sandbox()
  try {
    s.put('.claude.json', '{ "env": ')
    const plan = planTrust({ descriptors: [cc], ctxFor: () => injectCtx(s), caCertPem: CA.certPem, collectorDir: path.join(s.home, '.trocar', 'collector') })
    assert.ok(plan.notes.some((n) => n.includes(path.join(s.home, '.claude.json')) && /does not parse .*NODE_EXTRA_CA_CERTS in it is not carried over/.test(n)), JSON.stringify(plan.notes))
  } finally { s.done() }
})

test('claude-code inject: no existing value → settings env.NODE_EXTRA_CA_CERTS = trocar-ca.pem; $CLAUDE_CONFIG_DIR moves the file', () => {
  const s = sandbox()
  try {
    const plan = planTrust({ descriptors: [cc], ctxFor: () => injectCtx(s), caCertPem: CA.certPem, collectorDir: path.join(s.home, '.trocar', 'collector') })
    assert.deepEqual(plan.entries.map((e) => [e.path, e.keys.join('.'), e.value, e.semantic]), [[path.join(s.home, '.claude', 'settings.json'), 'env.NODE_EXTRA_CA_CERTS', path.join(s.home, '.trocar', 'collector', 'ca', 'trocar-ca.pem'), 'append']])
    assert.deepEqual(plan.files, [])
    const alt = planTrust({ descriptors: [cc], ctxFor: () => injectCtx(s, { env: { CLAUDE_CONFIG_DIR: path.join(s.home, 'cfg') } }), caCertPem: CA.certPem, collectorDir: path.join(s.home, '.trocar', 'collector') })
    assert.equal(alt.entries[0].path, path.join(s.home, 'cfg', 'settings.json'))
  } finally { s.done() }
})

test('claude-code inject: a value in the shell, a running CC, ~/.claude.json or user settings → extra-cc.pem with those certificates', () => {
  const s = sandbox()
  try {
    const shell = s.put('ca/shell.pem', OTHER.certPem)
    const corp = createCa({ commonName: 'corp' }); const inSettings = s.put('ca/corp.pem', corp.certPem)
    const run = createCa({ commonName: 'run' }); const inRunning = s.put('ca/run.pem', run.certPem)
    s.put('.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: inSettings } }))
    s.put('.claude.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: path.join(s.home, '.trocar', 'collector', 'ca', 'trocar-ca.pem') } })) // trocar's own value: ignored
    const dir = path.join(s.home, '.trocar', 'collector')
    const plan = planTrust({ descriptors: [cc], ctxFor: () => injectCtx(s, { env: { NODE_EXTRA_CA_CERTS: shell }, running: [{ NODE_EXTRA_CA_CERTS: inRunning }] }), caCertPem: CA.certPem, collectorDir: dir })
    assert.equal(plan.entries[0].value, path.join(dir, 'ca', 'extra-cc.pem'))
    assert.deepEqual(plan.files.map((f) => f.path), [path.join(dir, 'ca', 'extra-cc.pem')])
    for (const pem of [OTHER.certPem, corp.certPem, run.certPem, CA.certPem]) assert.ok(plan.files[0].data.includes(pem.trim()))
    assert.ok(plan.notes.some((n) => /exported only in a shell trocar did not see/.test(n)))
  } finally { s.done() }
})
