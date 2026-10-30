// capture-page.test.mjs — the 采集 page's row controls and its fidelity rules (1.9 §开关 · §保真边界 · §采集记录; 1.5 K-25..K-27). The
// documents are the C.3 sample of spec 1.6 with the fields each axis varies; the control-plane answer has the 4.4 shape. Contract only:
// which control a row carries, which command its technical details hold, what never reaches the page.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pageHtml } from '../../src/web/v2/capture/capture-view.mjs'
import { pageLogHtml } from '../../src/web/v2/capture/capture-log.mjs'
import { captureVerdict } from '../../src/web/v2/core/capture-verdict.mjs'
import { controlHtml, controlFor, wireHarnessControls } from '../../src/web/v2/core/harness-switch.mjs'
import { ALIASES, harnessKey } from '../../src/web/v2/core/chips.mjs'
import { COMMANDS, CHANGE_REMOVAL, RESTART_CODES, SWITCH_WORD, ERR_WHERE } from '../../src/web/v2/labels/capture.mjs'

const SPEC = fs.readFileSync(new URL('../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url), 'utf8')
const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
const T = '2026-10-20T09:00:00Z'

// a C.3 document: the daemon up, health `state`, one harness per entry of `hs` ({desired, setup, captured, reason})
function doc({ state = 'ok', hs = { codex: {} }, topology = {}, extra = {} } = {}) {
  const d = sample()
  d.daemon = { running: true, responding: true, pid: 4012, since: T, error: null }
  d.health = { state, since: T }
  d.harnesses = Object.fromEntries(Object.entries(hs).map(([id, v]) => [id, { desired: 'on', captured: true, updated_at: T, ...v }]))
  d.topology = topology; d.critical = []; d.changed = []; d.failures = { since: T, groups: [] }; d.errors = []; d.install = { state: 'installed', pending: [] }
  return Object.assign(d, extra)
}
const CONTROL = { ok: true, status: 200, data: { control: true, user: 'u', root: false, harnesses: [] } }
const ROOT = { ok: true, status: 200, data: { control: false, user: 'root', root: true, harnesses: [] } }
const UNREADABLE = { ok: false, status: 503, error: 'HTTP 503' }
const page = (d, control, o = {}) => pageHtml(d, captureVerdict(d), { control, ...o })
// the agent rows of one page: read-side id → that row's HTML (up to the next row or the end of the table)
const rowsOf = (html) => new Map(html.split('<div class="crow" data-h="').slice(1).map((s) => [s.slice(0, s.indexOf('"')), s]))
const count = (s, re) => (s.match(re) || []).length

test('#5 / K-26: setup × desired × control plane × health — at most one control per row, never both, Set up alone when needed, nothing the user cannot use', () => {
  const N_FORBIDDEN = /data-act="(restart|install|uninstall|undo|opt-in)"/
  for (const setup of ['ready', 'needed', 'unknown']) for (const desired of ['on', 'off', 'mixed', null]) for (const [cname, control] of [['control', CONTROL], ['root', ROOT], ['unreadable', UNREADABLE]]) for (const state of ['ok', 'not-installed', 'residue']) {
    const d = doc({ state, hs: { codex: { desired, setup: { state: setup, missing: [] } } } })
    const html = page(d, control), at = `${setup}/${desired}/${cname}/${state}`
    const row = rowsOf(html).get('codex')
    assert.ok(row, at)
    assert.ok(count(row, /data-hctl=/g) <= 1, at)
    assert.equal(N_FORBIDDEN.test(html), false, at)
    const nulled = cname !== 'control' || state !== 'ok'
    if (nulled) { assert.equal(count(html, /data-hctl=/g), 0, at); assert.equal(/\sdisabled[\s>=]/.test(html), false, at); continue }
    assert.equal(count(row, /data-hctl="(switch|setup)"/g), 1, at)
    if (setup === 'needed') assert.ok(/data-hctl="setup"/.test(row) && !/role="switch"/.test(row), at)
    else assert.equal(count(row, /role="switch" aria-checked="(true|false)"/g), 1, at)
  }
})

test('M9 / K-25: not installed → trocar install in the details and no control; root → no control and `trocar on <the harnesses key>`', () => {
  const ni = page(doc({ state: 'not-installed' }), CONTROL)
  assert.equal(count(ni, /data-hctl=/g), 0)
  assert.ok(ni.includes(COMMANDS.install))
  for (const key of Object.keys(ALIASES)) {
    const html = page(doc({ hs: { [key]: {} } }), ROOT)
    assert.equal(count(html, /data-hctl=/g), 0, key)
    const row = rowsOf(html).get(harnessKey(key))
    assert.ok(row.includes(COMMANDS.on.replace('<id>', key)), key)
  }
})

test('K-27: a row whose reason is a restart code carries no button of its own — only its head, its one control, copies and disclosures', () => {
  for (const code of RESTART_CODES) for (const control of [CONTROL, ROOT]) {
    const d = doc({ hs: { codex: { captured: false, reason: code } } })
    d.critical = [{ kind: 'untrusted', code, harness: 'codex', pid: 5530, since: T }]
    const row = rowsOf(page(d, control)).get('codex')
    const buttons = row.match(/<button[^>]*>/g) || []
    assert.ok(buttons.length > 0)
    for (const b of buttons) assert.ok(/data-(caprow|hctl|copy|disc)=/.test(b), `${code}: ${b}`)
  }
})

// a fake DOM: the button controlHtml drew (its attributes parsed from the string), the root's one click listener
function fakeRow(model) {
  const html = controlHtml(model, {})
  const attrs = Object.fromEntries([...html.match(/<button([^>]*)>/)[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
  const btn = { getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = String(v) }, removeAttribute: (k) => { delete attrs[k] }, closest: (s) => (s === '[data-hctl]' ? btn : null) }
  let onClick = null
  const root = { addEventListener: (_t, fn) => { onClick = fn }, removeEventListener: () => {} }
  return { root, attrs, click: () => onClick({ target: btn, preventDefault() {} }) }
}
function fakeApi() {
  const calls = []
  return {
    calls,
    control: async (verb, body) => {
      calls.push({ verb, body })
      return body.confirm ? { ok: true, status: 200, data: { ok: true } } : { ok: false, status: 409, data: { need: 'confirm', plan: [{ path: '/h/.codex/.env', how: 'add the proxy entry', harness: 'codex' }], receipt: { dry_run: true }, plan_id: 'p1' } }
    },
  }
}

test('#4 wiring: no → one request without confirm; yes → the second carries the plan_id; Set up sends setup; a click while busy sends nothing', async () => {
  const d = doc({ hs: { codex: {} } }), sw = controlFor({ control: CONTROL, status: d }, 'codex')
  for (const answer of [false, true]) {
    const api = fakeApi(), state = new Map(), r = fakeRow(sw)
    let done = 0
    wireHarnessControls(r.root, { api, ask: async () => answer, state, onDone: () => { done++ } })
    await r.click()
    assert.equal(api.calls.length, answer ? 2 : 1)
    assert.equal('confirm' in api.calls[0].body, false)
    assert.deepEqual(api.calls[0], { verb: 'harness', body: { harness: 'codex', on: false } })
    if (answer) assert.equal(api.calls[1].body.confirm, 'p1')
    assert.equal(done, 1)
    assert.equal(state.get('codex').busy, false)
  }
  const ds = doc({ hs: { codex: { setup: { state: 'needed', missing: ['x'] } } } })
  const api = fakeApi(), r = fakeRow(controlFor({ control: CONTROL, status: ds }, 'codex'))
  let release
  wireHarnessControls(r.root, { api, ask: () => new Promise((res) => { release = res }), state: new Map() })
  const first = r.click()
  await new Promise((res) => setImmediate(res))
  assert.equal(r.attrs['aria-busy'], 'true')
  await r.click()
  assert.deepEqual(api.calls.map((c) => c.verb), ['setup'])
  release(true); await first
  assert.deepEqual(api.calls.map((c) => [c.verb, c.body.confirm ?? null]), [['setup', null], ['setup', 'p1']])
})

test('#8 / D49: proxy credentials are ***@ in the page and its copied diagnostics; unknown fields never reach the page', () => {
  const d = doc({
    hs: { codex: {} },
    topology: { codex: { at: T, routing: 'proxy', captured: true, nodes: [{ id: 'a', name: 'codex' }, { id: 'p', name: 'http://alice:pw@proxy.example:8080' }], branches: [{ path: ['a', 'p'] }], vpn: 'PlantedVpnName' } },
  })
  d.harnesses.codex.forms = [{ form: 'codex.cli', proxy: { upstream: { url_redacted: 'http://***@proxy.example:8080', product: 'PlantedProductName' } } }]
  d.proxy = { upstream: { product: 'PlantedProductName' } }
  const html = page(d, CONTROL, { openByReader: new Map([['codex', true]]) })
  assert.ok(html.includes('***@'))
  for (const bad of ['alice:pw', 'PlantedVpnName', 'PlantedProductName']) assert.equal(html.includes(bad), false, bad)
})

test('#9 / R14: the removal sentence is said once in an agent row\'s expansion and never in the machine-wide changes block', () => {
  const d = doc({ hs: { codex: {}, opencode: {} } })
  d.changed = [
    { harness: 'codex', path: '/h/.codex/.env', what: 'OPENAI_BASE_URL', undo: 'trocar off codex' },
    { harness: 'codex', path: '/h/.codex/config.toml', what: 'proxy', undo: 'trocar off codex' },
    { path: '/h/.trocar/ca.pem', what: 'created' },
  ]
  const html = page(d, CONTROL)
  const rows = rowsOf(html)
  assert.equal(count(rows.get('codex'), new RegExp(CHANGE_REMOVAL, 'g')), 1)
  assert.ok(count(rows.get('opencode'), new RegExp(CHANGE_REMOVAL, 'g')) <= 1)
  const block = html.slice(html.indexOf('<section class="cblock"'))
  assert.ok(block.length > 0 && block.includes('/h/.trocar/ca.pem'))
  assert.equal(block.includes(CHANGE_REMOVAL), false)
})

test('1.9 采集服务行: the service row links to the log once — the failing sentence itself when it carries the group count, else one link without a number', () => {
  const grp = (level, i) => ({ level, where: 'engine', code: `c${i}`, count: 1, first_ts: T, last_ts: T, reason: 'r' })
  for (const n of [0, 1, 3]) {
    const d = doc({ state: 'failing' })
    d.failures.groups = Array.from({ length: n }, (_, i) => grp('problem', i))
    assert.equal(count(rowsOf(page(d, CONTROL)).get('*service'), /href="#\/capture\/log"/g), Math.min(n, 1), `failing, ${n} groups`)
  }
  const d = doc({ state: 'ok' })
  d.failures.groups = [grp('note', 0), grp('note', 1)]
  const svc = rowsOf(page(d, CONTROL)).get('*service')
  const links = [...svc.matchAll(/<a href="#\/capture\/log"[^>]*>(.*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]*>/g, ''))
  assert.equal(links.length, 1)
  assert.equal(/\d/.test(links[0]), false)
})

test('#12 / D38⑦: no alert role, live region, badge, unread count or dismiss control on the capture page or the log', () => {
  const d = doc({ hs: { codex: { captured: false, reason: 'var-missing' } } })
  d.failures.groups = [{ level: 'problem', where: 'engine', code: 'leaf-error', count: 3, first_ts: T, last_ts: T, harness: 'codex', reason: 'r' }]
  for (const html of [page(d, CONTROL), page(doc({ state: 'residue' }), ROOT), pageLogHtml(d), pageLogHtml(d, { filter: 'codex' })]) {
    assert.equal(/role="alert"|aria-live|badge|unread|dismiss/i.test(html), false)
  }
})

test('#13: two paints with the same expand memory give the same aria-expanded set', () => {
  const d = doc({ hs: { codex: { captured: false, reason: 'var-missing' }, opencode: {} } })
  const open = new Map([['opencode', true], ['codex', false]])
  const exp = (html) => [...html.matchAll(/aria-expanded="(true|false)" aria-controls="([^"]+)"/g)].map((m) => `${m[2]}=${m[1]}`).sort()
  assert.deepEqual(exp(page(d, CONTROL, { openByReader: open })), exp(page(d, CONTROL, { openByReader: open })))
})

// D38 · 0.1 §2: every reason `status` can give for an agent that is not captured (the closed set STATUS_REASONS) gives the row a state
// sentence and a why from the one shared catalog — never an empty clause after the colon, never 「reason unknown」 — whether the reason
// arrives as the verdict's `reason` (with an empty `why[]`, as the real document carries it) or as a current condition's code.
test('D38: every status reason gives the row a sentence and a why — none empty, none unknown — through the verdict and through a condition', async () => {
  const { STATUS_REASONS } = await import('../../src/health/codes.mjs')
  const { statusReason } = await import('../../src/cli/words.mjs')
  const { agentVerdicts } = await import('../../src/web/v2/core/capture-verdict.mjs')
  const { UNKNOWN_REASON } = await import('../../src/web/v2/labels/capture.mjs')
  const bad = []
  for (const code of STATUS_REASONS.filter((c) => c !== 'desired-off')) {
    if (!statusReason(code)) bad.push(`${code}: no clause in the shared catalog`)
    const viaVerdict = doc({ hs: { codex: { captured: false, reason: code, why: [] } } })
    const viaCondition = doc({ hs: { codex: { captured: false, reason: null, why: [] } }, extra: { critical: [{ kind: 'untrusted', harness: 'codex', code, since: T }] } })
    for (const [how, d] of [['verdict', viaVerdict], ['condition', viaCondition]]) {
      const r = agentVerdicts(d).find((x) => x.harness === harnessKey('codex'))
      const why = rowsOf(page(d, CONTROL)).get(harnessKey('codex')).split('<dt>Why, and what to do</dt>')[1] || ''
      if (!r.text.trim() || /:\s*$/.test(r.text) || r.text.includes(UNKNOWN_REASON)) bad.push(`${code} (${how}): row sentence ${JSON.stringify(r.text)}`)
      if (!why || why.includes(UNKNOWN_REASON)) bad.push(`${code} (${how}): no why`)
    }
  }
  assert.deepEqual(bad, [])
})

// 1.5: one fact is said once — a cached verdict's finding that repeats the reason is not said a second time in 为什么 · 怎么办
test('1.5: the why section says each sentence once, though the reason also comes back as a finding', () => {
  for (const code of RESTART_CODES) {
    const d = doc({ hs: { codex: { captured: false, reason: code, why: [] } }, topology: { codex: { at: T, captured: false, reason: code, findings: [code] } } })
    const why = rowsOf(page(d, CONTROL)).get(harnessKey('codex')).split('<dt>Why, and what to do</dt>')[1].split('</dd>')[0]
    const ps = [...why.matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((m) => m[1].replace(/\.$/, ''))
    assert.equal(new Set(ps).size, ps.length, `${code}: ${JSON.stringify(ps)}`)
  }
})

// 1.9 期望态: the desired state is text only where the row draws no control; a switch already says it
test('1.9 期望态: the desired-state text is drawn only on a row without a control', () => {
  for (const desired of ['on', 'off']) {
    const d = doc({ hs: { codex: { desired } } })
    const des = (control) => /<span class="des">(.*?)<\/span>/.exec(rowsOf(page(d, control)).get(harnessKey('codex')))[1]
    assert.equal(des(CONTROL), '', desired)
    assert.equal(des(ROOT), SWITCH_WORD[desired], desired)
  }
})

// 1.9 Edge cases 表空: the empty-table line (drawn for a document naming no agent — wires-capture.test.mjs (6)) is not drawn when the
// install record cannot be read: the changes block already says so
test('1.9 表空: no empty-table line while the install manifest cannot be read', () => {
  const d = doc({ hs: {} })
  d.errors = [{ where: ERR_WHERE.manifest, reason: 'x' }]
  assert.equal(/class="capfoot"/.test(page(d, CONTROL)), false)
})
