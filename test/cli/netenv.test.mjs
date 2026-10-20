// test/cli/netenv.test.mjs — ~/.trocar/netenv.json is trocar's own file (D49): `schema`, `adopted` (what `on` found of each agent's proxy) and `topology`. It is written whole or not at all,
// 0600, and a write keeps what it does not redraw. (The V22 probe of VPN software this file once tested is gone with D49.)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeNetenv, netenvFile, NETENV_SCHEMA } from '../../src/netenv/index.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

test('writeNetenv keeps what a write does not redraw: `adopted` (what `on` found) and the harnesses of `topology` it leaves out; the file is 0600 and a file that does not parse is replaced', () => {
  const home = tmpDir('trocar-merge-')
  writeNetenv(home, { adopted: { codex: { at: 'A', sha256: 'abc' } }, topology: { codex: { at: 'T1' }, hermes: { at: 'T1' } } })
  writeNetenv(home, { topology: { codex: { at: 'T2' } } })
  let f = JSON.parse(fs.readFileSync(netenvFile(home), 'utf8'))
  assert.deepEqual([f.schema, f.adopted, f.topology], [NETENV_SCHEMA, { codex: { at: 'A', sha256: 'abc' } }, { codex: { at: 'T2' }, hermes: { at: 'T1' } }])
  writeNetenv(home, { adopted: { codex: { at: 'B', sha256: 'def' } } })
  f = JSON.parse(fs.readFileSync(netenvFile(home), 'utf8'))
  assert.deepEqual([Object.keys(f).sort(), f.topology.hermes.at, f.adopted.codex.at], [['adopted', 'schema', 'topology'], 'T1', 'B'], 'an adopted-only write (on) does not drop the topology')
  assert.equal(fs.statSync(netenvFile(home)).mode & 0o777, 0o600)
  fs.writeFileSync(netenvFile(home), '{ not json')
  writeNetenv(home, { topology: { codex: { at: 'T4' } } })
  assert.equal(JSON.parse(fs.readFileSync(netenvFile(home), 'utf8')).topology.codex.at, 'T4', 'a file that does not parse is replaced, not a reason to fail')
})
