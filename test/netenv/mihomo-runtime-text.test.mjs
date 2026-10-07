// mihomo-runtime-text.test.mjs — the runtime splice on TEXT (src/netenv/mihomo/runtime-text.mjs; RFC 4.8 §4.1 `payload`, 4.7 §3.2, W58 and W9 for the text path).
// The proxy software's runtime file is YAML, there is no YAML library in this project, and the real runtime holds the user's nodes and credentials: the splice is line based, touches only what
// it must, and throws (RuntimeShapeError) on a shape it does not understand. The oracle for what it should produce is the object path of rules.mjs (spliceRuntime), compared through a small
// reader that only the tests have (fixtures/rules/mini-yaml.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spliceRuntimeText, stripRuntimeText, RuntimeShapeError } from '../../src/netenv/mihomo/runtime-text.mjs'
import { buildBlock, spliceRuntime, stripRuntime, buildScriptJs, OUR_RULE, LOOP_RULE } from '../../src/netenv/mihomo/rules.mjs'
import { runtimeFixture, runtimeText } from './fixtures/rules/runtime.mjs'
import { parseYaml } from './fixtures/rules/mini-yaml.mjs'
import { ONE, TWO, THREE, block } from './fixtures/rules/inputs.mjs'

const B2 = buildBlock(block(TWO)), B3 = buildBlock(block(THREE)), B1 = buildBlock(block(ONE))
const splice = (yaml, b = B2) => spliceRuntimeText({ yaml, block: b }).yaml
const strip = (yaml) => stripRuntimeText({ yaml }).yaml
const crlf = (t) => t.replace(/\n/g, '\r\n')

// the same config as text and as an object, in the shapes a runtime file really takes
const withoutFilter = (t) => t.replace(/ {2}exclude-filter: IEPL\|BGP\r?\n/, '')
const VARIANTS = {
  'the usual runtime': { text: runtimeText(), object: runtimeFixture() },
  'CRLF line ends': { text: crlf(runtimeText()), object: runtimeFixture() },
  'no rule-providers section': { text: runtimeText().replace(/rule-providers:\n(?: {2}.*\n)+/, ''), object: (() => { const o = runtimeFixture(); delete o['rule-providers']; return o })(), creates: true },
  'proxies: [] (no nodes of its own)': { text: runtimeText().replace(/proxies:\n- name: node-a\n(?: {2}.*\n)+- name: node-b\n(?: {2}.*\n)+/, 'proxies: []\n'), object: { ...runtimeFixture(), proxies: [] } },
  'only rules': { text: 'rules:\n- MATCH,DIRECT\n', object: { rules: ['MATCH,DIRECT'] }, creates: true },
  'comments and blank lines between the sections': { text: runtimeText().replace('proxy-groups:\n', '\n# groups below\nproxy-groups:\n').replace('rules:\n', '# rules\n\nrules:\n'), object: runtimeFixture() },
  'no file end newline': { text: runtimeText().slice(0, -1), object: runtimeFixture() },
}

test('the reader and the fixture hold each other to account: the text reads back as the object', () => {
  assert.deepEqual(parseYaml(runtimeText()), runtimeFixture())
  for (const [what, v] of Object.entries(VARIANTS)) assert.deepEqual(parseYaml(v.text), v.object, what)
})

test('W58 (text path) the spliced text reads back as exactly what the object path gives, for every shape of runtime', () => {
  for (const [what, v] of Object.entries(VARIANTS)) for (const b of [B2, B3]) {
    assert.deepEqual(parseYaml(splice(v.text, b)), spliceRuntime({ runtime: v.object, block: b }), `${what}, ${b.groups.length / 2} groups`)
  }
})

test('W9 (text path) include-all groups get ^asight- in exclude-filter, joined with | when there is one; the other groups, the nodes, the provider and the user\'s rules are as they were', () => {
  const out = parseYaml(splice(runtimeText()))
  const group = (n) => out['proxy-groups'].find((g) => g.name === n)
  assert.equal(group('AUTO')['exclude-filter'], 'IEPL|BGP|^asight-')
  assert.equal(group('AUTO-ALL')['exclude-filter'], '^asight-')
  assert.equal(group('AUTO-PROV')['exclude-filter'], '^asight-')
  for (const n of ['Proxy', 'Manual']) assert.deepEqual(group(n), runtimeFixture()['proxy-groups'].find((g) => g.name === n))
  assert.deepEqual(out.proxies.slice(0, 2), runtimeFixture().proxies)
  assert.deepEqual(out['rule-providers']['user-ads'], runtimeFixture()['rule-providers']['user-ads'])
  assert.deepEqual(out.rules.slice(B2.rules.length), runtimeFixture().rules)
})

test('asight\'s entries go right after the last line of the user\'s section, not after the blank and comment lines that follow it', () => {
  const t = VARIANTS['comments and blank lines between the sections'].text
  const out = splice(t)
  assert.ok(out.includes('  sni: example.com\n- {"name":"asight-in-claude-code.cli"'), 'proxies: straight after the last node')
  assert.ok(out.includes('  - node-b\n- {"name":"asight-fb-claude-code.cli"'), 'groups: straight after the last group')
  assert.ok(out.includes('    interval: 86400\n  asight-r-claude-code.cli: {'), 'providers: straight after the last provider')
  assert.ok(out.includes('rules:\n- "AND,'), 'rules: first')
  assert.ok(/# groups below\nproxy-groups:/.test(out) && /# rules\n\nrules:/.test(out), 'the user\'s gaps and comments are where they were')
})

test('the user\'s lines are kept, in order, byte for byte: only asight\'s entries are added and the include-all groups\' filter lines are written', () => {
  const was = runtimeText().split('\n'), now = splice(runtimeText()).split('\n')
  const kept = was.filter((l) => l !== '  exclude-filter: IEPL|BGP')
  let at = 0
  for (const l of now) if (at < kept.length && l === kept[at]) at++
  assert.equal(at, kept.length, `a line of the user's was lost or moved: ${kept[at]}`)
  const added = now.filter((l) => !was.includes(l))
  assert.ok(added.every((l) => /asight|no-resolve\)\),DIRECT/.test(l)), `every new line is asight's (its entries, its filter, its loopback rule): ${added.filter((l) => !/asight|no-resolve\)\),DIRECT/.test(l))}`)
  assert.equal(added.filter((l) => l.includes('exclude-filter')).length, 3)
})

test('strip is the inverse: the user\'s config comes back with no asight in it (a section the splice had to create stays, empty: the same as the object path); byte for byte otherwise', () => {
  for (const [what, v] of Object.entries(VARIANTS)) {
    assert.deepEqual(parseYaml(strip(splice(v.text))), stripRuntime({ runtime: spliceRuntime({ runtime: v.object, block: B2 }) }), what)
    if (!v.creates) assert.deepEqual(parseYaml(strip(splice(v.text))), v.object, `${what}: all its sections were there, so the config is the user's again`)
    const t = withoutFilter(v.text)
    if (!v.creates) assert.equal(strip(splice(t)), t, `${what}: byte for byte`)
  }
  assert.ok(!/asight/i.test(strip(splice(runtimeText()))), 'asight count 0 after the strip (the spike measured it)')
  assert.equal(strip(runtimeText()), runtimeText(), 'nothing of ours to strip is not a change')
})

test('splicing twice is splicing once (byte for byte); another block replaces the first and leaves nothing', () => {
  for (const [what, v] of Object.entries(VARIANTS)) {
    const once = splice(v.text)
    assert.equal(splice(once), once, what)
    assert.deepEqual(parseYaml(splice(once, B1)), spliceRuntime({ runtime: v.object, block: B1 }), `${what}: replaced`)
  }
})

// what the proxy software writes after it ran the global script: asight's entries in its own block style, with nothing to mark them, at the end of each section (the rules at the top)
const REGENERATED = runtimeText()
  .replace('proxy-groups:\n', `- name: asight-in-claude-code.cli
  type: http
  server: 127.0.0.1
  port: 18790
  username: vb.claude-code.cli
  password: 0123456789abcdef0123456789abcdef
- name: asight-re-claude-code.cli
  type: http
  server: 127.0.0.1
  port: 7897
proxy-groups:
`)
  .replace('rule-providers:\n', `- name: asight-fb-claude-code.cli
  type: fallback
  proxies:
  - asight-in-claude-code.cli
  - asight-re-claude-code.cli
  url: http://127.0.0.1:7897/asight-health/claude-code.cli
  interval: 30
  timeout: 2000
  lazy: true
- name: asight-sw-claude-code.cli
  type: select
  proxies:
  - PASS
  - asight-fb-claude-code.cli
rule-providers:
`)
  .replace('rules:\n', `  asight-r-claude-code.cli:
    type: file
    behavior: classical
    format: text
    path: ./asight/route-claude-code.cli.txt
    payload:
    - DOMAIN,asight-off.invalid
rules:
- AND,((DST-PORT,7897),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT
- RULE-SET,asight-r-claude-code.cli,asight-sw-claude-code.cli
`)
  .replace('  exclude-filter: IEPL|BGP\n', '  exclude-filter: IEPL|BGP|^asight-\n')
  .replace('  include-all-proxies: true\n', '  include-all-proxies: true\n  exclude-filter: ^asight-\n')
  .replace('  include-all-providers: true\n', '  include-all-providers: true\n  exclude-filter: ^asight-\n')

test('the copy the proxy software writes after it ran the global script (block style, unmarked) is taken out too, and a splice on top of it makes no duplicate', () => {
  assert.ok((REGENERATED.match(/asight/g) || []).length > 10)
  assert.deepEqual(parseYaml(strip(REGENERATED)), runtimeFixture(), 'every regenerated entry of ours goes, the filters with them, and nothing else')
  assert.deepEqual(parseYaml(splice(REGENERATED, B1)), spliceRuntime({ runtime: runtimeFixture(), block: B1 }))
})

test('a block with a rule the strip would not take out again is refused before anything is written (the same guard as the object path)', () => {
  const odd = { ...B1, rules: [...B1.rules, 'DOMAIN,evil.example.com,asight-sw-claude-code.cli'] }
  assert.throws(() => spliceRuntimeText({ yaml: runtimeText(), block: odd }), /every rule in a block/)
  assert.throws(() => spliceRuntimeText({ yaml: runtimeText(), block: { ...B1, rules: [...B1.rules, B1.rules[0]] } }), /every rule in a block/, 'a loopback rule with nothing of ours behind it')
})

test('what only looks like asight\'s is the user\'s: a nested name inside a node, a node called asightx, a node, a group and a provider with asight- in the MIDDLE of the name, a rule that mentions an asight- name, a loopback-shaped rule of their own', () => {
  const text = `proxies:
- name: asightx
  type: direct
- name: my-asight-vpn
  type: direct
- name: node-a
  type: ss
  plugin-opts:
    name: asight-in-claude-code.cli
    mode: tls
- type: ss
  plugin-opts:
    name: asight-in-claude-code.cli
  name: node-c
proxy-groups:
- name: g
  type: select
  proxies:
  - DIRECT
  - my-asight-vpn
- name: my-asight-grp
  type: select
  proxies:
  - my-asight-vpn
rule-providers:
  mine:
    type: inline
    payload:
    - DOMAIN,x.example.com
  x-asight-r:
    type: inline
    payload:
    - DOMAIN,y.example.com
rules:
- DOMAIN,asight-in-foo.example.com,DIRECT
- DOMAIN,asight-r-foo.example.com,DIRECT
- RULE-SET,asight-r-mine,DIRECT
- AND,((DST-PORT,7897),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT
- MATCH,DIRECT
`
  assert.deepEqual(parseYaml(splice(text, B1)), spliceRuntime({ runtime: parseYaml(text), block: B1 }))
  assert.equal(strip(splice(text, B1)), text)
  assert.equal(strip(text), text)
  // by name, and not only by the oracle: only a name that STARTS with asight- is ours (a node named my-asight-vpn deleted from the pushed runtime breaks the groups that list it)
  const out = parseYaml(splice(text, B1))
  assert.ok(out.proxies.some((p) => p.name === 'my-asight-vpn'), 'a node with asight- inside its name is the user\'s')
  assert.ok(out['proxy-groups'].some((g) => g.name === 'my-asight-grp'), 'a group with asight- inside its name is the user\'s')
  assert.ok('x-asight-r' in out['rule-providers'], 'a provider with asight- inside its key is the user\'s')
})

test('quoted names and flow items of ours are recognised; a quoted key and a single-quoted rule too', () => {
  const text = `proxies:
- "name": "asight-in-claude-code.cli"
  type: http
- {name: 'asight-re-claude-code.cli', type: http, server: 127.0.0.1, port: 1}
- {"name":"asight-in-kimi-code.cli","type":"http"}
- {name: keep, type: http}
- {name: keep2, type: http, headers: {name: asight-in-claude-code.cli}}
- {type: http, headers: {name: asight-in-claude-code.cli}, name: keep3}
proxy-groups:
- {name: asight-sw-claude-code.cli, type: select, proxies: [PASS]}
rules:
- 'RULE-SET,asight-r-claude-code.cli,asight-sw-claude-code.cli'
- MATCH,keep
`
  assert.equal(strip(text), 'proxies:\n- {name: keep, type: http}\n- {name: keep2, type: http, headers: {name: asight-in-claude-code.cli}}\n- {type: http, headers: {name: asight-in-claude-code.cli}, name: keep3}\nproxy-groups: []\nrules:\n- MATCH,keep\n')
})

test('the exclude-filter, in every spelling the file can hold it: plain with a comment, single-quoted with a quote in it, double-quoted with an escape, absent, empty; strip restores the first four', () => {
  const group = (line) => `proxy-groups:\n- name: g\n  type: url-test\n  include-all: true\n${line}  url: https://example.invalid/p\n`
  const cases = [
    ['  exclude-filter: a|b # why\n', 'a|b|^asight-', 'a|b'],
    ["  exclude-filter: 'it''s|x'\n", "it's|x|^asight-", "it's|x"],
    ['  exclude-filter: "a\\\\b|c"\n', 'a\\b|c|^asight-', 'a\\b|c'],
    ['', '^asight-', undefined],
    ["  exclude-filter: ''\n", '^asight-', undefined],
    ['  exclude-filter: ^asight-\n', '^asight-', undefined],
    ['  exclude-filter: x|^asight-\n', 'x|^asight-', 'x'],
  ]
  for (const [line, spliced, restored] of cases) {
    const g = (text) => parseYaml(text)['proxy-groups'][0]
    const t = group(line)
    assert.equal(g(splice(t, B1))['exclude-filter'], spliced, JSON.stringify(line))
    assert.equal(g(strip(splice(t, B1)))['exclude-filter'], restored, `${JSON.stringify(line)} restored`)
  }
  const once = splice(group(''), B1)
  assert.equal(once.match(/exclude-filter/g).length, 1, 'one line, not two, after two splices')
  assert.equal(splice(once, B1).match(/exclude-filter/g).length, 1)
})

test('a shape that is not understood throws RuntimeShapeError and writes nothing: a non-empty inline section, a flow group with include-all, a block-scalar filter, a multi-line filter, a section that is a scalar', () => {
  const bad = (what, text, fn = splice) => assert.throws(() => fn(text), (e) => e instanceof RuntimeShapeError && e.code === 'runtime-shape', what)
  bad('inline rule-providers', 'proxies: []\nrule-providers: {x: {type: http, url: "https://example.invalid", behavior: domain}}\nrules:\n- MATCH,a\n')
  bad('inline proxies with content', 'proxies: [{name: a, type: direct}]\nrules:\n- MATCH,a\n')
  bad('a scalar where a list is', 'proxies: nothing\nrules:\n- MATCH,a\n')
  bad('a flow group with include-all', 'proxy-groups:\n- {name: g, type: url-test, include-all: true}\nrules:\n- MATCH,g\n')
  bad('a block-scalar filter', 'proxy-groups:\n- name: g\n  include-all: true\n  exclude-filter: |\n    a\n    b\n  type: url-test\nrules:\n- MATCH,g\n')
  bad('a multi-line quoted filter', 'proxy-groups:\n- name: g\n  include-all: true\n  exclude-filter: "a\n    b"\n  type: url-test\nrules:\n- MATCH,g\n')
  bad('strip cannot look inside an inline section', 'proxies: [{name: asight-in-x}]\nrules:\n- MATCH,a\n', strip)
  bad('a filter that is the first key of its group and has to go', 'proxy-groups:\n- exclude-filter: ^asight-\n  name: g\n  include-all: true\n', strip)
  const odd = 'proxy-groups:\n- name: g\n  type: select\n  exclude-filter: |\n    a\n    b\n  proxies:\n  - DIRECT\nrules:\n- MATCH,g\n'
  assert.doesNotThrow(() => splice(odd), 'a group without include-all is not touched, whatever its filter looks like')
  assert.equal(strip(odd), odd, 'and a filter that does not hold our token is not read when taking out')
  assert.doesNotThrow(() => splice('proxies: []\nproxy-groups: []\nrule-providers: {}\nrules: []\n'), 'inline EMPTY sections are fine')
  assert.doesNotThrow(() => splice('proxy-groups:\n- {name: g, type: select, proxies: [DIRECT]}\nrules:\n- MATCH,g\n'), 'a flow group without include-all is fine')
})

test('empty inline sections come back as they were, and an emptied section is an explicit empty one', () => {
  const t = 'proxies: []\nproxy-groups: []\nrule-providers: {}\nrules: []\n'
  assert.equal(strip(splice(t)), t)
  assert.deepEqual(parseYaml(strip(splice('mode: rule\nrules:\n- MATCH,DIRECT\n'))), { mode: 'rule', rules: ['MATCH,DIRECT'], proxies: [], 'proxy-groups': [], 'rule-providers': {} }, 'created sections stay, empty (the object path does the same)')
})

test('counts for the receipt: what was added, what was taken out, how many filters moved', () => {
  const s = spliceRuntimeText({ yaml: runtimeText(), block: B2 })
  assert.deepEqual({ inserted: s.inserted, filtered: s.filtered }, { inserted: { proxies: 4, groups: 4, providers: 2, rules: 3 }, filtered: 3 })
  const t = stripRuntimeText({ yaml: s.yaml })
  assert.deepEqual({ removed: t.removed, unfiltered: t.unfiltered }, { removed: { proxies: 4, groups: 4, providers: 2, rules: 3 }, unfiltered: 3 })
  assert.deepEqual(stripRuntimeText({ yaml: runtimeText() }).removed, { proxies: 0, groups: 0, providers: 0, rules: 0 })
})

test('a large runtime (6000 user rules, 40 nodes: the real one is ~440 KB) survives a splice and a strip byte for byte, in time', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => `- name: n${i}\n  type: ss\n  server: 203.0.113.${i}\n  port: 8388\n  password: not-a-real-password\n`).join('')
  const big = `mode: rule\nproxies:\n${nodes}proxy-groups:\n- name: P\n  type: select\n  proxies:\n  - DIRECT\nrule-providers:\n  x:\n    type: inline\n    payload:\n    - DOMAIN,x.example.com\nrules:\n${Array.from({ length: 6000 }, (_, i) => `- DOMAIN-SUFFIX,site${i}.example,P\n`).join('')}- MATCH,P\n`
  const t0 = Date.now()
  const spliced = splice(big)
  assert.equal(strip(spliced), big)
  assert.ok(spliced.length > big.length)
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
})

test('the splice and the global script recognise the same two rule shapes: the embedded copies are the exported ones', () => {
  const script = buildScriptJs({ block: B1 })
  assert.ok(script.includes(`var OUR_RULE = /${OUR_RULE.source}/;`))
  assert.ok(script.includes(`var LOOP_RULE = /${LOOP_RULE.source}/;`))
})
