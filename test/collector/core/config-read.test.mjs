// test/collector/core/config-read.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readText, hostOf, expandHome, parseJsonc, dig } from '../../../src/collector/core/config-read.mjs'

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

test('config-read: JSONC strips comments and trailing commas but not inside strings', () => {
  const { data } = parseJsonc('{\n // c\n "provider": { "x": { "options": { "baseURL": "https://a.example.com//v1", }, }, },\n /* b */ "s": "/* keep */",\n}')
  assert.equal(data.provider.x.options.baseURL, 'https://a.example.com//v1')
  assert.equal(dig(data, 'provider.x.options.baseURL'), 'https://a.example.com//v1')
  assert.equal(data.s, '/* keep */')
  assert.deepEqual(parseJsonc('{ nope'), { data: null, errors: 1 })
})
