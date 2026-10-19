// setup-state.test.mjs — V91 (1.6 附录 C.3 `setup`, 4.11 P4b, D65④): setupOf, the one judgement behind `status`'s `harnesses[h].setup` and `on`'s ⑪,
// over a descriptor fixture: form present / absent × its carrier's install item none / intact / hash changed × the root in place / missing / pending.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { setupOf } from '../../../../src/collector/core/proxymode/status-facts.mjs'
import { sha256 } from '../../../../src/off/fsutil.mjs'

// one harness, two forms: `fx.app` whose certificate is a carrier asight places at install, `fx.cli` that the root carries
const DESC = { name: 'fx', proxyMode: {
  forms: [{ id: 'fx.app', os: ['darwin'], route: 'all', cert: 'hook', present: [{ command: 'fx-app' }] }, { id: 'fx.cli', os: ['darwin'], route: 'all', cert: 'root', present: [{ command: 'fx' }] }],
  certs: { hook: { kind: 'plugin' } }, routes: { all: {} },
} }

function cell({ present, item, root }) {
  const home = tmpDir('asight-setup-')
  const file = path.join(home, 'hook.mjs')
  fs.writeFileSync(file, 'asight hook\n')
  const rec = { kind: 'owned-file', role: 'plugin', harness: 'fx', phase: 'install', path: file, sha256: sha256(fs.readFileSync(file)) }
  const m = { version: 3, entries: [], files: item === 'none' ? [] : [rec], install: { harnesses: ['fx'], items: { fx: item === 'none' ? [] : [{ kind: rec.kind, path: file }] } } }
  if (item === 'hash-changed') fs.writeFileSync(file, 'the harness\'s own update\n')
  const ctx = { home, env: {}, which: (c) => (c === 'fx' || (present && c === 'fx-app') ? path.join(home, c) : null), exists: () => false }
  return setupOf(DESC, { os: 'darwin', manifest: m, ctx, root: { state: root }, fs })
}

test('V91 · 4.11 P4b: setup state per cell — an absent form is not counted, a root-carried form needs nothing, the carrier none → carrier-absent, changed → carrier-overwritten, the root missing → one root-missing; pending is not setup work', () => {
  for (const present of [true, false]) for (const item of ['none', 'intact', 'hash-changed']) for (const root of ['in-place', 'missing', 'pending']) {
    const want = [
      ...(present && item === 'none' ? [{ form: 'fx.app', what: 'carrier-absent' }] : []),
      ...(present && item === 'hash-changed' ? [{ form: 'fx.app', what: 'carrier-overwritten' }] : []),
      ...(root === 'missing' ? [{ form: null, what: 'root-missing' }] : []),
    ]
    const s = cell({ present, item, root })
    assert.deepEqual([s.state, s.missing], [want.length ? 'needed' : 'ready', want], JSON.stringify({ present, item, root }))
  }
})

test('V91 · D38: an install record, or a carrier file, that cannot be read gives unknown with a reason, never ready', () => {
  const ctx = { home: '/x', env: {}, which: () => '/x/fx', exists: () => false }
  const m = { version: 3, entries: [], files: [{ kind: 'owned-file', role: 'plugin', harness: 'fx', phase: 'install', path: '/x/hook.mjs', sha256: 'a' }], install: { harnesses: ['fx'], items: {} } }
  const denied = { ...fs, readFileSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) } }
  for (const s of [setupOf(DESC, { os: 'darwin', manifest: { error: 'EACCES' }, ctx, root: { state: 'in-place' }, fs }), setupOf(DESC, { os: 'darwin', manifest: m, ctx, root: { state: 'in-place' }, fs: denied })]) {
    assert.equal(s.state, 'unknown')
    assert.ok(s.reason)
  }
})
