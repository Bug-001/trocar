// test/collector/harness/pi.test.mjs — the pi descriptor on Linux (RFC 4.6 §身份与信任 pi row, D37④): trust comes from one extension
// file trocar owns in pi's agent dir, which pi discovers itself (no loader row), and the marker it writes; when the marker is missing
// the reason is no-marker, whatever NODE_EXTRA_CA_CERTS says.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import pi from '../../../src/collector/harness/pi.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { sandbox, ctxFor, judge, plantMarker, CA, OTHER } from './_ctx.mjs'

const AGENT = ['node', '/usr/local/bin/pi', '-p', 'hi']

test('pi inject: exactly one owned file, <agent dir>/extensions/trocar-ca.js (PI_CODING_AGENT_DIR, else ~/.pi/agent), and no entry in any user file', () => {
  const s = sandbox()
  try {
    const dir = path.join(s.home, '.trocar', 'collector')
    const ctx = (env = {}) => ({ home: s.home, env: new Map(Object.entries(env)), collectorDir: dir, caPem: path.join(dir, 'ca', 'trocar-ca.pem'), readText: () => null, running: [] })
    const plan = (env) => planTrust({ descriptors: [pi], ctxFor: () => ctx(env), caCertPem: CA.certPem, collectorDir: dir })
    for (const [env, agentDir] of [[{}, path.join(s.home, '.pi', 'agent')], [{ PI_CODING_AGENT_DIR: '/srv/pi-agent' }, '/srv/pi-agent'], [{ PI_CODING_AGENT_DIR: '~/alt-pi' }, path.join(s.home, 'alt-pi')]]) {
      const p = plan(env)
      assert.deepEqual(p.owned.map((o) => o.path), [path.join(agentDir, 'extensions', 'trocar-ca.js')], JSON.stringify(env))
      assert.deepEqual(p.entries, [], 'pi discovers the file itself: no loader row')
    }
  } finally { s.done() }
})

test('pi trust: the marker trusts; without it var-missing / ca-not-in-file / file-unreadable all read no-marker, and a stale marker keeps its own reason (T12)', () => {
  const s = sandbox()
  try {
    const caPem = s.put('.trocar/collector/ca/trocar-ca.pem', CA.certPem)
    const markers = plantMarker(path.join(s.home, 'run/trust'), 1000, 4242)
    const ok = judge(pi, ctxFor({ home: s.home, argv: AGENT, startTicks: 4242 }), { markerDir: markers, caPem })
    assert.equal(ok.trust.trusted, true)
    assert.equal(judge(pi, ctxFor({ home: s.home, argv: AGENT, startTicks: 1 }), { markerDir: markers, caPem }).trust.reason, 'marker-stale')
    const none = path.join(s.home, 'no-markers')
    const why = (env) => judge(pi, ctxFor({ home: s.home, argv: AGENT, env }), { markerDir: none, caPem }).trust.reason
    const corp = s.put('corp.pem', OTHER.certPem)
    for (const env of [{}, { NODE_EXTRA_CA_CERTS: corp }, { NODE_EXTRA_CA_CERTS: path.join(s.home, 'gone.pem') }]) assert.equal(why(env), 'no-marker', JSON.stringify(env))
    assert.ok(pi.trust.hints['no-marker'])
  } finally { s.done() }
})
