// test/collector/core/config-read.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readText, hostOf, expandHome, parseDotenv, parseJsonc, dig } from '../../../src/collector/core/config-read.mjs'

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
