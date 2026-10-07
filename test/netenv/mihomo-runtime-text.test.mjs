// mihomo-runtime-text.test.mjs — the runtime splice on TEXT (src/netenv/mihomo/runtime-text.mjs; RFC 4.8 §4.1 `payload`). The oracle-based tests (the text path read back equals the object
// path, every shape of runtime, mutations) are in the next commit; this is the smoke test that the module does its two jobs and refuses what it cannot read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spliceRuntimeText, stripRuntimeText, RuntimeShapeError } from '../../src/netenv/mihomo/runtime-text.mjs'
import { buildBlock } from '../../src/netenv/mihomo/rules.mjs'
import { ONE, block } from './fixtures/rules/inputs.mjs'

const B1 = buildBlock(block(ONE))
const TEXT = 'mode: rule\nproxies:\n- name: node-a\n  type: ss\nproxy-groups:\n- name: Proxy\n  type: select\n  proxies:\n  - node-a\nrules:\n- DOMAIN-SUFFIX,example.com,Proxy\n- MATCH,Proxy\n'

test('a splice puts asight\'s entries in (nodes and groups last, rules first, a provider section created) and a strip takes them out again, byte for byte', () => {
  const s = spliceRuntimeText({ yaml: TEXT, block: B1 })
  assert.deepEqual(s.inserted, { proxies: 2, groups: 2, providers: 1, rules: 2 })
  assert.ok(s.yaml.includes('  type: ss\n- {"name":"asight-in-claude-code.cli"'), 'the node entries come right after the user\'s last node')
  assert.ok(s.yaml.includes('rules:\n- "AND,((DST-PORT,7897)'), 'the rules come first')
  assert.ok(s.yaml.endsWith('- MATCH,Proxy\nrule-providers:\n  asight-r-claude-code.cli: {"type":"file","behavior":"classical","format":"text","path":"./asight/route-claude-code.cli.txt","payload":["DOMAIN,asight-off.invalid"]}\n'))
  assert.equal(spliceRuntimeText({ yaml: s.yaml, block: B1 }).yaml, s.yaml, 'twice is once')
  const t = stripRuntimeText({ yaml: s.yaml })
  assert.deepEqual(t.removed, { proxies: 2, groups: 2, providers: 1, rules: 2 })
  assert.equal(t.yaml.replace('rule-providers: {}\n', ''), TEXT, 'the user\'s text is back (the created provider section stays, empty)')
})

test('an include-all group gets ^asight- in its exclude-filter, and a strip takes it out', () => {
  const text = 'proxy-groups:\n- name: AUTO\n  type: url-test\n  include-all: true\n  exclude-filter: IEPL|BGP\nrules:\n- MATCH,AUTO\n'
  const s = spliceRuntimeText({ yaml: text, block: B1 })
  assert.equal(s.filtered, 1)
  assert.ok(s.yaml.includes('  exclude-filter: "IEPL|BGP|^asight-"\n'))
  assert.ok(stripRuntimeText({ yaml: s.yaml }).yaml.includes('  exclude-filter: "IEPL|BGP"\n'))
})

test('a shape it cannot read throws RuntimeShapeError', () => {
  assert.throws(() => spliceRuntimeText({ yaml: 'proxies: [{name: a, type: direct}]\nrules:\n- MATCH,a\n', block: B1 }), (e) => e instanceof RuntimeShapeError && e.code === 'runtime-shape')
})
