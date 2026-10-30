// test/dissect/traffic.test.mjs — which traffic class a call is (RFC 4.6 §记录「保存级别」, D40; acceptance K1).
// The patterns are DATA on the harness table (src/dissect/harnesses.mjs); the capture core names no harness and holds no
// host pattern (D20, 0.1 §5) — the second half of this file is that guard, run over the source text.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClassifier, compileTraffic, retentionHarnessIds, THIRD_PARTY_TELEMETRY } from '../../src/dissect/traffic.mjs'
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

// review M44: removing the querystring strip from `pathOf` kept every test green — the case above is passed by an anchored pattern either way.
// The strip matters in both directions: a `$`-anchored pattern must still match a path that has a querystring, and a querystring that merely
// CONTAINS the pattern must not make a path match.
test('the querystring is not part of the path, in both directions: a $-anchored pattern matches /path?q, and /other?next=/path does not', () => {
  assert.equal(classify({ harness: 'cc', host: 'api.anthropic.com', endpoint: '/v1/code/sessions?limit=1' }), 'session-sync', 'cc\'s ^/v1/code/sessions(/|$) on a listing with a querystring')
  assert.equal(classify({ harness: 'cc', host: 'api.anthropic.com', endpoint: '/v1/code/sessions' }), 'session-sync')
  const c = makeClassifier({ endpointClass, rows: [{ id: 'x', traffic: [{ host: 'h.test', class: 'files', path: '/up' }, { host: 'h.test', class: 'account', path: '^/acct$' }] }] })
  assert.equal(c({ harness: 'x', host: 'h.test', endpoint: '/x?next=/up' }), 'other', 'the pattern is in the querystring only: not this call\'s path')
  assert.equal(c({ harness: 'x', host: 'h.test', endpoint: '/acct?id=7' }), 'account', 'an end-anchored pattern sees the path, not the querystring')
  assert.equal(c({ harness: 'x', host: 'h.test', endpoint: '/up/1?x=1' }), 'files')
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
  // deepseek-cli has no table row: only an old capture's UA names it — but a call filed under it must have a setting (review 2026-10-07)
  const ids = retentionHarnessIds()
  for (const id of [...HARNESSES.map((h) => h.id), 'deepseek-cli', 'unknown']) assert.ok(ids.includes(id), `${id} has a setting`)
  assert.equal(new Set(ids).size, ids.length, 'each once')
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
// `\bsentry\b`, not the substring: D39's `rereadsEntry` (a harness flag of the process registry) holds 「sEntry」 and is no Sentry host
const CLASS_PATTERNS = /event_logging|worker\/events|file_upload|domain_info|\bsentry\b|statsig|datadog|downloads\.|\/v1\/code\/sessions/i
export function offenders(files, read = (f) => fs.readFileSync(f, 'utf8')) {
  return files.flatMap((f) => { const code = stripComments(read(f)); return [HARNESS_NAMES, CLASS_PATTERNS].flatMap((re) => (re.test(code) ? [`${path.relative(REPO, f)}: ${code.match(re)[0]}`] : [])) })
}

test('K1 guard: src/collector/core/** and the files that apply the keep level hold no harness name and no class pattern (D20, 0.1 §5)', () => {
  // mitm.mjs went with the old capture (D39⑥ executed 2026-10-11); retention.mjs / keep.mjs with the retention surface (T5),
  // and src/classes/source.mjs is where the level is applied now — its table is DATA (src/dissect), never a pattern of its own
  const capture = ['envelope.mjs', 'request-body.mjs'].map((n) => path.join(REPO, 'src', 'capture', n))
  const files = [...walk(path.join(REPO, 'src', 'collector', 'core')), ...capture, path.join(REPO, 'src', 'classes', 'source.mjs')]
  assert.ok(files.length > 30, 'the scan sees the tree')
  assert.deepEqual(offenders(files), [])
})

test('K1 guard can fail: a planted file with a harness name and a class pattern is caught', () => {
  const planted = { '/x/a.mjs': "const h = 'claude'\n", '/x/b.mjs': "const p = '/api/event_logging/'\n", '/x/c.mjs': "// claude and event_logging in a comment only\nconst ok = 1\n", '/x/d.mjs': "const h = 'o1.ingest.sentry.io'\n", '/x/e.mjs': 'const k = t.rereadsEntry\n' }
  assert.deepEqual(offenders(Object.keys(planted), (f) => planted[f]).map((s) => s.replace(/^.*?x\//, '')), ['a.mjs: claude', 'b.mjs: event_logging', 'd.mjs: sentry'], 'a Sentry host is caught; the word rereadsEntry is not one')
})

// review (F8): which of the three pattern-only classes a harness's table row can ever produce
test('unmatchedClasses: a class no usable pattern of the row names is unmatched; a pattern that does not compile does not count; an unknown harness has none', async () => {
  const { unmatchedClasses, PATTERN_ONLY_CLASSES } = await import('../../src/dissect/traffic.mjs')
  assert.deepEqual([...PATTERN_ONLY_CLASSES], ['session-sync', 'files', 'account'])
  const rows = [{ id: 'a', traffic: [{ host: 'x.test', class: 'files', path: '^/u' }, { host: 'x.test', class: 'account', path: '(' }, { host: 'x.test', class: 'telemetry' }] }, { id: 'b' }]
  assert.deepEqual(unmatchedClasses('a', rows), ['session-sync', 'account'], 'files has a usable pattern; the account one does not compile; telemetry is not a pattern-only class')
  assert.deepEqual(unmatchedClasses('b', rows), ['session-sync', 'files', 'account'])
  assert.deepEqual(unmatchedClasses('c', rows), ['session-sync', 'files', 'account'])
})

test('pi: its install report to pi.dev is telemetry; the fd / rg downloads of its first interactive start (github.com, release assets) are files', () => {
  assert.equal(classify({ harness: 'pi', host: 'pi.dev', endpoint: '/api/report-install?version=1.0.0' }), 'telemetry')
  assert.equal(classify({ harness: 'pi', host: 'github.com', endpoint: '/org/tool/releases/download/v1/tool.tar.gz' }), 'files')
  assert.equal(classify({ harness: 'pi', host: 'release-assets.githubusercontent.com', endpoint: '/github-production-release-asset/1' }), 'files')
  assert.equal(classify({ harness: 'codex', host: 'github.com', endpoint: '/x' }), 'other', 'only pi\'s row says so')
})
