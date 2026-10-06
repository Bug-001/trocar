// test/dissect/traffic.test.mjs — which traffic class a call is (RFC 4.6 §记录「保存级别」, D40; acceptance K1).
// The patterns are DATA on the harness table (src/dissect/harnesses.mjs); the capture core names no harness and holds no
// host pattern (D20, 0.1 §5) — the second half of this file is that guard, run over the source text.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClassifier, compileTraffic, harnessIdOfAgent, retentionHarnessIds, THIRD_PARTY_TELEMETRY } from '../../src/dissect/traffic.mjs'
import { endpointClass } from '../../src/capture/envelope.mjs'
import { HARNESSES } from '../../src/dissect/harnesses.mjs'

const classify = makeClassifier({ endpointClass })
const AN = 'api.anthropic.com'

test('K1 class table: the endpoint says llm / token-count, the cc row says the rest, the shared table says third-party telemetry, the rest is other', () => {
  const rows = [
    ['cc', AN, '/v1/messages', 'llm'], ['cc', AN, '/v1/messages?beta=true', 'llm'], ['cc', AN, '/v1/messages/count_tokens', 'token-count'],
    ['cc', AN, '/v1/code/sessions/cse_abc/worker/events', 'session-sync'], ['cc', AN, '/v1/code/sessions/cse_abc/worker/heartbeat', 'session-sync'],
    ['cc', AN, '/v1/code/sessions', 'session-sync'], ['cc', AN, '/v1/code/sessions/x/client/presence', 'session-sync'],
    ['cc', AN, '/api/event_logging/v2/batch', 'telemetry'], ['cc', AN, '/api/oauth/file_upload', 'files'], ['cc', AN, '/v1/files', 'files'],
    ['cc', AN, '/api/oauth/profile', 'account'], ['cc', AN, '/api/web/domain_info?domain=x.test', 'account'],
    ['cc', 'claude.ai', '/anything', 'account'], ['cc', 'downloads.claude.ai', '/claude-code/1.2.3/linux-x64', 'files'],
    ['cc', 'o123.ingest.sentry.io', '/api/456/envelope/', 'telemetry'], ['codex', 'o1.ingest.sentry.io', '/x', 'telemetry'],
    ['cc', 'unknown-host.test', '/x', 'other'], ['cc', AN, '/v1/unheard-of', 'other'],
    ['codex', AN, '/api/event_logging/v2/batch', 'other'],       // another harness's row declares no such pattern: other, kept in full
    ['unknown', 'cdn.example.test', '/x', 'other'], ['nobody-at-all', 'o9.ingest.sentry.io', '/x', 'telemetry'],
  ]
  for (const [h, host, endpoint, want] of rows) assert.equal(classify({ harness: h, host, endpoint }), want, `${h} ${host}${endpoint}`)
})

test('host patterns are exact or *.suffix, any case; paths ignore the querystring; the first entry that matches wins', () => {
  assert.equal(classify({ harness: 'cc', host: 'API.Anthropic.COM', endpoint: '/Api/event_logging/x' }), 'other', 'the path regex is case-sensitive, the host is not')
  assert.equal(classify({ harness: 'cc', host: 'API.Anthropic.COM', endpoint: '/api/event_logging/x?a=/v1/code/sessions' }), 'telemetry')
  assert.equal(classify({ harness: 'cc', host: 'evilclaude.ai', endpoint: '/' }), 'other', 'claude.ai is exact: no suffix match without *.')
  assert.equal(classify({ harness: 'cc', host: 'sentry.io', endpoint: '/' }), 'telemetry', '*.sentry.io also covers the bare domain')
  assert.equal(classify({ harness: 'cc', host: 'notsentry.io', endpoint: '/' }), 'other')
  const rows = [{ id: 'x', traffic: [{ host: 'h.test', class: 'files', path: '^/up' }, { host: 'h.test', class: 'account' }] }]
  const c = makeClassifier({ endpointClass, rows })
  assert.deepEqual([c({ harness: 'x', host: 'h.test', endpoint: '/up/1' }), c({ harness: 'x', host: 'h.test', endpoint: '/down' })], ['files', 'account'])
})

test('a pattern that does not compile, or names a class a pattern may not, is skipped and reported — never an exception on a call', () => {
  const bad = []
  const rows = [{ id: 'x', traffic: [{ host: 'a.test', class: 'files', path: '(' }, { host: 'a.test', class: 'llm' }, { class: 'files' }, { host: 'a.test', class: 'telemetry' }] }]
  const c = makeClassifier({ endpointClass, rows, onInvalid: (b) => bad.push([b.harness, b.entry.class, b.reason]) })
  assert.equal(c({ harness: 'x', host: 'a.test', endpoint: '/x' }), 'telemetry', 'the entries after the bad ones still work')
  assert.equal(bad.length, 3); assert.ok(bad.every(([h]) => h === 'x'))
  assert.equal(compileTraffic(HARNESSES).get('cc').length, HARNESSES.find((h) => h.id === 'cc').traffic.length, 'the shipped table has no invalid entry')
})

test('proc.agent → read-side harness id: either spelling, unknown otherwise; the settings may name every row plus unknown', () => {
  assert.deepEqual(['cc', 'claude-code', 'codex', 'z-code', 'zcode'].map(harnessIdOfAgent), ['cc', 'cc', 'codex', 'zcode', 'zcode'])
  assert.deepEqual([harnessIdOfAgent('mystery'), harnessIdOfAgent(null), harnessIdOfAgent(undefined)], ['unknown', 'unknown', 'unknown'])
  assert.deepEqual(retentionHarnessIds(), ['cc', 'codex', 'opencode', 'kimi', 'dsh', 'hermes', 'zcode', 'unknown'])
  assert.ok(THIRD_PARTY_TELEMETRY.every((p) => /^(\*\.)?[a-z0-9.-]+$/.test(p)))
})

// ── the guard: the capture core holds no harness name and no class pattern ─────────────────────────────────────────────
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// source text with the comments dropped; strings and regex literals stay (the same scanner idea as test/collector/layering.test.mjs)
function stripComments(src) {
  let out = '', i = 0, q = null
  const prevSig = () => { for (let j = out.length - 1; j >= 0; j--) if (!/\s/.test(out[j])) return out[j]; return '' }
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (q) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue } if (c === q) q = null; i++; continue }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue }
    if (c === '/' && (prevSig() === '' || '(,=:[!&|?{};'.includes(prevSig()) || /\b(return|typeof)$/.test(out.trimEnd()))) {
      let j = i + 1, cls = false
      while (j < src.length && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; j++ }
      out += src.slice(i, j + 1); i = j + 1; continue
    }
    out += c; i++
  }
  return out
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.mjs$/.test(e.name) ? [path.join(d, e.name)] : []))
const HARNESS_NAMES = /\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/i
const CLASS_PATTERNS = /event_logging|worker\/events|file_upload|domain_info|sentry|statsig|datadog|downloads\.|\/v1\/code\/sessions/i
export function offenders(files, read = (f) => fs.readFileSync(f, 'utf8')) {
  return files.flatMap((f) => { const code = stripComments(read(f)); return [HARNESS_NAMES, CLASS_PATTERNS].flatMap((re) => (re.test(code) ? [`${path.relative(REPO, f)}: ${code.match(re)[0]}`] : [])) })
}

test('K1 guard: src/collector/core/** and the capture files that apply the retention hold no harness name and no class pattern (D20, 0.1 §5)', () => {
  const capture = ['envelope.mjs', 'request-body.mjs', 'retention.mjs', 'keep.mjs', 'response-tee.mjs', 'mitm.mjs', 'reverse-proxy.mjs'].map((n) => path.join(REPO, 'src', 'capture', n))
  const files = [...walk(path.join(REPO, 'src', 'collector', 'core')), ...capture]
  assert.ok(files.length > 30, 'the scan sees the tree')
  assert.deepEqual(offenders(files), [])
})

test('K1 guard can fail: a planted file with a harness name and a class pattern is caught', () => {
  const planted = { '/x/a.mjs': "const h = 'claude'\n", '/x/b.mjs': "const p = '/api/event_logging/'\n", '/x/c.mjs': "// claude and event_logging in a comment only\nconst ok = 1\n" }
  assert.deepEqual(offenders(Object.keys(planted), (f) => planted[f]).map((s) => s.replace(/^.*?x\//, '')), ['a.mjs: claude', 'b.mjs: event_logging'])
})
