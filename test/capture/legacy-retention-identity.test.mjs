// test/capture/legacy-retention-identity.test.mjs — RFC 4.6 §记录「保存级别」 (D40 audit finding 缺接线): the OLD reverse proxy and MITM have no
// process identity, and used to apply the `cc` row to EVERY call: `asight keep cc llm log` also stripped the bodies of a Codex call that came
// through `asight capture` (reproduced: a Codex-shaped POST /v1/responses lost its body), and `keep codex …` never applied there. A call's
// harness is now told by its User-Agent — the read side's own inference (harnessOf, what the ETL files the call under), 'unknown' when no UA
// names one — so the setting that applies to a call is the one its row in the sizes table is filed under. And every id that inference can
// return is one the settings may name: the UA-inferred `deepseek-cli` used to get a row with a live switch on the board that
// POST /control/retention refused (400 unknown harness).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildLegacyRetention } from '../../src/legacy-retention.mjs'
import { harnessIdOfHeaders, retentionHarnessIds } from '../../src/dissect/traffic.mjs'
import { harnessOf } from '../../src/dissect/harnesses.mjs'
import { LEGACY_PATHS } from '../helpers/legacy-paths.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const UAS = {
  cc: 'claude-cli/2.1.0 (external, cli)',
  codex: 'codex_cli_rs/0.160.0 (Mac OS 15.0; arm64)',
  opencode: 'opencode/1.18.34',
  'deepseek-cli': 'deepseek-cli/0.9',
}
const T = { timeout: 60_000 }

test('harnessIdOfHeaders: the UA names the harness the way the read side does; no UA is `unknown`; every id it can return is one a setting may name', () => {
  for (const [id, ua] of Object.entries(UAS)) assert.equal(harnessIdOfHeaders({ 'user-agent': ua }), id, ua)
  assert.equal(harnessIdOfHeaders({ 'User-Agent': UAS.codex }), 'codex', 'any case of the header name')
  assert.equal(harnessIdOfHeaders({}), 'unknown'); assert.equal(harnessIdOfHeaders(undefined), 'unknown'); assert.equal(harnessIdOfHeaders({ 'user-agent': 'curl/8.0' }), 'unknown')
  const settable = retentionHarnessIds()
  for (const ua of [...Object.values(UAS), 'curl/8.0', '']) {
    const id = harnessOf({ req_headers: ua ? { 'user-agent': ua } : {} }).id || 'unknown'
    assert.ok(settable.includes(id), `${JSON.stringify(ua)} → ${id}: a row the settings can name (else the board lists a switch setRetention rejects)`)
  }
})

for (const start of LEGACY_PATHS) {
  test(`${start === LEGACY_PATHS[0] ? 'reverse proxy' : 'MITM'}: the row that applies is the call's own harness — a Codex call is not stripped by \`cc · llm = log\`, and each UA reaches its own row (D40 audit)`, T, async () => {
    const dir = tmpDir('asight-legid-'), file = path.join(dir, 'retention.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, levels: { cc: { llm: 'log' }, 'deepseek-cli': { llm: 'log' }, unknown: { llm: 'log' } } }))
    const events = []
    const retention = buildLegacyRetention({ file, onEvent: (e) => events.push(e) })
    const up = (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 }); res.end('{}') }) }
    const p = await start(up, { retention })
    try {
      const BODY = '{"model":"m","input":"secret-context"}'
      const seen = {}
      for (const [who, ua] of [['cc', UAS.cc], ['codex', UAS.codex], ['deepseek-cli', UAS['deepseek-cli']], ['none', null]]) {
        const id = `/v1/messages?who=${who}`
        await p.send({ method: 'POST', path: id, headers: { 'content-type': 'application/json', ...(ua ? { 'user-agent': ua } : {}) }, body: BODY })
        for (let i = 0; i < 300 && !p.envelopes.some((e) => e.endpoint === id); i++) await new Promise((r) => setTimeout(r, 10))
        seen[who] = p.envelopes.find((e) => e.endpoint === id)
      }
      const kept = (e) => (e.body_retention === 'log' ? 'log' : e.req_body === BODY ? 'full' : `?${JSON.stringify(e.req_body)}`)
      assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([k, e]) => [k, kept(e)])),
        { cc: 'log', codex: 'full', 'deepseek-cli': 'log', none: 'log' },
        'cc · deepseek-cli · unknown are set to log; codex is not: its body is kept (before: the cc row stripped it)')
      assert.match(seen.cc.body_retention ? seen.cc.req_headers['user-agent'] : '', /claude-cli/)
      assert.deepEqual(events.filter((e) => e.event === 'failure'), [], 'no failure line')
    } finally { p.stop() }
  })
}

test('the label of a log record from the old capture names the harness its UA told, not always cc', async () => {
  const { retentionLabelOf } = await import('../../src/dissect/capture-labels.mjs')
  const rec = (ua) => ({ id: 'x', endpoint: '/v1/responses', is_llm_call: true, req_headers: ua ? { 'user-agent': ua } : {}, req_body: { raw_chars: 5, verbatim: false }, body_retention: 'log', traffic_class: 'llm' })
  assert.match(retentionLabelOf(rec(UAS.codex)).label, /codex · llm$/)
  assert.match(retentionLabelOf(rec(UAS.cc)).label, /cc · llm$/)
  assert.match(retentionLabelOf(rec(null)).label, /unknown · llm$/)
})
