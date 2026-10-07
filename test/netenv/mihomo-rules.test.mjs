// mihomo-rules.test.mjs — the rule-block generator (RFC 4.8 §3 · §4.2; acceptance W7 W8 W9 W10 W12 W58). `src/netenv/mihomo/rules.mjs` is a pure function of
// data (groups, process patterns, ports, token): these tests feed it data and read what comes out. What mihomo does with the output is the real-binary
// contract's job (test/netenv/mihomo-contract.test.mjs, W57); the Verge side of the Script.js wrapper is Windows's (W32).
// Goldens: test/netenv/fixtures/rules/ (ASIGHT_UPDATE_GOLDEN=1 rewrites the generated ones; block-one.json is hand-written from 4.8 §3.1 and is the oracle).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBlock, checkLoops, names, probeUrl, processRulesOf, routeFile, RouteLoopError } from '../../src/netenv/mihomo/rules.mjs'
import { TOKEN, ENGINE_PORT, REENTER, ONE, TWO, THREE, block, IMAGES, goldenText } from './fixtures/rules/inputs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RULES_SRC = path.join(HERE, '..', '..', 'src', 'netenv', 'mihomo', 'rules.mjs')
const GOLD = (n) => path.join(HERE, 'fixtures', 'rules', n)
function golden(name, actual) {
  if (process.env.ASIGHT_UPDATE_GOLDEN === '1') fs.writeFileSync(GOLD(name), actual)
  assert.equal(actual, fs.readFileSync(GOLD(name), 'utf8'), `${name}: the generator's output changed (ASIGHT_UPDATE_GOLDEN=1 rewrites it; read the diff first)`)
}

// How mihomo reads a process rule (4.8 §2.3, rules/common/process.go): a regex is case-insensitive and unanchored over the whole image path, a name is compared to the base name.
const baseName = (p) => p.split(/[\\/]/).pop()
function matches(line, image) {
  const i = line.indexOf(',')
  const type = line.slice(0, i), payload = line.slice(i + 1)
  if (type === 'PROCESS-PATH-REGEX') return new RegExp(payload, 'i').test(image)
  if (type === 'PROCESS-NAME') return baseName(image).toLowerCase() === payload.toLowerCase()
  throw new Error(`not a process rule: ${line}`)
}
const everyLine = (b) => Object.values(b.files).flatMap((t) => t.split('\n').filter(Boolean))
const asText = (b) => JSON.stringify(b)

// ---- W7 ------------------------------------------------------------------------------------------------------------------------------------------

test('W7 golden, one group: byte for byte what 4.8 §3.1 describes (hand-written)', () => {
  assert.equal(goldenText(buildBlock(block(ONE))), fs.readFileSync(GOLD('block-one.json'), 'utf8'))
})

test('W7 golden, two groups (one with a name rule)', () => {
  golden('block-two.json', goldenText(buildBlock(block(TWO))))
})

test('W7 every name is asight-…, and the group id is the only thing that varies', () => {
  const b = buildBlock(block(THREE))
  const all = [...b.proxies.map((p) => p.name), ...b.groups.map((g) => g.name), ...Object.keys(b.providers),
    ...b.groups.flatMap((g) => g.proxies.filter((n) => n !== 'PASS')), ...b.rules.filter((r) => r.startsWith('RULE-SET')).flatMap((r) => r.split(',').slice(1))]
  assert.ok(all.length >= 4 * 7)
  for (const n of all) assert.match(n, /^asight-(in|re|fb|sw|r)-/, n)
  assert.deepEqual(b.proxies.map((p) => p.name), THREE.flatMap(({ g }) => [`asight-in-${g}`, `asight-re-${g}`]), 'input order is kept')
  assert.deepEqual(names('claude-code.cli'), { in: 'asight-in-claude-code.cli', re: 'asight-re-claude-code.cli', fb: 'asight-fb-claude-code.cli', sw: 'asight-sw-claude-code.cli', provider: 'asight-r-claude-code.cli', up: 'asight-up-claude-code.cli', routeFile: 'asight/route-claude-code.cli.txt' })
})

test('W7 the first rule is the loopback AND → DIRECT (only the probe\'s own connection), then one RULE-SET per group in input order', () => {
  const b = buildBlock(block(THREE))
  assert.equal(b.rules[0], `AND,((DST-PORT,${REENTER.port}),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT`)
  assert.deepEqual(b.rules.slice(1), THREE.map(({ g }) => `RULE-SET,asight-r-${g},asight-sw-${g}`))
  assert.equal(b.rules.length, 1 + THREE.length)
})

test('W7 each fallback group probes the re-entry point itself, locally: url, interval, timeout, lazy, no expected-status; each select starts at PASS', () => {
  const b = buildBlock(block(THREE))
  for (const { g } of THREE) {
    const fb = b.groups.find((x) => x.name === `asight-fb-${g}`)
    assert.deepEqual(fb, { name: `asight-fb-${g}`, type: 'fallback', proxies: [`asight-in-${g}`, `asight-re-${g}`], url: `http://127.0.0.1:${REENTER.port}/asight-health/${g}`, interval: 30, timeout: 2000, lazy: true })
    assert.ok(!('expected-status' in fb), 'no expected-status: any answer is alive')
    assert.equal(probeUrl(REENTER.port, g), fb.url)
    const sw = b.groups.find((x) => x.name === `asight-sw-${g}`)
    assert.deepEqual(sw, { name: `asight-sw-${g}`, type: 'select', proxies: ['PASS', `asight-fb-${g}`] }, 'PASS first = off by default')
    const inn = b.proxies.find((x) => x.name === `asight-in-${g}`), re = b.proxies.find((x) => x.name === `asight-re-${g}`)
    assert.deepEqual(inn, { name: `asight-in-${g}`, type: 'http', server: '127.0.0.1', port: ENGINE_PORT, username: `vb.${g}`, password: TOKEN })
    assert.deepEqual(re, { name: `asight-re-${g}`, type: 'http', server: '127.0.0.1', port: REENTER.port })
  }
})

test('W7 nothing leaves the machine and nothing rejects: no REJECT, no asight-health.invalid, every host is 127.0.0.1, the token is only the engine outbound\'s password', () => {
  const b = buildBlock(block(THREE)); const text = asText(b)
  assert.ok(!/REJECT/.test(text) && !text.includes('asight-health.invalid'), 'the first draft\'s probe design (4.8 §3.3, struck) is not back')
  assert.ok(!/gstatic|generate_204|https:/.test(text), 'no public probe URL')
  for (const p of b.proxies) assert.equal(p.server, '127.0.0.1')
  for (const g of b.groups.filter((x) => x.url)) assert.equal(new URL(g.url).hostname, '127.0.0.1')
  assert.equal(text.split(TOKEN).length - 1, THREE.length, 'the token appears once per group, in asight-in-<g>.password, nowhere else')
  assert.ok(b.proxies.filter((p) => p.password === TOKEN).every((p) => p.name.startsWith('asight-in-')))
})

test('W7 route files: path regexes first, then names only where the form allows one; never (?i)', () => {
  const b = buildBlock(block(THREE))
  assert.deepEqual(Object.keys(b.files), THREE.map(({ g }) => `asight/route-${g}.txt`))
  assert.equal(b.files['asight/route-kimi-code.cli.txt'], String.raw`PROCESS-PATH-REGEX,\\\.kimi-code\\bin\\kimi\.exe` + '\nPROCESS-NAME,kimi.exe\n')
  for (const [file, text] of Object.entries(b.files)) {
    assert.ok(text.endsWith('\n') && !text.includes('\r'), `${file} ends with one LF`)
    const lines = text.split('\n').filter(Boolean)
    const firstName = lines.findIndex((l) => l.startsWith('PROCESS-NAME,'))
    if (firstName >= 0) assert.ok(lines.slice(firstName).every((l) => l.startsWith('PROCESS-NAME,')), `${file}: names after the regexes`)
    assert.ok(!file.includes('node.exe') && !text.includes('(?i)'))
  }
  assert.ok(!b.files['asight/route-claude-code.cli.txt'].includes('PROCESS-NAME'), 'nameRule:false → names is empty → no PROCESS-NAME (a shared image would pull in the forms that are not supported)')
  assert.equal(b.providers['asight-r-codex.app'].path, './asight/route-codex.app.txt', 'the provider reads the file the block ships')
})

test('W7 routing: the block routes the agents and no rule matches Claude Desktop or any Code.exe (4.8 §2.3, §3.5)', () => {
  const lines = everyLine(buildBlock(block(THREE)))
  assert.ok(lines.length >= 6)
  for (const [what, image] of Object.entries({ ccNpm: IMAGES.ccNpm, ccNative: IMAGES.ccNative, codexApp: IMAGES.codexApp, kimi: IMAGES.kimi, hermes: IMAGES.hermes })) {
    assert.ok(lines.some((l) => matches(l, image)), `${what} is routed (the check below is not vacuous)`)
  }
  for (const [what, image] of Object.entries({ claudeDesktop: IMAGES.claudeDesktop, codeUser: IMAGES.codeUser, codeSystem: IMAGES.codeSystem, codeInsiders: IMAGES.codeInsiders })) {
    assert.deepEqual(lines.filter((l) => matches(l, image)), [], `${what}: no rule matches`)
  }
})

test('W7 the generator source names no harness and no lab (static scan, comments included)', () => {
  const src = fs.readFileSync(RULES_SRC, 'utf8')
  assert.deepEqual(src.match(/\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/gi) || [], [], 'a harness id in the generator (4.8 §3: it does not know them)')
  assert.deepEqual(src.match(/asight-test|\bP2-|gstatic|generate_204|atrace/g) || [], [], 'lab names, the struck public probe, the v0 prototype name')
})

test('W7 off is an empty route file; on is the lines, one per row, LF', () => {
  assert.equal(routeFile(null), '')
  assert.equal(routeFile([]), '')
  assert.equal(routeFile(['PROCESS-NAME,a.exe', 'PROCESS-NAME,b.exe']), 'PROCESS-NAME,a.exe\nPROCESS-NAME,b.exe\n')
  assert.throws(() => routeFile(['a\nb']), /line/)
  assert.deepEqual(processRulesOf({ pathPatterns: ['\\\\a'], names: ['x.exe'] }), ['PROCESS-PATH-REGEX,\\\\a', 'PROCESS-NAME,x.exe'])
  assert.deepEqual(processRulesOf({ pathPatterns: ['a'] }), ['PROCESS-PATH-REGEX,a'])
})

test('W7 bad input is refused, not written: ids, route, ports, token, host, patterns, names, empty groups', () => {
  const bad = (what, over, re) => assert.throws(() => buildBlock(over), re, what)
  const g = (x) => [{ ...ONE[0], ...x }]
  bad('no groups', block([]), /group/)
  bad('duplicate id', block([ONE[0], ONE[0]]), /duplicate/)
  bad('id with a space', block(g({ g: 'a b' })), /id/)
  bad('id with a colon (it is the Basic user)', block(g({ g: 'a:b' })), /id/)
  bad('route outside the closed set', block(g({ route: 'xx' })), /route/)
  bad('engine port 0', block(ONE, { enginePort: 0 }), /port/)
  bad('re-entry port as a string', block(ONE, { reenter: { host: '127.0.0.1', port: '7897' } }), /port/)
  bad('engine port = re-entry port', block(ONE, { enginePort: REENTER.port }), /differ/)
  bad('a short token', block(ONE, { token: 'abc' }), /token/)
  bad('a token with a colon', block(ONE, { token: 'a:'.repeat(16) }), /token/)
  bad('a re-entry host that is not loopback (a probe must never leave the machine)', block(ONE, { reenter: { host: '10.0.0.5', port: 7897 } }), /127\.0\.0\.1/)
  bad('pattern with a comma (it splits the rule line)', block(g({ pathPatterns: ['a,b'] })), /comma/)
  bad('pattern with (?i) (JS RegExp has no inline flags; mihomo is case-insensitive anyway)', block(g({ pathPatterns: ['(?i)abc'] })), /inline flag/)
  bad('pattern with a newline', block(g({ pathPatterns: ['a\nb'] })), /pattern/)
  bad('pattern JS cannot compile', block(g({ pathPatterns: ['(['] })), /pattern/)
  bad('empty pattern', block(g({ pathPatterns: [''] })), /pattern/)
  bad('image name with a comma', block(g({ names: ['a,b.exe'] })), /name/)
  bad('image name with a path separator', block(g({ names: ['C:\\x\\a.exe'] })), /name/)
  bad('a group with no process rule at all', block(g({ pathPatterns: [], names: [] })), /rule/)
  bad('patterns not an array', block(g({ pathPatterns: 'abc' })), /pattern/)
})

test('W7 pure: the input is not touched (deep-frozen), the same input gives the same output', () => {
  const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze) } return o }
  const input = deepFreeze(structuredClone(block(THREE)))
  const a = buildBlock(input), b = buildBlock(input)
  assert.deepEqual(a, b)
  a.proxies[0].port = 1
  assert.equal(buildBlock(input).proxies[0].port, ENGINE_PORT, 'the output shares nothing with an earlier output')
})

// ---- W8 ------------------------------------------------------------------------------------------------------------------------------------------

const OWN = [IMAGES.engine, IMAGES.forwarder]
const RULES_OF = (groups) => groups.flatMap(processRulesOf)

test('W8 the generated rules do not match the engine or the forwarder: null', () => {
  assert.equal(checkLoops({ processRules: RULES_OF(THREE), ownImages: OWN }), null)
})

test('W8 a process rule that matches the engine\'s image (or the forwarder\'s) is a route-loop, naming the rule and which image', () => {
  const hit = (rule, imageIndex) => assert.deepEqual(checkLoops({ processRules: ['PROCESS-NAME,codex.exe', rule], ownImages: OWN }), { code: 'route-loop', rule, imageIndex }, rule)
  hit('PROCESS-NAME,node.exe', 0)
  hit('PROCESS-NAME,NODE.EXE', 0) // names compare without case
  hit('PROCESS-PATH-REGEX,nodejs', 0) // unanchored, over the whole path
  hit(String.raw`PROCESS-PATH-REGEX,\\node\.exe`, 0)
  hit('PROCESS-PATH-REGEX,.*', 0)
  hit('PROCESS-PATH-REGEX,PROGRAM FILES', 0) // case-insensitive
  hit(String.raw`PROCESS-PATH,C:\Program Files\nodejs\node.exe`, 0)
  hit('PROCESS-NAME-REGEX,^nod', 0)
  hit('PROCESS-NAME,asight-forwarder.exe', 1)
  hit(String.raw`PROCESS-PATH-REGEX,\\\.asight\\bin\\`, 1)
})

test('W8 a name rule is by base name, a path rule by the path; other rule types and a trailing target are not process rules', () => {
  const none = (processRules) => assert.equal(checkLoops({ processRules, ownImages: OWN }), null, processRules.join(' | '))
  none(['PROCESS-NAME,nodejs']) // a directory, not the image name
  none(['PROCESS-NAME,node']) // no .exe: not equal
  none(['DOMAIN,node.exe', 'DOMAIN-SUFFIX,nodejs', 'IP-CIDR,127.0.0.1/32'])
  assert.equal(checkLoops({ processRules: ['PROCESS-NAME,node.exe,SomeGroup'], ownImages: OWN })?.code, 'route-loop', 'a rule written with its target is still read')
  none([]) // nothing to check is fine; having no images to check against is not (below)
})

test('W8 the check cannot be vacuous: no images, a non-string image, or a regex JS cannot compile all throw', () => {
  assert.throws(() => checkLoops({ processRules: ['PROCESS-NAME,a.exe'], ownImages: [] }), /ownImages/)
  assert.throws(() => checkLoops({ processRules: ['PROCESS-NAME,a.exe'], ownImages: [''] }), /ownImages/)
  assert.throws(() => checkLoops({ processRules: ['PROCESS-NAME,a.exe'] }), /ownImages/)
  assert.throws(() => checkLoops({ processRules: ['PROCESS-PATH-REGEX,(['], ownImages: OWN }), /regex|compile|pattern/i)
})

test('W8 buildBlock given the own images refuses to produce a block when a rule would match them (the block is not written)', () => {
  const loop = [{ ...ONE[0], names: ['node.exe'] }]
  assert.throws(() => buildBlock(block(loop, { ownImages: OWN })), (e) => e instanceof RouteLoopError && e.code === 'route-loop' && e.rule === 'PROCESS-NAME,node.exe' && e.imageIndex === 0)
  assert.doesNotThrow(() => buildBlock(block(THREE, { ownImages: OWN })))
  assert.doesNotThrow(() => buildBlock(block(loop)), 'without the images there is nothing to check against (Task 8 always passes them)')
})
