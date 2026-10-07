// mihomo-rules.test.mjs — the kernel config generator (RFC 4.8 §3 · §4; acceptance W7 W8 W12). `src/netenv/mihomo/rules.mjs` is a pure function of
// data (forms, process patterns, ports, token): these tests feed it data and read what comes out. What mihomo does with the output is the real-binary
// contract's job (test/netenv/mihomo-contract.test.mjs, W57). D43 withdrew the VPN block (W9 W10 W58): its splice into the user's config and its
// global script have no test here any more. Task 7 rewrites buildForwarderConfig for proxy mode and brings W7's goldens and W8's ownImages cases back for it.
// Goldens: test/netenv/fixtures/rules/ (ASIGHT_UPDATE_GOLDEN=1 rewrites the generated ones; forwarder-off.yaml is hand-written from 4.8 §3.1 and is the oracle).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLoops, names, processRulesOf, routeFile, buildForwarderConfig } from '../../src/netenv/mihomo/rules.mjs'
import { TOKEN, ENGINE_PORT, STAND_INS, IMAGES, FORMS, SECRET, forwarder } from './fixtures/rules/inputs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RULES_SRC = path.join(HERE, '..', '..', 'src', 'netenv', 'mihomo', 'rules.mjs')
const GOLD = (n) => path.join(HERE, 'fixtures', 'rules', n)
function golden(name, actual) {
  if (process.env.ASIGHT_UPDATE_GOLDEN === '1') fs.writeFileSync(GOLD(name), actual)
  assert.equal(actual, fs.readFileSync(GOLD(name), 'utf8'), `${name}: the generator's output changed (ASIGHT_UPDATE_GOLDEN=1 rewrites it; read the diff first)`)
}

// ---- W7 ------------------------------------------------------------------------------------------------------------------------------------------

test('W7 the generator source names no harness and no lab (static scan, comments included)', () => {
  const src = fs.readFileSync(RULES_SRC, 'utf8')
  assert.deepEqual(src.match(/\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/gi) || [], [], `a harness id in ${path.basename(RULES_SRC)} (4.8 §3: it does not know them)`)
  assert.deepEqual(src.match(/asight-test|\bP2-|gstatic|generate_204|atrace/g) || [], [], `lab names, the struck public probe, the v0 prototype name in ${path.basename(RULES_SRC)}`)
})

test('W7 off is an empty route file; on is the lines, one per row, LF', () => {
  assert.equal(routeFile(null), '')
  assert.equal(routeFile([]), '')
  assert.equal(routeFile(['PROCESS-NAME,a.exe', 'PROCESS-NAME,b.exe']), 'PROCESS-NAME,a.exe\nPROCESS-NAME,b.exe\n')
  assert.throws(() => routeFile(['a\nb']), /line/)
  assert.deepEqual(processRulesOf({ pathPatterns: ['\\\\a'], names: ['x.exe'] }), ['PROCESS-PATH-REGEX,\\\\a', 'PROCESS-NAME,x.exe'])
  assert.deepEqual(processRulesOf({ pathPatterns: ['a'] }), ['PROCESS-PATH-REGEX,a'])
})

// ---- W8 ------------------------------------------------------------------------------------------------------------------------------------------

const OWN = [IMAGES.engine, IMAGES.forwarder]
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

const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze) } return o }

// ---- W12: the own forwarder's config (4.8 §3.1 own-mihomo part, §4.2) ----------------------------------------------------------------------------
// The text is JSON, which is YAML (flow style): the real mihomo reads it (W57 shape 2), and a test can parse it without a YAML library.

const config = (over) => JSON.parse(buildForwarderConfig(forwarder(over)))
const OFF_FORMS = (n) => ({ forms: FORMS.slice(0, n) })

test('W12 golden, forward only: a listener and a sub-rule per form, every sub-rule just MATCH -> the form\'s own next hop (hand-written)', () => {
  assert.equal(buildForwarderConfig(forwarder({ on: false })), fs.readFileSync(GOLD('forwarder-off.yaml'), 'utf8'))
})

test('W12 golden, on: the first form routed through the engine, the second (off, still draining) forward only', () => {
  golden('forwarder-on.yaml', buildForwarderConfig(forwarder({ on: true, forms: [FORMS[0], { ...FORMS[1], on: false }] })))
})

test('W12 one listener per form, loopback only, with its sub-rule; nothing else listens; no tun, no dns, nothing is downloaded', () => {
  for (const on of [false, true]) {
    const c = config({ on })
    assert.deepEqual(c.listeners, FORMS.map(({ g, port }) => ({ name: `asight-l-${g}`, type: 'mixed', listen: '127.0.0.1', port, rule: `in-${g}` })))
    assert.deepEqual(Object.keys(c['sub-rules']), FORMS.map(({ g }) => `in-${g}`))
    assert.equal(c['allow-lan'], false); assert.equal(c['bind-address'], '127.0.0.1')
    for (const key of ['tun', 'dns', 'port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port', 'external-ui', 'hosts', 'sniffer', 'authentication']) assert.ok(!(key in c), `no ${key}`)
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

test('W12 forward only: no engine outbound, no token, no engine port, no groups, no provider, no probe', () => {
  const text = buildForwarderConfig(forwarder({ on: false })), c = JSON.parse(text)
  assert.ok(!text.includes('asight-in-') && !text.includes(TOKEN) && !text.includes(String(ENGINE_PORT)) && !text.includes('asight-health') && !text.includes('asight-re-') && !text.includes('asight-fb-') && !text.includes('asight-sw-') && !text.includes('asight-r-'))
  assert.ok(!('proxy-groups' in c) && !('rule-providers' in c))
  for (const { g } of FORMS) assert.deepEqual(c['sub-rules'][`in-${g}`], [`MATCH,asight-up-${g}`])
  assert.deepEqual(c.proxies.map((p) => p.name), FORMS.map(({ g }) => `asight-up-${g}`))
  const noEngine = buildForwarderConfig({ forms: FORMS, controller: { port: 18899, secret: SECRET }, on: false })
  assert.equal(noEngine, text, 'forward only does not depend on the engine port or the token: the engine is not in the path')
})

test('W12 on: each routed form has the engine outbound, a re-entry outbound on its own listener, a fallback that probes it, a select at PASS, a file provider; its sub-rule starts with the loopback AND', () => {
  const c = config({ on: true }); const text = JSON.stringify(c)
  for (const { g, port } of FORMS) {
    const by = (arr, name) => arr.find((x) => x.name === name)
    assert.deepEqual(by(c.proxies, `asight-in-${g}`), { name: `asight-in-${g}`, type: 'http', server: '127.0.0.1', port: ENGINE_PORT, username: `of.${g}`, password: TOKEN })
    assert.deepEqual(by(c.proxies, `asight-re-${g}`), { name: `asight-re-${g}`, type: 'http', server: '127.0.0.1', port }, 'the re-entry point of a form is its own listener (4.8 §3.3)')
    assert.deepEqual(by(c['proxy-groups'], `asight-fb-${g}`), { name: `asight-fb-${g}`, type: 'fallback', proxies: [`asight-in-${g}`, `asight-re-${g}`], url: `http://127.0.0.1:${port}/asight-health/${g}`, interval: 30, timeout: 2000, lazy: true })
    assert.deepEqual(by(c['proxy-groups'], `asight-sw-${g}`), { name: `asight-sw-${g}`, type: 'select', proxies: ['PASS', `asight-fb-${g}`] }, 'PASS first: the daemon turns a form on and verifies it (the same two keys as the block)')
    assert.deepEqual(c['rule-providers'][`asight-r-${g}`], { type: 'file', behavior: 'classical', format: 'text', path: `./asight/route-${g}.txt`, payload: ['DOMAIN,asight-off.invalid'] })
    assert.deepEqual(c['sub-rules'][`in-${g}`], [`AND,((DST-PORT,${port}),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT`, `RULE-SET,asight-r-${g},asight-sw-${g}`, `MATCH,asight-up-${g}`])
  }
  assert.equal(text.split(TOKEN).length - 1, FORMS.length, 'the token is each engine outbound\'s password and nowhere else')
  assert.ok(!/REJECT|asight-health\.invalid|gstatic|https:/.test(text))
})

test('W12 a form\'s own on overrides the default: a draining form stays a listener that only forwards', () => {
  const c = config({ on: true, forms: [{ ...FORMS[0], on: false }, FORMS[1]] })
  assert.deepEqual(c['sub-rules'][`in-${FORMS[0].g}`], [`MATCH,asight-up-${FORMS[0].g}`])
  assert.equal(c.listeners.length, 2)
  assert.deepEqual(c['proxy-groups'].map((g) => g.name), [`asight-fb-${FORMS[1].g}`, `asight-sw-${FORMS[1].g}`])
  const allOff = config({ on: true, forms: FORMS.map((f) => ({ ...f, on: false })) })
  assert.ok(!('proxy-groups' in allOff) && !('rule-providers' in allOff) && !JSON.stringify(allOff).includes('asight-in-'))
  const none = config({ on: false, forms: FORMS.map((f) => ({ ...f, on: true })) })
  assert.ok(JSON.stringify(none).includes('asight-in-'), 'and a form can be on while the default is off')
})

test('W12 the next hop: direct, or the user\'s own proxy (http or socks5, with its credentials only in that form\'s asight-up outbound)', () => {
  const ups = [
    ['direct', { name: 'asight-up-claude-code.cli', type: 'direct' }], [null, { name: 'asight-up-claude-code.cli', type: 'direct' }], [undefined, { name: 'asight-up-claude-code.cli', type: 'direct' }],
    [{ type: 'direct' }, { name: 'asight-up-claude-code.cli', type: 'direct' }],
    [{ type: 'http', host: '127.0.0.1', port: 7897 }, { name: 'asight-up-claude-code.cli', type: 'http', server: '127.0.0.1', port: 7897 }],
    [{ type: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u', password: 'p@ss' }, { name: 'asight-up-claude-code.cli', type: 'socks5', server: 'proxy.example.com', port: 1080, username: 'u', password: 'p@ss' }],
    [{ type: 'http', host: '127.0.0.1', port: 7897, username: 'u' }, { name: 'asight-up-claude-code.cli', type: 'http', server: '127.0.0.1', port: 7897, username: 'u', password: '' }],
  ]
  for (const [upstream, want] of ups) {
    const c = config({ forms: [{ ...FORMS[0], upstream }, FORMS[1]] })
    assert.deepEqual(c.proxies.find((p) => p.name === 'asight-up-claude-code.cli'), want, JSON.stringify(upstream))
  }
  const withCreds = buildForwarderConfig(forwarder({ forms: [{ ...FORMS[0], upstream: { type: 'socks5', host: 'h', port: 1080, username: 'theuser', password: 'thepass' } }, FORMS[1]], on: true }))
  assert.equal(withCreds.split('thepass').length - 1, 1, 'the user\'s proxy password is written once')
  assert.equal(JSON.parse(withCreds).proxies.filter((p) => p.password === 'thepass').map((p) => p.name).join(), 'asight-up-claude-code.cli')
})

test('W12 every name is asight-… except the sub-rules, which are in-<g> (4.8 §3.1)', () => {
  const c = config({ on: true })
  for (const n of [...c.proxies.map((p) => p.name), ...c['proxy-groups'].map((g) => g.name), ...Object.keys(c['rule-providers']), ...c.listeners.map((l) => l.name)]) assert.match(n, /^asight-/, n)
})

test('W12 refused, not written: no forms, duplicate ids or ports, a port that is the engine\'s or the controller\'s, a weak secret, a bad next hop, on not a boolean', () => {
  const bad = (what, over, re) => assert.throws(() => buildForwarderConfig(forwarder(over)), re, what)
  bad('no forms', { forms: [] }, /form/)
  bad('duplicate id', { forms: [FORMS[0], FORMS[0]] }, /duplicate/)
  bad('bad id', { forms: [{ ...FORMS[0], g: 'a b' }] }, /id/)
  bad('two forms on one port', { forms: [FORMS[0], { ...FORMS[1], port: FORMS[0].port }] }, /port/)
  bad('a form on the controller\'s port', { forms: [{ ...FORMS[0], port: 18899 }] }, /port/)
  bad('a form on the engine\'s port', { forms: [{ ...FORMS[0], port: ENGINE_PORT }] }, /port/)
  bad('the controller on the engine\'s port', { controller: { port: ENGINE_PORT, secret: SECRET } }, /port/)
  bad('a port that is not one', { forms: [{ ...FORMS[0], port: 70000 }] }, /port/)
  bad('a short secret', { controller: { port: 18899, secret: 'abc' } }, /secret/)
  bad('no controller', { controller: undefined }, /controller/)
  bad('on missing', { on: undefined }, /\bon\b/)
  bad('a next hop of another type', { forms: [{ ...FORMS[0], upstream: { type: 'vmess', host: 'h', port: 1 } }] }, /upstream/)
  bad('a next hop with no host', { forms: [{ ...FORMS[0], upstream: { type: 'http', host: '', port: 1 } }] }, /upstream/)
  bad('a next hop with a bad port', { forms: [{ ...FORMS[0], upstream: { type: 'http', host: 'h', port: 0 } }] }, /port/)
  assert.throws(() => buildForwarderConfig(forwarder({ on: true, token: undefined })), /token/, 'a routed form needs the token')
  assert.throws(() => buildForwarderConfig(forwarder({ on: true, enginePort: undefined })), /port/, 'and the engine port')
})

test('W12 pure: the input is not touched, the same input gives the same text', () => {
  const input = deepFreeze(structuredClone(forwarder({ on: true })))
  assert.equal(buildForwarderConfig(input), buildForwarderConfig(input))
  JSON.parse(buildForwarderConfig(input)) // valid JSON, so valid YAML
})
