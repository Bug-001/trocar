// CM8 (RFC 4.11 rule U, P4): install appends a marked block only to the user's own certificate file; uninstall takes exactly that block back out.
// Generated along the axes the row names: the file's form (LF, CRLF, BOM, no final line ending) × whether the user adds to it after install; and the
// files that are not the user's (read-only, owned by root — an injected owner —, inside a package manager's tree): no write, `not-users-file`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { modelWorld } from '../helpers/model-world.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { BLOCK_BEGIN } from '../../src/off/text-edit.mjs'

const USER_PEM = tls.rootCertificates[0].trim()
const FORMS = {
  lf: `${USER_PEM}\n`,
  crlf: `${USER_PEM.split('\n').join('\r\n')}\r\n`,
  bom: `﻿${USER_PEM}\n`,
  'no-eol': USER_PEM,
}
const LATER = '# the user adds this after install\n'

const codexWith = (rel) => modelWorld({ commands: ['codex'], env: (home) => ({ SSL_CERT_FILE: path.join(home, rel) }) })
const uninstall = (w) => undoHarnesses({ dir: w.dir, home: w.home, manifest: readManifest(w.dir), dropCa: true, procs: async () => [], roots: { node: [], osText: '' }, env: w.env })

for (const [form, bytes] of Object.entries(FORMS)) {
  for (const later of [false, true]) {
    test(`CM8 · ${form}${later ? ' · the user adds after install' : ''}: one marked block at the end; uninstall leaves the file byte for byte as the user has it`, async () => {
      const w = await codexWith('certs/mine.pem')
      const file = w.env.SSL_CERT_FILE
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
      const r = await w.install()
      const row = r.carriers.find((c) => c.carrier === 'pem-block')
      assert.equal(row && row.state, 'placed', JSON.stringify(r.carriers))
      const after = fs.readFileSync(file, 'utf8')
      assert.ok(after.startsWith(bytes), 'the user bytes stay in front, untouched')
      assert.equal(after.split(BLOCK_BEGIN).length, 2, 'exactly one block')
      assert.deepEqual((await w.install()).carriers.find((c) => c.carrier === 'pem-block').state, 'intact', 'a second install appends nothing')
      if (later) fs.appendFileSync(file, LATER)
      const u = await uninstall(w)
      assert.deepEqual(u.left, [], JSON.stringify(u.left))
      assert.equal(fs.readFileSync(file, 'utf8'), later ? `${bytes}${bytes.endsWith('\n') ? '' : '\n'}${LATER}` : bytes)
    })
  }
}

const NOT_USERS = {
  'read-only': (w, file) => { fs.chmodSync(file, 0o444); return {} },
  'owned by root (injected owner)': (w) => ({ owns: (p) => (p.includes('certs') ? false : w.owns(p)) }),
  "inside a package manager's tree": () => ({}),
}
for (const [name, setup] of Object.entries(NOT_USERS)) {
  test(`CM8 · ${name}: not the user's own file — not written, the carrier says not-users-file`, async () => {
    const w = await codexWith(name.includes('package') ? 'node_modules/x/certs/ca.pem' : 'certs/ca.pem')
    const file = w.env.SSL_CERT_FILE
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, FORMS.lf)
    const over = setup(w, file)
    const r = await w.install(over)
    const row = r.carriers.find((c) => c.carrier === 'pem-block')
    assert.deepEqual([row.state, row.code], ['skipped', 'not-users-file'], JSON.stringify(row))
    assert.equal(fs.readFileSync(file, 'utf8'), FORMS.lf, 'not one byte written')
    assert.equal(r.exit, 1, 'a carrier left out is a partial install')
  })
}
