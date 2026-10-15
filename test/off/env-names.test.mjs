// env-names.mjs — whether two environment-variable names are one variable (4.6「名字族」②): the platform fact in one place, and the JSON form
// of the family (isAlsoSetMember) that applyJsonKey uses. Pure functions; generated over the proxy / CA names and every case pattern.
import test from 'node:test'
import assert from 'node:assert/strict'
import { foldsEnvNames, foldEnvName, sameEnvName, isAlsoSetMember } from '../../src/off/env-names.mjs'
import { PROXY_NAMES, CA_NAMES } from '../helpers/file-shapes.mjs'

// every case pattern of a name: lower, upper, and one with each letter's case flipped in turn
const spellings = (n) => [...new Set([n.toLowerCase(), n.toUpperCase(), ...[...n].map((_, i) => n.slice(0, i) + (n[i] === n[i].toUpperCase() ? n[i].toLowerCase() : n[i].toUpperCase()) + n.slice(i + 1))])]

test('env-names: names fold only on win32 — every spelling of a name is one variable there, and only itself elsewhere', () => {
  assert.deepEqual(['win32', 'darwin', 'linux'].map(foldsEnvNames), [true, false, false])
  for (const n of [...PROXY_NAMES, ...CA_NAMES]) {
    for (const s of spellings(n)) {
      assert.equal(sameEnvName(n, s, true), true, `${n} ~ ${s} folded`)
      assert.equal(sameEnvName(n, s, false), n === s, `${n} vs ${s} byte for byte`)
    }
  }
  assert.equal(sameEnvName('HTTPS_PROXY', 'HTTP_PROXY', true), false, 'folding is case only')
})

test('env-names: foldEnvName upper-cases one character at a time — ß stays ß (its upper case is two characters), as Windows folds one UTF-16 unit', () => {
  assert.equal(foldEnvName('straße_proxy'), 'STRAßE_PROXY')
  assert.equal(sameEnvName('STRASSE_PROXY', 'straße_proxy', true), false)
})

test('env-names: isAlsoSetMember — a member named in alsoSet (by the fold rule), or the leaf in another case when folding; never the leaf itself', () => {
  for (const fold of [false, true]) {
    assert.equal(isAlsoSetMember('HTTPS_PROXY', 'HTTPS_PROXY', ['HTTPS_PROXY'], fold), false, 'the leaf is the entry itself')
    assert.equal(isAlsoSetMember('https_proxy', 'HTTPS_PROXY', ['https_proxy'], fold), true)
    assert.equal(isAlsoSetMember('Https_Proxy', 'HTTPS_PROXY', ['https_proxy'], fold), fold, 'another case of an alsoSet name: only when folding')
    assert.equal(isAlsoSetMember('https_proxy', 'HTTPS_PROXY', [], fold), fold, 'the leaf in another case: only when folding')
    assert.equal(isAlsoSetMember('ALL_PROXY', 'HTTPS_PROXY', ['https_proxy'], fold), false, 'a name nobody named is not touched')
  }
})
