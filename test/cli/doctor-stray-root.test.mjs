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
import { rootIdOf } from '../../src/off/root-store.mjs'
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
    const { sha1, fp256 } = w.store.list().roots[0]
    const listed = await doctor(w, os, w.store)
    assert.deepEqual(strays(listed.doc), [], 'the root the record lists is no stray')

    fs.rmSync(manifestPath(w.dir))
    const r = await doctor(w, os, w.store)
    const f = strays(r.doc)
    assert.equal(f.length, 1, JSON.stringify(r.doc.findings))
    assert.equal(f[0].class, 'problem')
    assert.deepEqual(f[0].commands.map((c) => c.run), ['trocar uninstall', 'trocar install'])
    assert.ok(f[0].what.toLowerCase().includes((fp256 || sha1).toLowerCase()), `the root is named as install and uninstall name it: ${f[0].what}`)
    assert.equal(r.exit, 1)

    const blind = await doctor(w, os, { ...w.store, has: (id) => w.store.has(id), list: () => ({ error: 'security find-certificate failed (exit 1)' }) })
    assert.deepEqual(strays(blind.doc), [], 'an unreadable store is not a finding')
    assert.ok(blind.doc.undetermined.some((u) => u.reason.includes('security find-certificate failed')), JSON.stringify(blind.doc.undetermined))
    assert.equal(blind.exit, 3)
    const threw = await doctor(w, os, { has: (id) => w.store.has(id), list: () => { throw new Error('certutil failed') } })
    assert.equal(threw.exit, 3, 'a listing that throws is not none either')
  })
}

// D62 (1.6 §3.7): on Windows the listing and the question `status` asks (is the recorded root there?) read the same `certutil -user -store Root`
// output, so doctor starts it once. The store is the real one (src/off/root-store.mjs) over an injected runner that answers a listing.
test('V125 · win32: doctor answers both root questions from one certutil listing of the user store', async () => {
  const w = await modelWorld({ os: 'win32' })
  await w.install()
  const pem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'))
  const { sha1 } = rootIdOf(pem)
  const listing = ['Root "Trusted Root Certification Authorities"', '================ Certificate 0 ================', 'Serial Number: 01', 'Issuer: CN=trocar local root', 'Subject: CN=trocar local root', `Cert Hash(sha1): ${sha1.toLowerCase()}`, 'CertUtil: -store command completed successfully.'].join('\r\n')
  for (const recorded of [true, false]) {
    if (!recorded) fs.rmSync(manifestPath(w.dir))
    const lists = []
    const exec = (file, args) => { if (file === 'certutil' && args.join(' ') === '-user -store Root') { lists.push(args); return { status: 0, stdout: listing, stderr: '' } } return { status: 0, stdout: '', stderr: '' } }
    const io = fakeIo()
    const deps = { spawn: absentSpawn, has: () => true, request: down(), procs: async () => [], lingerRead: () => ({ state: true }), socketPath: SOCK, user: 'alice', exec, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }) }
    await runDoctor(['--json'], { io, home: w.home, platform: 'win32', env: { ...w.env, TROCAR_SOURCE: path.join(w.home, 'none') }, deps })
    const doc = JSON.parse(io.stdoutText())
    assert.equal(doc.status.cert.root.state, 'in-place', JSON.stringify(doc.status.cert))
    assert.equal(strays(doc).length, recorded ? 0 : 1, JSON.stringify(doc.findings))
    assert.equal(lists.length, 1, 'one listing of the user store per doctor run')
  }
})
