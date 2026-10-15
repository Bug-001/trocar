// test/collector/core/config-read.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readText, readTextOrError, hostOf, expandHome, parseDotenv, parseTomlLite, parseJsonc, dig } from '../../../src/collector/core/config-read.mjs'

test('config-read: hostOf takes URLs, bare hosts, IPv6 literals; junk is null', () => {
  assert.equal(hostOf('https://API.Example.com:8443/v1'), 'api.example.com')
  assert.equal(hostOf('relay.example.com/anthropic'), 'relay.example.com')
  assert.equal(hostOf('http://[::1]:8080'), '::1')
  assert.equal(hostOf(''), null); assert.equal(hostOf(42), null); assert.equal(hostOf('http://'), null)
})

test('config-read: readText returns null for a missing file instead of throwing', () => {
  assert.equal(readText(path.join(os.tmpdir(), 'asight-nope-' + process.pid)), null)
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-cr-')); fs.writeFileSync(path.join(d, 'a'), 'x')
  try { assert.equal(readText(path.join(d, 'a')), 'x'); assert.equal(expandHome('~/a', d), path.join(d, 'a')) } finally { fs.rmSync(d, { recursive: true }) }
})

test('config-read: dotenv handles export, quotes, comments; later keys win', () => {
  const m = parseDotenv('# c\nexport A=1\nB="two # not comment"\nC=\'3\'\nD=4 # trailing\nA=5\nbad line\nE="a\\nb"\r\n')
  assert.deepEqual(Object.fromEntries(m), { A: '5', B: 'two # not comment', C: '3', D: '4', E: 'a\nb' })
})

test('config-read: TOML subset reads tables, dotted keys, strings; skips what it cannot read', () => {
  const { data, errors } = parseTomlLite([
    'openai_base_url = "https://relay.example.com/v1" # c',
    "model_provider = 'mock'",
    'profiles.fast.model = "m"',
    '[model_providers.mock]',
    'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"',
    '[model_providers."a.b"]',
    'base_url = "https://ab.example.com"',
    'list = ["x", "y"]',
    '[[mcp_servers]]',
    'url = "https://ignored.example.com"',
  ].join('\n'))
  assert.equal(data.openai_base_url, 'https://relay.example.com/v1')
  assert.equal(data.model_provider, 'mock')
  assert.equal(dig(data, 'model_providers.mock.base_url'), 'http://127.0.0.1:9/v1')
  assert.equal(data.model_providers['a.b'].base_url, 'https://ab.example.com')
  assert.equal(dig(data, 'profiles.fast.model'), 'm')
  assert.equal(data.url, undefined)
  assert.equal(data.model_providers['a.b'].url, undefined, 'a key under an unread [[header]] never lands in the table before it')
  assert.equal(errors, 1) // the [[array-of-tables]] header; an array value is skipped, not an error
})

test('config-read: TOML inline tables are read; arrays and multi-line strings over several lines are skipped and never taken for keys; what it cannot read is counted (review 4 #4)', () => {
  const { data, errors } = parseTomlLite([
    'model_providers = { relay = { base_url = "https://inline.example.com/v1", name = "R, x" }, b = { base_url = \'https://b.example.com\' } }',
    'notify = ["a", "b,c"]',
    'args = [',
    '  "x",',
    '  "y]", # a comment with ] in it',
    ']',
    'instructions = """',
    'openai_base_url = "https://fake.example.com"',
    '"""',
    "lit = '''one line'''",
    'after = "still read"',
    '[t]',
    'env = { A = "1", list = [1, 2], nested = { k = true } } # trailing comment',
    'not a key value line',
    'junk = { a = "1" } trailing',
    'bad = { a = "unclosed }', // unclosed: it runs to the end of the file, which is then not fully read
  ].join('\n'))
  assert.equal(dig(data, 'model_providers.relay.base_url'), 'https://inline.example.com/v1')
  assert.equal(dig(data, 'model_providers.relay.name'), 'R, x', 'a comma inside a string does not split the table')
  assert.equal(dig(data, 'model_providers.b.base_url'), 'https://b.example.com')
  assert.equal(data.openai_base_url, undefined, 'a line inside a multi-line string is not a key')
  assert.equal(data.after, 'still read', 'reading goes on after a multi-line array and string')
  assert.deepEqual(data.t.env, { A: '1', nested: { k: true } })
  assert.equal(data.t.bad, undefined)
  assert.equal(data.t.junk, undefined, 'text after the closing brace: not read')
  assert.equal(errors, 3, 'the line that is not key = value, the one with text after its table, the unclosed table')
})

test('config-read: readTextOrError keeps "cannot be read" apart from "not there" (D-9)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-cr-'))
  try {
    assert.deepEqual(readTextOrError(path.join(d, 'nope')), { text: null, error: null })
    assert.deepEqual(readTextOrError(path.join(d, 'nope', 'deeper')), { text: null, error: null }, 'ENOTDIR is absent too')
    fs.writeFileSync(path.join(d, 'a'), 'x')
    assert.deepEqual(readTextOrError(path.join(d, 'a')), { text: 'x', error: null })
    fs.mkdirSync(path.join(d, 'dir'))
    assert.deepEqual([readTextOrError(path.join(d, 'dir')).text, readTextOrError(path.join(d, 'dir')).error.code], [null, 'EISDIR'])
    const eacces = readTextOrError(path.join(d, 'a'), { readFile: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) } })
    assert.deepEqual(eacces, { text: null, error: { code: 'EACCES', message: 'permission denied' } })
  } finally { fs.rmSync(d, { recursive: true }) }
})

test('config-read: JSONC strips comments and trailing commas but not inside strings', () => {
  const { data } = parseJsonc('{\n // c\n "provider": { "x": { "options": { "baseURL": "https://a.example.com//v1", }, }, },\n /* b */ "s": "/* keep */",\n}')
  assert.equal(data.provider.x.options.baseURL, 'https://a.example.com//v1')
  assert.equal(dig(data, 'provider.x.options.baseURL'), 'https://a.example.com//v1')
  assert.equal(data.s, '/* keep */')
  const bad = parseJsonc('{ nope')
  assert.deepEqual([bad.data, bad.errors, typeof bad.error], [null, 1, 'string'], 'the parser\'s message is kept for the record (D-9)')
})

test('config-read: the Node release of an executable is read from its embedded download URL, also across a chunk edge; never by running it', async () => {
  const { nodeReleaseVersion, versionAtLeast } = await import('../../../src/collector/core/config-read.mjs')
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-nv-'))
  try {
    const url = Buffer.from('https://nodejs.org/download/release/v22.18.0/node-v22.18.0.tar.gz')
    const bin = path.join(d, 'node'); fs.writeFileSync(bin, Buffer.concat([Buffer.alloc(100, 1), url, Buffer.alloc(50)]))
    assert.equal(nodeReleaseVersion(bin), '22.18.0')
    const edge = path.join(d, 'node-edge'); fs.writeFileSync(edge, Buffer.concat([Buffer.alloc(30, 2), url])) // the marker straddles 16-byte chunks
    assert.equal(nodeReleaseVersion(edge, { chunk: 16 }), '22.18.0')
    const other = path.join(d, 'bun'); fs.writeFileSync(other, 'not node')
    assert.equal(nodeReleaseVersion(other), null)
    assert.equal(nodeReleaseVersion(path.join(d, 'missing')), null)
    assert.deepEqual([versionAtLeast('22.19.0', '22.19.0'), versionAtLeast('22.18.9', '22.19.0'), versionAtLeast('24.0.0', '22.19.0'), versionAtLeast(null, '1.0.0')], [true, false, true, false])
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('config-read: parseJsonc reads a user\'s JSON as the writer does (json-text.mjs, 4.6「JSON 按 JSONC 读写」) — the same verdict over the json shapes; no document (empty, blank, a mark, comments only) is no data and no error; an open /* is an error', async () => {
  const { shapeCases, seeds } = await import('../../helpers/file-shapes.mjs')
  const { setKey } = await import('../../../src/off/json-text.mjs')
  const writer = (t) => { try { setKey(t, ['env', 'HTTPS_PROXY'], 'http://127.0.0.1:1'); return 'ok' } catch (e) { return e.why === 'not-json' ? 'not-json' : 'ok' } }
  const reader = (t) => (parseJsonc(t).errors ? 'not-json' : 'ok')
  const texts = [...seeds, ...shapeCases({ format: 'json', budget: 60 })].filter((c) => c.determinable && c.format === 'json').map((c) => c.text)
  const extra = ['', '  \r\n', '﻿', '// only a comment\n', '/* a block */', '{} /* open', '{ "a": 1 } // end', '{ /* open }', '{"a": [1,],}']
  for (const t of [...texts, ...extra]) assert.equal(reader(t), writer(t), JSON.stringify(t))
  for (const t of ['', ' \n', '﻿', '// c\n', '/* c */']) assert.deepEqual(parseJsonc(t), { data: null, errors: 0 }, `no document: ${JSON.stringify(t)}`)
  assert.equal(parseJsonc('{ "a": 1 } /* open').errors, 1, 'an unterminated block comment is not JSONC')
})
