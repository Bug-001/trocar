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
    const pem = s.put('ca/asight.pem', CA.certPem); const foreign = s.put('ca/other.pem', OTHER.certPem)
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
    const pem = s.put('ca/asight.pem', CA.certPem)
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

test('claude-code: host-managed, --restricted and --setting-sources without user drop the settings CA (T12)', () => {
  const s = sandbox()
  try {
    const pem = s.put('ca/asight.pem', CA.certPem)
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
const injectCtx = (s, { env = {}, running = [] } = {}) => ({ ...ctxFor({ home: s.home, env }), running: running.map((e) => new Map(Object.entries(e))), collectorDir: path.join(s.home, '.asight', 'collector'), caPem: path.join(s.home, '.asight', 'collector', 'ca', 'asight-ca.pem') })

test('claude-code inject: no existing value → settings env.NODE_EXTRA_CA_CERTS = asight-ca.pem; $CLAUDE_CONFIG_DIR moves the file', () => {
  const s = sandbox()
  try {
    const plan = planTrust({ descriptors: [cc], ctxFor: () => injectCtx(s), caCertPem: CA.certPem, collectorDir: path.join(s.home, '.asight', 'collector') })
    assert.deepEqual(plan.entries.map((e) => [e.path, e.keys.join('.'), e.value, e.semantic]), [[path.join(s.home, '.claude', 'settings.json'), 'env.NODE_EXTRA_CA_CERTS', path.join(s.home, '.asight', 'collector', 'ca', 'asight-ca.pem'), 'append']])
    assert.deepEqual(plan.files, [])
    const alt = planTrust({ descriptors: [cc], ctxFor: () => injectCtx(s, { env: { CLAUDE_CONFIG_DIR: path.join(s.home, 'cfg') } }), caCertPem: CA.certPem, collectorDir: path.join(s.home, '.asight', 'collector') })
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
    s.put('.claude.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: path.join(s.home, '.asight', 'collector', 'ca', 'asight-ca.pem') } })) // asight's own value: ignored
    const dir = path.join(s.home, '.asight', 'collector')
    const plan = planTrust({ descriptors: [cc], ctxFor: () => injectCtx(s, { env: { NODE_EXTRA_CA_CERTS: shell }, running: [{ NODE_EXTRA_CA_CERTS: inRunning }] }), caCertPem: CA.certPem, collectorDir: dir })
    assert.equal(plan.entries[0].value, path.join(dir, 'ca', 'extra-cc.pem'))
    assert.deepEqual(plan.files.map((f) => f.path), [path.join(dir, 'ca', 'extra-cc.pem')])
    for (const pem of [OTHER.certPem, corp.certPem, run.certPem, CA.certPem]) assert.ok(plan.files[0].data.includes(pem.trim()))
    assert.ok(plan.notes.some((n) => /exported only in a shell asight did not see/.test(n)))
  } finally { s.done() }
})
