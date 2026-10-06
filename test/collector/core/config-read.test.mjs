// test/collector/core/config-read.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readText, hostOf, expandHome, parseDotenv, parseTomlLite, parseJsonc, dig } from '../../../src/collector/core/config-read.mjs'

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

test('config-read: JSONC strips comments and trailing commas but not inside strings', () => {
  const { data } = parseJsonc('{\n // c\n "provider": { "x": { "options": { "baseURL": "https://a.example.com//v1", }, }, },\n /* b */ "s": "/* keep */",\n}')
  assert.equal(data.provider.x.options.baseURL, 'https://a.example.com//v1')
  assert.equal(dig(data, 'provider.x.options.baseURL'), 'https://a.example.com//v1')
  assert.equal(data.s, '/* keep */')
  assert.deepEqual(parseJsonc('{ nope'), { data: null, errors: 1 })
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
