// mihomo-rules.test.mjs — the kernel config generator (RFC 4.8 §3 · §4; acceptance W7 W8 W12 W70 W72). `src/netenv/mihomo/rules.mjs` is a pure function of
// data (groups, forms, process rules, ports, tokens): these tests feed it data and read what comes out. What mihomo does with the output is the real-binary
// contract's job (test/netenv/mihomo-contract.test.mjs, W57 W70 W72). D43 withdrew the VPN block (W9 W10 W58): nothing here splices into a user's config.
// Goldens: test/netenv/fixtures/rules/ (ASIGHT_UPDATE_GOLDEN=1 rewrites the generated ones; forwarder-off.yaml is hand-written from 4.8 §3.1 and is the oracle).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLoops, RouteLoopError, FormUnsupportedError, names, probeUrl, processRulesOf, bypassRuleOf, buildForwarderConfig } from '../../src/netenv/mihomo/rules.mjs'
import { TOKEN, LISTENER_TOKEN, ENGINE_PORT, STAND_INS, IMAGES, OWN_IMAGES, SECRET, BYPASS, CC_GROUP, CODEX_GROUP, DSH_GROUP, KIMI_GROUP, DESKTOP_GROUP, forwarder } from './fixtures/rules/inputs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RULES_SRC = path.join(HERE, '..', '..', 'src', 'netenv', 'mihomo', 'rules.mjs')
const GOLD = (n) => path.join(HERE, 'fixtures', 'rules', n)
function golden(name, actual) {
  if (process.env.ASIGHT_UPDATE_GOLDEN === '1') fs.writeFileSync(GOLD(name), actual)
  assert.equal(actual, fs.readFileSync(GOLD(name), 'utf8'), `${name}: the generator's output changed (ASIGHT_UPDATE_GOLDEN=1 rewrites it; read the diff first)`)
}
const off = (g) => ({ ...g, on: false })

// ---- W7 ------------------------------------------------------------------------------------------------------------------------------------------

// How mihomo reads a process rule (4.8 §2.3, rules/common/process.go): a regex is case-insensitive and unanchored over the whole image path, a name is compared to the base name.
const baseName = (p) => p.split(/[\\/]/).pop()
function matches(line, image) {
  const i = line.indexOf(',')
  const type = line.slice(0, i), payload = line.slice(i + 1)
  if (type === 'PROCESS-PATH-REGEX') return new RegExp(payload, 'i').test(image)
  if (type === 'PROCESS-NAME') return baseName(image).toLowerCase() === payload.toLowerCase()
  throw new Error(`not a process rule: ${line}`)
}

test('W7 routing: the process rules route the agents and no rule matches Claude Desktop or any Code.exe (4.8 §2.3, §3.5)', () => {
  const lines = STAND_INS.flatMap(processRulesOf)
  assert.ok(lines.length >= 7)
  for (const [what, image] of Object.entries({ ccNpm: IMAGES.ccNpm, ccNative: IMAGES.ccNative, ccVscode: IMAGES.ccVscode, codexApp: IMAGES.codexApp, kimi: IMAGES.kimi, hermes: IMAGES.hermes })) {
    assert.ok(lines.some((l) => matches(l, image)), `${what} is routed (the check below is not vacuous)`)
  }
  for (const [what, image] of Object.entries({ claudeDesktop: IMAGES.claudeDesktop, codeUser: IMAGES.codeUser, codeSystem: IMAGES.codeSystem, codeInsiders: IMAGES.codeInsiders })) {
    assert.deepEqual(lines.filter((l) => matches(l, image)), [], `${what}: no rule matches`)
  }
  assert.ok(matches('PROCESS-PATH-REGEX,Microsoft VS Code', IMAGES.codeUser) && !matches('PROCESS-NAME,claude.exe', IMAGES.codeUser), 'the matcher can say yes and no')
})

test('W7 the generated config: no rule matches Claude Desktop or any Code.exe unless that program is the group the user named (the generated lines, read like mihomo reads them)', () => {
  const lines = (g) => JSON.parse(buildForwarderConfig(forwarder({ groups: [g] })))['sub-rules'][`in-${g.g}`].filter((l) => /^PROCESS-/.test(l))
  const all = [CC_GROUP, CODEX_GROUP].flatMap(lines)
  assert.ok(all.length >= 4 && all.some((l) => matches(l.split(',').slice(0, 2).join(','), IMAGES.ccNpm)))
  for (const image of [IMAGES.claudeDesktop, IMAGES.codeUser, IMAGES.codeSystem, IMAGES.codeInsiders]) assert.deepEqual(all.filter((l) => matches(l.split(',').slice(0, 2).join(','), image)), [], image)
})

test('W7 the generator source names no harness and no lab (static scan, comments included)', () => {
  const src = fs.readFileSync(RULES_SRC, 'utf8')
  assert.deepEqual(src.match(/\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/gi) || [], [], `a harness id in ${path.basename(RULES_SRC)} (4.8 §3: it does not know them)`)
  assert.deepEqual(src.match(/asight-test|\bP2-|gstatic|generate_204|atrace/g) || [], [], `lab names, the struck public probe, the v0 prototype name in ${path.basename(RULES_SRC)}`)
  assert.deepEqual(src.match(/asight-sw|asight-r-|routeFile|entriesOf|RULE-SET|PASS/g) || [], [], 'the withdrawn select, provider and route file are gone (D43)')
})

test('W7 processRulesOf: the path regexes first, then the image names', () => {
  assert.deepEqual(processRulesOf({ pathPatterns: ['\\\\a'], names: ['x.exe'] }), ['PROCESS-PATH-REGEX,\\\\a', 'PROCESS-NAME,x.exe'])
  assert.deepEqual(processRulesOf({ pathPatterns: ['a'] }), ['PROCESS-PATH-REGEX,a'])
  assert.throws(() => processRulesOf({ pathPatterns: ['(?i)a'] }), /inline flag/)
  assert.throws(() => processRulesOf({ pathPatterns: ['a,b'] }), /comma/)
})

// ---- W8 ------------------------------------------------------------------------------------------------------------------------------------------

const OWN = OWN_IMAGES
const RULES_OF = (groups) => groups.flatMap(processRulesOf)

test('W8 the generated rules do not match the engine or the forwarder: null', () => {
  assert.equal(checkLoops({ processRules: RULES_OF(STAND_INS), ownImages: OWN }), null)
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
  hit(String.raw`PROCESS-PATH-REGEX,\\\.asight\\collector\\kernel\\`, 1)
})

test('W8 a name rule is by base name, a path rule by the path; other rule types and a trailing target are not process rules', () => {
  const none = (processRules) => assert.equal(checkLoops({ processRules, ownImages: OWN }), null, processRules.join(' | '))
  none(['PROCESS-NAME,nodejs']) // a directory, not the image name
  none(['PROCESS-NAME,node']) // no .exe: not equal
  none(['DOMAIN,node.exe', 'DOMAIN-SUFFIX,nodejs', 'IP-CIDR,127.0.0.1/32'])
  assert.equal(checkLoops({ processRules: ['PROCESS-NAME,node.exe,SomeGroup'], ownImages: OWN })?.code, 'route-loop', 'a rule written with its target is still read')
  none([]) // nothing to check is fine; having no images to check against is not (below)
})

test('W8 RouteLoopError carries the code, the rule and which image; its words say that no config is written; an upstream form of it names the upstream', () => {
  const e = new RouteLoopError(checkLoops({ processRules: ['PROCESS-NAME,node.exe'], ownImages: OWN }))
  assert.ok(e instanceof Error)
  assert.deepEqual([e.name, e.code, e.rule, e.imageIndex], ['RouteLoopError', 'route-loop', 'PROCESS-NAME,node.exe', 0])
  assert.match(e.message, /PROCESS-NAME,node\.exe/)
  assert.match(e.message, /no config is written/)
  assert.doesNotMatch(e.message, /block/, 'the VPN block is gone (D43)')
  const u = new RouteLoopError({ upstream: '127.0.0.1:18801' })
  assert.deepEqual([u.code, u.upstream, u.rule], ['route-loop', '127.0.0.1:18801', null])
  assert.match(u.message, /127\.0\.0\.1:18801.*no config is written/)
})

test('W8 the check cannot be vacuous: no images, a non-string image, or a regex JS cannot compile all throw', () => {
  assert.throws(() => checkLoops({ processRules: ['PROCESS-NAME,a.exe'], ownImages: [] }), /ownImages/)
  assert.throws(() => checkLoops({ processRules: ['PROCESS-NAME,a.exe'], ownImages: [''] }), /ownImages/)
  assert.throws(() => checkLoops({ processRules: ['PROCESS-NAME,a.exe'] }), /ownImages/)
  assert.throws(() => checkLoops({ processRules: ['PROCESS-PATH-REGEX,(['], ownImages: OWN }), /regex|compile|pattern/i)
})

test('W8 buildForwarderConfig: a process rule that matches the engine or the kernel is a RouteLoopError and no text; ownImages is required (a missing one is a TypeError, null is the fixture\'s explicit word)', () => {
  const loop = (rules) => forwarder({ groups: [{ ...CC_GROUP, forms: [{ f: 'claude-code.cli', rules }] }] })
  for (const [rules, index] of [[['PROCESS-NAME,node.exe'], 0], [['PROCESS-PATH-REGEX,nodejs'], 0], [['PROCESS-NAME,asight-forwarder.exe'], 1], [processRulesOf(STAND_INS[0]).concat(['PROCESS-PATH-REGEX,.*']), 0]]) {
    assert.throws(() => buildForwarderConfig(loop(rules)), (e) => e instanceof RouteLoopError && e.code === 'route-loop' && e.imageIndex === index && !('text' in e), rules.join('|'))
  }
  assert.throws(() => buildForwarderConfig(forwarder({ ownImages: undefined })), TypeError)
  assert.throws(() => { const { ownImages, ...rest } = forwarder(); buildForwarderConfig(rest) }, /ownImages is required/)
  assert.throws(() => buildForwarderConfig(forwarder({ ownImages: [] })), /ownImages/)
  assert.ok(buildForwarderConfig({ ...loop(['PROCESS-NAME,node.exe']), ownImages: null }), 'null: no engine to loop back to, the check is skipped on purpose')
  assert.throws(() => buildForwarderConfig(loop(['PROCESS-NAME,node.exe'])), RouteLoopError, 'the same rule with real images still throws')
})

test('W8 an upstream that is the kernel\'s or the engine\'s own port is a RouteLoopError (the group is not routed); another loopback port, or a remote host on that port, is not', () => {
  const up = (host, port, over = {}) => forwarder({ groups: [{ ...CC_GROUP, upstream: { type: 'http', host, port }, ...over }], ...over })
  for (const port of [18801, ENGINE_PORT, 18899]) assert.throws(() => buildForwarderConfig(up('127.0.0.1', port)), (e) => e instanceof RouteLoopError && e.upstream && e.upstream.includes(String(port)), `127.0.0.1:${port}`)
  assert.throws(() => buildForwarderConfig(up('localhost', 18801)), RouteLoopError)
  assert.ok(buildForwarderConfig(up('127.0.0.1', 7897)))
  assert.ok(buildForwarderConfig(up('proxy.example.com', 18801)), 'a remote proxy that happens to use the number is somebody else\'s')
})
