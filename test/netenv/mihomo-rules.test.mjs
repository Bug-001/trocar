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
  const withdrawn = ['asight-' + 'sw', 'asight-' + 'r-', 'route' + 'File', 'entries' + 'Of', 'RULE-' + 'SET', 'PA' + 'SS'] // written in pieces: the plan's done-check greps the tree for these names and finds none
  assert.deepEqual(src.match(new RegExp(withdrawn.join('|'), 'g')) || [], [], 'the withdrawn select, provider and route file are gone (D43)')
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

const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze) } return o }

// ---- W12 / W7: the own kernel's config (4.8 §3.1 · §3.2 · §4.1) --------------------------------------------------------------------------------
// The text is JSON, which is YAML (flow style): the real mihomo reads it (W57), and a test can parse it without a YAML library.

const config = (over) => JSON.parse(buildForwarderConfig(forwarder(over)))
const by = (arr, name) => arr.find((x) => x.name === name)

test('W7 golden, forward only (hand-written from 4.8 §3.1): every group on its listener with users, ① ② ③ ⑤ ⑥ in its sub-rule, no engine, no fallback', () => {
  assert.equal(buildForwarderConfig(forwarder({ groups: [off(CC_GROUP), off(CODEX_GROUP)] })), fs.readFileSync(GOLD('forwarder-off.yaml'), 'utf8'))
})

test('W7 golden, on: a two-form group (Claude Code\'s settings.json: cli and vscode share one listener, one port, one upstream)', () => {
  golden('forwarder-on.yaml', buildForwarderConfig(forwarder({ groups: [CC_GROUP, off(CODEX_GROUP)] })))
})

test('W7 golden, on with a bypass table and the user\'s credentialed http proxy, a form with no process rule, a host-tree form, a group that takes no credentials', () => {
  golden('forwarder-bypass.yaml', buildForwarderConfig(forwarder({ groups: [CODEX_GROUP, DSH_GROUP, KIMI_GROUP, DESKTOP_GROUP] })))
})

test('W7 the sub-rule of a group that is on, in the order of 4.8 §3.1: ① loopback AND ② bypass re-entered ③ re-entered to the upstream ④ each form\'s process rules ⑤ bypass ⑥ the upstream', () => {
  const c = config({ groups: [CODEX_GROUP, CC_GROUP] })
  const sub = c['sub-rules']['in-codex.env']
  assert.equal(sub[0], 'AND,((DST-PORT,18802),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT')
  assert.deepEqual(sub.slice(1, 5), ['DOMAIN-REGEX,^[^.]+$', 'DOMAIN-SUFFIX,corp.example.com', 'IP-CIDR,10.0.0.0/8,no-resolve', 'DOMAIN,gateway.internal'].map((b) => `AND,((IN-USER,re.codex.env),(${b})),DIRECT`))
  assert.equal(sub[5], 'IN-USER,re.codex.env,asight-up-codex.env')
  assert.equal(sub[6], 'PROCESS-PATH-REGEX,\\\\OpenAI\\\\Codex\\\\bin\\\\[^\\\\]*\\\\codex\\.exe,asight-fb-codex.app')
  assert.deepEqual(sub.slice(7), ['DOMAIN-REGEX,^[^.]+$,DIRECT', 'DOMAIN-SUFFIX,corp.example.com,DIRECT', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'DOMAIN,gateway.internal,DIRECT', 'MATCH,asight-up-codex.env'])
  const cc = c['sub-rules']['in-claude-code.settings']
  assert.equal(cc.length, 1 + 1 + 3 + 1, 'no bypass: ① ③ the three process rules of the two forms (two paths of the cli, one of the vscode) ⑥')
  assert.deepEqual(cc.map((l) => l.split(',').pop()), ['DIRECT', 'asight-up-claude-code.settings', 'asight-fb-claude-code.cli', 'asight-fb-claude-code.cli', 'asight-fb-claude-code.vscode', 'asight-up-claude-code.settings'])
})

test('W7 a two-form group: one listener, one port, one asight-up and one asight-re; asight-in and asight-fb per form (of.<form>), the fallback probing the group\'s port with the form\'s own path', () => {
  const c = config({ groups: [CC_GROUP] })
  assert.deepEqual(c.listeners.map((l) => [l.name, l.port, l.rule]), [['asight-l-claude-code.settings', 18801, 'in-claude-code.settings']])
  for (const f of ['claude-code.cli', 'claude-code.vscode']) {
    assert.deepEqual(by(c.proxies, `asight-in-${f}`), { name: `asight-in-${f}`, type: 'http', server: '127.0.0.1', port: ENGINE_PORT, username: `of.${f}`, password: TOKEN })
    assert.deepEqual(by(c['proxy-groups'], `asight-fb-${f}`), { name: `asight-fb-${f}`, type: 'fallback', proxies: [`asight-in-${f}`, 'asight-re-claude-code.settings'], url: `http://127.0.0.1:18801/asight-health/${f}`, interval: 30, timeout: 2000, lazy: true })
  }
  assert.deepEqual(by(c.proxies, 'asight-re-claude-code.settings'), { name: 'asight-re-claude-code.settings', type: 'http', server: '127.0.0.1', port: 18801, username: 're.claude-code.settings', password: LISTENER_TOKEN })
  assert.deepEqual(by(c.proxies, 'asight-up-claude-code.settings'), { name: 'asight-up-claude-code.settings', type: 'direct' })
  assert.equal(c.proxies.length, 4); assert.equal(c['proxy-groups'].length, 2)
  assert.ok(!('expected-status' in c['proxy-groups'][0]), 'any answer counts as alive')
  assert.equal(probeUrl(18801, 'claude-code.cli'), 'http://127.0.0.1:18801/asight-health/claude-code.cli')
})

test('W12 one listener per group, loopback only, with its users and its sub-rule; nothing else listens; no tun, no dns, no unified-delay, nothing is downloaded', () => {
  for (const on of [false, true]) {
    const groups = [CC_GROUP, CODEX_GROUP].map((g) => ({ ...g, on }))
    const c = config({ groups })
    assert.deepEqual(c.listeners.map(({ name, type, listen, port, rule }) => [name, type, listen, port, rule]), groups.map(({ g, port }) => [`asight-l-${g}`, 'mixed', '127.0.0.1', port, `in-${g}`]))
    for (const l of c.listeners) assert.deepEqual(l.users, [{ username: l.name.slice(9), password: LISTENER_TOKEN }, { username: `re.${l.name.slice(9)}`, password: LISTENER_TOKEN }], 'the group\'s own user and the re-entry user, one password')
    assert.deepEqual(Object.keys(c['sub-rules']), groups.map(({ g }) => `in-${g}`))
    assert.equal(c['allow-lan'], false); assert.equal(c['bind-address'], '127.0.0.1')
    for (const key of ['tun', 'dns', 'unified-delay', 'port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port', 'external-ui', 'hosts', 'sniffer', 'authentication', 'rule-providers']) assert.ok(!(key in c), `no ${key}`)
    assert.equal(c['find-process-mode'], 'always')
    assert.equal(c.mode, 'rule')
    assert.equal(c['geo-auto-update'], false)
    assert.deepEqual(Object.values(c['geox-url']), Array(4).fill('http://127.0.0.1:9/g'), 'the geodata URLs point at the discard port: a rule that wants a database cannot reach out for one')
    assert.deepEqual(c.profile, { 'store-selected': false, 'store-fake-ip': false }, 'no selection is remembered across restarts: the daemon says what is on')
    assert.equal(c['log-level'], 'warning', 'no connection is logged (a connection line names the user\'s hosts)')
    assert.equal(c.rules.length, 1); assert.equal(c.rules[0], 'MATCH,DIRECT')
  }
})

test('W12 the controller listens on the port it was given on 127.0.0.1, with the secret it was given', () => {
  const c = config({ controller: { port: 20111, secret: 'z'.repeat(24) } })
  assert.equal(c['external-controller'], '127.0.0.1:20111'); assert.equal(c.secret, 'z'.repeat(24))
  assert.ok(!('external-controller-tls' in c) && !('external-controller-cors' in c))
  assert.notEqual(config({ controller: { port: 20112, secret: 'y'.repeat(24) } }).secret, c.secret, 'both come from the caller (random per run), not from this file')
})

test('W12 forward only (every group off): no engine outbound, no ingress token, no engine port, no fallback, no re-entry outbound, no probe; the text does not depend on them', () => {
  const groups = [off(CC_GROUP), off(CODEX_GROUP)]
  const text = buildForwarderConfig(forwarder({ groups })), c = JSON.parse(text)
  assert.ok(!text.includes('asight-in-') && !text.includes(TOKEN) && !text.includes(String(ENGINE_PORT)) && !text.includes('asight-health') && !text.includes('asight-re-') && !text.includes('asight-fb-'))
  assert.ok(!('proxy-groups' in c))
  assert.deepEqual(c.proxies.map((p) => p.name), groups.map(({ g }) => `asight-up-${g}`))
  const noEngine = buildForwarderConfig({ groups, controller: { port: 18899, secret: SECRET }, listenerToken: LISTENER_TOKEN, ownImages: OWN_IMAGES })
  assert.equal(noEngine, text, 'forward only does not depend on the engine port or the ingress token: the engine is not in the path')
})

test('W12 a group is on or off as one: the forms of an off group have no asight-in-* and no asight-fb-*; a group that is on has them for every form; a reload changes the other group\'s text by no byte (W55)', () => {
  const both = buildForwarderConfig(forwarder({ groups: [CC_GROUP, CODEX_GROUP] }))
  const ccOff = buildForwarderConfig(forwarder({ groups: [off(CC_GROUP), CODEX_GROUP] }))
  const c = JSON.parse(ccOff)
  assert.ok(!JSON.stringify(c).includes('asight-in-claude-code') && !JSON.stringify(c).includes('asight-fb-claude-code'))
  assert.ok(JSON.stringify(c).includes('asight-in-codex.app'))
  // W55: everything that belongs to the group that stayed on is the same before and after, entry by entry
  const mine = (text) => { const j = JSON.parse(text); return JSON.stringify([j.listeners, j.proxies, j['proxy-groups'], j['sub-rules']].map((part) => (Array.isArray(part) ? part.filter((x) => /codex/.test(x.name)) : Object.fromEntries(Object.entries(part).filter(([k]) => /codex/.test(k)))))) }
  assert.equal(mine(ccOff), mine(both), 'codex\'s listener, proxies, fallback and sub-rule are the same when claude-code goes off')
  assert.ok(mine(both).length > 900)
  const allOff = config({ groups: [off(CC_GROUP), off(CODEX_GROUP)] })
  assert.ok(!('proxy-groups' in allOff) && !JSON.stringify(allOff).includes('asight-in-'))
})

test('W12 on: the token is each engine outbound\'s password and nowhere else; the listener password is the users\' and the re-entry outbound\'s', () => {
  const text = buildForwarderConfig(forwarder({ groups: [CC_GROUP, CODEX_GROUP] }))
  assert.equal(text.split(TOKEN).length - 1, 3, 'cli, vscode and codex.app: three engine outbounds')
  assert.equal(text.split(LISTENER_TOKEN).length - 1, 2 * 2 + 2, 'two users on each of two listeners, and the re-entry outbound of each')
  assert.ok(!/REJECT|asight-health\.invalid|gstatic|https:/.test(text))
})

test('W12 the upstream: direct, or the user\'s own proxy (http or socks5, with its credentials only in that group\'s asight-up outbound)', () => {
  const ups = [
    ['direct', { name: 'asight-up-claude-code.settings', type: 'direct' }], [null, { name: 'asight-up-claude-code.settings', type: 'direct' }], [undefined, { name: 'asight-up-claude-code.settings', type: 'direct' }],
    [{ type: 'direct' }, { name: 'asight-up-claude-code.settings', type: 'direct' }],
    [{ type: 'http', host: '127.0.0.1', port: 7897 }, { name: 'asight-up-claude-code.settings', type: 'http', server: '127.0.0.1', port: 7897 }],
    [{ type: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u', password: 'p@ss' }, { name: 'asight-up-claude-code.settings', type: 'socks5', server: 'proxy.example.com', port: 1080, username: 'u', password: 'p@ss' }],
    [{ type: 'http', host: '127.0.0.1', port: 7897, username: 'u' }, { name: 'asight-up-claude-code.settings', type: 'http', server: '127.0.0.1', port: 7897, username: 'u', password: '' }],
  ]
  for (const [upstream, want] of ups) assert.deepEqual(by(config({ groups: [{ ...CC_GROUP, upstream }, CODEX_GROUP] }).proxies, 'asight-up-claude-code.settings'), want, JSON.stringify(upstream))
  const withCreds = buildForwarderConfig(forwarder({ groups: [{ ...CC_GROUP, upstream: { type: 'socks5', host: 'h', port: 1080, username: 'theuser', password: 'thepass' } }, off(CODEX_GROUP)] }))
  assert.equal(withCreds.split('thepass').length - 1, 1, 'the user\'s proxy password is written once')
  assert.equal(JSON.parse(withCreds).proxies.filter((p) => p.password === 'thepass').map((p) => p.name).join(), 'asight-up-claude-code.settings')
})

test('W12 every name is asight-… except the sub-rules, which are in-<g>; names() lists them', () => {
  const c = config({ groups: [CC_GROUP, CODEX_GROUP] })
  for (const n of [...c.proxies.map((p) => p.name), ...c['proxy-groups'].map((g) => g.name), ...c.listeners.map((l) => l.name)]) assert.match(n, /^asight-/, n)
  assert.deepEqual(names('claude-code.cli'), { listener: 'asight-l-claude-code.cli', rule: 'in-claude-code.cli', in: 'asight-in-claude-code.cli', re: 'asight-re-claude-code.cli', fb: 'asight-fb-claude-code.cli', up: 'asight-up-claude-code.cli', probePath: '/asight-health/claude-code.cli', ofUser: 'of.claude-code.cli', reUser: 're.claude-code.cli' })
})

test('W12 refused, not written: no groups, duplicate ids or ports, a port that is the engine\'s or the controller\'s, a weak secret, a bad upstream, a missing on, no tokens', () => {
  const bad = (what, over, re) => assert.throws(() => buildForwarderConfig(forwarder(over)), re, what)
  bad('no groups', { groups: [] }, /group/)
  bad('duplicate group id', { groups: [CC_GROUP, CC_GROUP] }, /duplicate|port/)
  bad('duplicate form id', { groups: [CC_GROUP, { ...CODEX_GROUP, forms: [{ f: 'claude-code.cli', rules: ['PROCESS-NAME,x.exe'] }] }] }, /duplicate form/)
  bad('bad group id', { groups: [{ ...CC_GROUP, g: 'a b' }] }, /id/)
  bad('bad form id', { groups: [{ ...CC_GROUP, forms: [{ f: 'a:b', rules: [] }] }] }, /id/)
  bad('two groups on one port', { groups: [CC_GROUP, { ...CODEX_GROUP, port: CC_GROUP.port }] }, /port/)
  bad('a group on the controller\'s port', { groups: [{ ...CC_GROUP, port: 18899 }] }, /port/)
  bad('a group on the engine\'s port', { groups: [{ ...CC_GROUP, port: ENGINE_PORT }] }, /port/)
  bad('the controller on the engine\'s port', { controller: { port: ENGINE_PORT, secret: SECRET } }, /port/)
  bad('a port that is not one', { groups: [{ ...CC_GROUP, port: 70000 }] }, /port/)
  bad('a short secret', { controller: { port: 18899, secret: 'abc' } }, /secret/)
  bad('no controller', { controller: undefined }, /controller/)
  bad('on missing', { groups: [{ ...CC_GROUP, on: undefined }] }, /\bon\b/)
  bad('a group with no forms', { groups: [{ ...CC_GROUP, forms: [] }] }, /form/)
  bad('two forms of a group with no process rule', { groups: [{ ...DSH_GROUP, forms: [{ f: 'a.one', rules: [] }, { f: 'a.two', rules: [] }] }] }, /no process rule/)
  bad('a rule that is not a process rule', { groups: [{ ...CC_GROUP, forms: [{ f: 'claude-code.cli', rules: ['DOMAIN,x.example'] }] }] }, /process rule/)
  bad('an upstream of another type', { groups: [{ ...CC_GROUP, upstream: { type: 'vmess', host: 'h', port: 1 } }] }, /upstream/)
  bad('an upstream with no host', { groups: [{ ...CC_GROUP, upstream: { type: 'http', host: '', port: 1 } }] }, /upstream/)
  bad('an upstream with a bad port', { groups: [{ ...CC_GROUP, upstream: { type: 'http', host: 'h', port: 0 } }] }, /port/)
  bad('a group on the engine without its token', { token: undefined }, /token/)
  bad('a group on without the engine port', { enginePort: undefined }, /engine port/)
  bad('a listener with users and no listener token', { listenerToken: undefined }, /listener token/)
  bad('the two secrets the same', { listenerToken: TOKEN }, /two secrets/)
})

test('W12 pure: the input is not touched, the same input gives the same text, and it is JSON', () => {
  const input = deepFreeze(structuredClone(forwarder({ groups: [CC_GROUP, CODEX_GROUP, DSH_GROUP, KIMI_GROUP, DESKTOP_GROUP] })))
  assert.equal(buildForwarderConfig(input), buildForwarderConfig(input))
  JSON.parse(buildForwarderConfig(input)) // valid JSON, so valid YAML
})

// ---- W70: the listener's credentials (4.8 §3.2) ---------------------------------------------------------------------------------------------------

test('W70 a group that takes no credentials (auth:false) has no users and no re-entry rules; its re-entry outbound carries no login; an upstream with credentials is refused as form-unsupported, one without is fine', () => {
  const c = config({ groups: [DESKTOP_GROUP] })
  const l = c.listeners[0]
  assert.ok(!('users' in l), 'no users: the port takes whoever connects')
  assert.deepEqual(by(c.proxies, 'asight-re-claude-code.desktop'), { name: 'asight-re-claude-code.desktop', type: 'http', server: '127.0.0.1', port: 18805 })
  assert.deepEqual(c['sub-rules']['in-claude-code.desktop'].map((r) => r.split(',')[0]), ['AND', 'PROCESS-PATH-REGEX', 'MATCH'], 'no IN-USER rule: nobody can be told apart by a user that does not exist')
  assert.ok(!JSON.stringify(c).includes(LISTENER_TOKEN), 'and no listener password is written for it')
  assert.ok(buildForwarderConfig(forwarder({ groups: [DESKTOP_GROUP], listenerToken: undefined })), 'a config whose groups all take no credentials needs no listener token')
  assert.throws(() => buildForwarderConfig(forwarder({ groups: [{ ...DESKTOP_GROUP, upstream: { type: 'http', host: 'proxy.example.com', port: 8080, username: 'u', password: 'p' } }] })), (e) => e instanceof FormUnsupportedError && e.code === 'form-unsupported')
  assert.ok(buildForwarderConfig(forwarder({ groups: [{ ...DESKTOP_GROUP, upstream: { type: 'http', host: 'proxy.example.com', port: 8080 } }] })), 'an upstream without credentials is fine')
  assert.ok(buildForwarderConfig(forwarder({ groups: [{ ...CC_GROUP, upstream: { type: 'http', host: 'proxy.example.com', port: 8080, username: 'u', password: 'p' } }] })), 'a group that takes credentials may have one with them')
})

test('W70 the host tree: only the named process to the named hosts goes to the engine, per rule per host; the form without a host set is a plain process rule', () => {
  const sub = config({ groups: [KIMI_GROUP] })['sub-rules']['in-kimi-code.vscode']
  const rule = KIMI_GROUP.forms[0].rules[0]
  assert.deepEqual(sub.filter((l) => /asight-fb-/.test(l)), ['api.kimi.com', 'api.moonshot.cn'].map((h) => `AND,((${rule}),(DOMAIN-SUFFIX,${h})),asight-fb-kimi-code.vscode`))
  assert.equal(sub.at(-1), 'MATCH,asight-up-kimi-code.vscode', 'every other connection of that program is only forwarded')
  assert.ok(!sub.some((l) => l === `${rule},asight-fb-kimi-code.vscode`), 'the process rule alone never routes to the engine for this form')
  assert.throws(() => buildForwarderConfig(forwarder({ groups: [{ ...KIMI_GROUP, forms: [{ f: 'kimi-code.vscode', rules: [], hosts: ['api.kimi.com'] }] }] })), /hosts but no process rule/)
  assert.throws(() => buildForwarderConfig(forwarder({ groups: [{ ...KIMI_GROUP, forms: [{ ...KIMI_GROUP.forms[0], hosts: [] }] }] })), /hosts/)
  assert.throws(() => buildForwarderConfig(forwarder({ groups: [{ ...KIMI_GROUP, forms: [{ ...KIMI_GROUP.forms[0], hosts: ['a,b'] }] }] })), /hosts/)
})

test('W7 a form with no process rule takes every connection of its port, last among the group\'s process rules; the group\'s other forms keep theirs before it', () => {
  const sub = config({ groups: [DSH_GROUP] })['sub-rules']['in-deepseek-dsh.env']
  assert.deepEqual(sub, ['AND,((DST-PORT,18803),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT', 'IN-USER,re.deepseek-dsh.env,asight-up-deepseek-dsh.env', 'PROCESS-NAME,DeepSeek Harness.exe,asight-fb-deepseek-dsh.desktop', 'MATCH,asight-fb-deepseek-dsh.cli', 'MATCH,asight-up-deepseek-dsh.env'])
})

// ---- W72: the bypass table (4.8 §2.2 · §3.1) -------------------------------------------------------------------------------------------------------

test('W72 each bypass entry kind is one mihomo rule; a bad value is refused, not written', () => {
  assert.deepEqual(BYPASS.map((e) => bypassRuleOf(e)), ['DOMAIN-REGEX,^[^.]+$', 'DOMAIN-SUFFIX,corp.example.com', 'IP-CIDR,10.0.0.0/8,no-resolve', 'DOMAIN,gateway.internal'], 'inside a logic rule: no target')
  assert.deepEqual(BYPASS.map((e) => bypassRuleOf(e, 'DIRECT')), ['DOMAIN-REGEX,^[^.]+$,DIRECT', 'DOMAIN-SUFFIX,corp.example.com,DIRECT', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'DOMAIN,gateway.internal,DIRECT'], 'as a rule line: the target, then an IP rule\'s no-resolve (the other order is not a rule mihomo reads)')
  for (const bad of [{ kind: 'domain', value: 'a,b' }, { kind: 'domain-suffix', value: '' }, { kind: 'domain-suffix', value: 'a b' }, { kind: 'ip-cidr', value: '10.0.0.0' }, { kind: 'ip-cidr', value: '300.0.0.0/8' }, { kind: 'ip-cidr', value: '10.0.0.0/33' }, { kind: 'regex', value: 'x' }, null]) {
    assert.throws(() => bypassRuleOf(bad), TypeError, JSON.stringify(bad))
  }
})

test('W72 a bypass entry is in ② and ⑤ of its group, once each, and nowhere in a group without one; the re-entered ones are AND IN-USER; the plain ones are just the rule', () => {
  const c = config({ groups: [CODEX_GROUP, CC_GROUP] })
  for (const [i, e] of BYPASS.entries()) {
    const sub = c['sub-rules']['in-codex.env'], inner = `AND,((IN-USER,re.codex.env),(${bypassRuleOf(e)})),DIRECT`, line = bypassRuleOf(e, 'DIRECT')
    assert.equal(sub.filter((l) => l === inner).length, 1, `② ${i}`)
    assert.equal(sub.filter((l) => l === line).length, 1, `⑤ ${i}`)
    assert.ok(sub.indexOf(inner) < sub.indexOf('IN-USER,re.codex.env,asight-up-codex.env'), '② before ③')
    assert.ok(sub.indexOf('IN-USER,re.codex.env,asight-up-codex.env') < sub.indexOf(line), '③ before ⑤')
  }
  assert.ok(!c['sub-rules']['in-claude-code.settings'].some((l) => /DOMAIN|IP-CIDR,10/.test(l)), 'another group\'s bypass table is not this group\'s')
})
