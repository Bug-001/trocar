// capture-details.test.mjs — 1.9 验收 #17: an agent row's expand and every technical details grid say each fact once, in words
// (1.9 §采集服务行 技术细节 · §展开 trocar 为它改了). The documents are the C.3 sample of spec 1.6 with the fields each case varies.
// Contract only: which strings reach the page and how often inside one grid; never the wording of a row.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pageHtml } from '../../src/web/v2/capture/capture-view.mjs'
import { captureVerdict, reasonOf } from '../../src/web/v2/core/capture-verdict.mjs'
import { esc } from '../../src/web/v2/core/fmt.mjs'
import { CHANGE_KIND, CHANGE_FORMAT, UNKNOWN_REASON } from '../../src/web/v2/labels/capture.mjs'
import { KNOWN_KINDS } from '../../src/off/manifest.mjs'
import { STATUS_REASONS } from '../../src/health/codes.mjs'
import { statusReason } from '../../src/cli/words.mjs'
import { COMMANDS as CLI } from '../../src/cli/commands.mjs'

const SPEC = fs.readFileSync(new URL('../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url), 'utf8')
const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
const T = '2026-10-20T09:00:00Z'

function doc({ hs = { codex: {} }, topology = {}, extra = {} } = {}) {
  const d = sample()
  d.daemon = { running: true, responding: true, pid: 4012, since: T, error: null }
  d.health = { state: 'ok', since: T }
  d.harnesses = Object.fromEntries(Object.entries(hs).map(([id, v]) => [id, { desired: 'on', captured: true, updated_at: T, ...v }]))
  d.topology = topology; d.critical = []; d.changed = []; d.failures = { since: T, groups: [] }; d.errors = []; d.install = { state: 'installed', pending: [] }
  delete d.linger; delete d.linger_reason; delete d.relayed_reason
  return Object.assign(d, extra)
}
const page = (d) => pageHtml(d, captureVerdict(d), { control: null })
const rowsOf = (html) => new Map(html.split('<div class="crow" data-h="').slice(1).map((s) => [s.slice(0, s.indexOf('"')), s]))
// one row's technical details grid → [[key, value html]]
const techOf = (row) => {
  const g = /<div class="tech">([\s\S]*?)<\/div>/.exec(row)
  return g ? [...g[1].matchAll(/<span class="k">([\s\S]*?)<\/span><span class="v">([\s\S]*?)<\/span>(?=<span class="k">|$)/g)].map((m) => [m[1], m[2]]) : []
}
const techText = (row) => techOf(row).map(([k, v]) => `${k}\n${v}`).join('\n')
const expandOf = (row) => { const m = /<dl class="exp">([\s\S]*?)<\/dl>/.exec(row); return m ? m[1] : '' }
const count = (s, sub) => s.split(sub).length - 1
const monos = (s) => [...s.matchAll(/<span class="mono">([\s\S]*?)<\/span>/g)].map((m) => m[1])
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

test('the capture service row lists only harness-less commands — no <id>, never a bare on / off, each a 1.6 usage', () => {
  const svc = rowsOf(page(doc())).get('*service')
  const cmds = monos(techText(svc)).map(unesc).filter((c) => /^(?:sudo )?trocar /.test(c))
  assert.ok(cmds.length > 0)
  const lines = CLI.flatMap((c) => c.usage.split('\n'))
  for (const c of cmds) {
    assert.ok(!c.includes('<id>'), c)
    assert.ok(c !== 'trocar on' && c !== 'trocar off', c)
    assert.ok(lines.some((l) => l === c || l.startsWith(`${c} `)), c)
  }
})

test('a daemon error is escaped once', () => {
  const err = `it's "a" & <b>`
  const html = page(doc({ extra: { daemon: { running: true, responding: true, pid: 1, since: T, error: err } } }))
  assert.ok(html.includes(esc(err)))
  assert.ok(!html.includes(esc(esc(err))))
})

test('branches that share a chain are one path row, and a node repeated next to itself is said once', () => {
  const topology = { codex: { at: T, routing: 'proxy',
    nodes: [{ id: 'a', name: 'codex' }, { id: 'd', name: 'relay' }, { id: 'e', name: 'relay' }, { id: 'x', name: 'api.example' }],
    branches: [{ name: 'all', form: 'codex.cli', path: ['a', 'd', 'e', 'x'] }, { name: 'all', form: 'codex.app', path: ['a', 'd', 'e', 'x'] }, { name: 'b', form: 'codex.cli', path: ['a', 'x'] }] } }
  const row = rowsOf(page(doc({ topology }))).get('codex')
  const vals = techOf(row).filter(([k]) => k === 'path').map(([, v]) => v)
  assert.ok(vals.length > 0)
  assert.equal(new Set(vals).size, vals.length)
  for (const v of vals) {
    const nodes = v.split(' · ')[0].split(' → ')
    nodes.forEach((n, i) => assert.notEqual(n, nodes[i + 1], v))
  }
})

test('capture after logout is a row only while linger is unknown, and its reason is said once', () => {
  const keys = (d) => techOf(rowsOf(page(d)).get('*service')).map(([k]) => k)
  assert.deepEqual(keys(doc()), keys(doc({ extra: { linger: true } })))
  const reason = 'the linger file could not be read (EACCES)'
  const svc = rowsOf(page(doc({ extra: { linger: 'unknown', linger_reason: reason } }))).get('*service')
  assert.equal(count(techText(svc), esc(reason)), 1)
})

test('changes group by file — each path once in the expand, a known kind in words, every CHANGE_KIND key a manifest kind', () => {
  for (const k of Object.keys(CHANGE_KIND)) assert.ok(KNOWN_KINDS.includes(k), k)
  const P1 = '~/.codex/config.toml', P2 = '~/.codex/trocar-plugin.js'
  const changed = [
    { harness: 'codex', path: P1, what: 'json-key a.b', undo: 'trocar uninstall' },
    { harness: 'codex', path: P1, what: 'json-key c', undo: 'trocar uninstall' },
    { harness: 'codex', path: P1, what: 'text dotenv', undo: 'trocar off codex' },
    { harness: 'codex', path: P1, what: 'proxy-entry HTTPS_PROXY', undo: 'trocar off codex' },
    { harness: 'codex', path: P2, what: 'owned-file plugin', undo: 'trocar uninstall' },
  ]
  const ex = expandOf(rowsOf(page(doc({ extra: { changed } }))).get('codex'))
  for (const p of [P1, P2]) assert.equal(count(ex, esc(p)), 1, p)
  for (const e of changed) {
    const kind = e.what.split(' ')[0]
    assert.ok(Object.hasOwn(CHANGE_KIND, kind), kind)
    assert.ok(!monos(ex).some((m) => m.split(/[ ,]+/).includes(kind)), kind)
  }
})

test('a text entry\'s format is said in words, never as its internal name; an unknown format is shown as it came', () => {
  const fmts = Object.keys(CHANGE_FORMAT), odd = 'zz-unknown-format'
  assert.ok(fmts.length > 0)
  const changed = [...fmts, odd].map((f, i) => ({ harness: 'codex', path: `~/.codex/f${i}`, what: `text ${f}`, undo: 'trocar off codex' }))
  const ex = expandOf(rowsOf(page(doc({ extra: { changed } }))).get('codex'))
  for (const f of fmts) assert.ok(!monos(ex).includes(f), f)
  assert.equal(monos(ex).filter((m) => m === odd).length, 1)
})

test('each undo command is listed once, and one equal to a row command is not listed again', () => {
  const changed = [1, 2, 3, 4].map((i) => ({ harness: 'codex', path: `~/.codex/f${i}`, what: `json-key k${i}`, undo: 'trocar uninstall' }))
  changed.push({ harness: 'codex', path: '~/.codex/.env', what: 'text dotenv', undo: 'trocar off codex' })
  const tech = techText(rowsOf(page(doc({ extra: { changed } }))).get('codex'))
  assert.equal(count(tech, 'trocar uninstall'), 1)
  assert.equal(count(tech, 'trocar off codex'), 1)
})

test('relayed connections — all zero says nothing, a non-zero count is a row, unknown carries its reason', () => {
  const tech = (extra) => techOf(rowsOf(page(doc({ extra }))).get('*service'))
  const none = tech({ relayed: undefined })
  assert.deepEqual(tech({ relayed: { closing: 0, waiting: 0, cut: 0 } }), none)
  assert.ok(tech({ relayed: { closing: 2, waiting: 0, cut: 0 } }).length > none.length)
  const reason = "the daemon's reply does not carry the connection counts"
  assert.ok(techText(rowsOf(page(doc({ extra: { relayed: 'unknown', relayed_reason: reason } }))).get('*service')).includes(esc(reason)))
})

test('a finding says its reason with its code; an unknown code is shown as it came, never as reason unknown', () => {
  const known = STATUS_REASONS.find((c) => statusReason(c).text)
  assert.ok(known)
  const topology = { codex: { at: T, findings: [known, 'zz-unknown'] } }
  const tech = techText(rowsOf(page(doc({ topology }))).get('codex'))
  assert.ok(tech.includes(esc(reasonOf(known, { harness: 'codex' }).why)))
  assert.ok(tech.includes(esc(known)))
  assert.ok(tech.includes('zz-unknown'))
  assert.ok(!tech.includes(esc(UNKNOWN_REASON)))
})
