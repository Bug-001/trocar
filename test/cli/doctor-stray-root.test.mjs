// V125 · CM40, the doctor half (RFC 1.6 §3.7; 4.11 §3 ㉔): a trocar root the user's store holds and no install record lists (the record was
// deleted) is a `stray-root` problem of `doctor`, named by its fingerprint, fixed by `trocar uninstall` then `trocar install`; a store that cannot
// be listed is undetermined (exit 3), never none (D38). macOS and Windows alike: the injected store, never an OS tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { manifestPath } from '../../src/off/manifest.mjs'
import { fakeIo, recordingExec } from './fixtures/on-ctx.mjs'
import { down, SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

async function doctor(w, os, rootStore) {
  const io = fakeIo()
  const deps = { spawn: absentSpawn, has: () => true, request: down(), procs: async () => [], lingerRead: () => ({ state: true }), socketPath: SOCK, user: 'alice', exec: recordingExec().run, rootStore, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }) }
  const exit = await runDoctor(['--json'], { io, home: w.home, platform: os, env: { ...w.env, TROCAR_SOURCE: path.join(w.home, 'none') }, deps })
  return { exit, doc: JSON.parse(io.stdoutText()) }
}
const strays = (doc) => (doc.findings || []).filter((x) => x.code === 'stray-root')

for (const os of ['darwin', 'win32']) {
  test(`V125 · ${os}: doctor reports a trocar root no install record lists, says nothing of a listed one, and cannot judge a store it cannot list`, async () => {
    const w = await modelWorld({ os })
    await w.install()
    const { sha1 } = w.store.list().roots[0]
    const listed = await doctor(w, os, w.store)
    assert.deepEqual(strays(listed.doc), [], 'the root the record lists is no stray')

    fs.rmSync(manifestPath(w.dir))
    const r = await doctor(w, os, w.store)
    const f = strays(r.doc)
    assert.equal(f.length, 1, JSON.stringify(r.doc.findings))
    assert.equal(f[0].class, 'problem')
    assert.deepEqual(f[0].commands.map((c) => c.run), ['trocar uninstall', 'trocar install'])
    assert.ok(f[0].what.toLowerCase().includes(sha1.toLowerCase()), `the root is named by its thumbprint: ${f[0].what}`)
    assert.equal(r.exit, 1)

    const blind = await doctor(w, os, { ...w.store, has: (id) => w.store.has(id), list: () => ({ error: 'security find-certificate failed (exit 1)' }) })
    assert.deepEqual(strays(blind.doc), [], 'an unreadable store is not a finding')
    assert.ok(blind.doc.undetermined.some((u) => u.reason.includes('security find-certificate failed')), JSON.stringify(blind.doc.undetermined))
    assert.equal(blind.exit, 3)
    const threw = await doctor(w, os, { has: (id) => w.store.has(id), list: () => { throw new Error('certutil failed') } })
    assert.equal(threw.exit, 3, 'a listing that throws is not none either')
  })
}
