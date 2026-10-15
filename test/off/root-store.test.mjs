// test/off/root-store.test.mjs — CM7, the argv half (RFC 4.11 P3, plan §E.5 #3): the user root store's commands, generated over
// platform × op with an injected runner. Exact argv; never `-p` (an unrestricted root, M7 / M8); `-user` on every certutil call;
// never LocalMachine or a system keychain; the certificate file it hands the tool is gone afterwards.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rootStore, rootIdOf } from '../../src/off/root-store.mjs'
import { custodyStub } from '../helpers/custody-stub.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const stub = custodyStub(); const { rootDer } = stub.create()
const id = rootIdOf(rootDer)
const pemOf = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
const other = custodyStub(); other.create()
const FILE = '<file>'

// what each (platform, op) runs, with the store holding the root (present) or not
const KC = (home) => path.join(home, 'Library', 'Keychains', 'login.keychain-db')
const expected = {
  darwin: {
    add: (home) => [['security', ['add-trusted-cert', '-r', 'trustRoot', '-k', KC(home), FILE]]],
    has: (home) => [['security', ['find-certificate', '-a', '-Z', '-p', KC(home)]]],
    remove: (home, present) => [['security', ['find-certificate', '-a', '-Z', '-p', KC(home)]],
      ...(present ? [['security', ['remove-trusted-cert', FILE]], ['security', ['delete-certificate', '-Z', id.sha1, KC(home)]]] : [])],
  },
  win32: {
    add: () => [['certutil', ['-user', '-addstore', 'Root', FILE]]],
    has: () => [['certutil', ['-user', '-store', 'Root', id.sha1]]],
    remove: (home, present) => [['certutil', ['-user', '-store', 'Root', id.sha1]], ...(present ? [['certutil', ['-user', '-delstore', 'Root', id.sha1]]] : [])],
  },
}

function runner({ platform, present, files }) {
  const calls = []
  const run = (file, args) => {
    const a = args.map((x) => (x.endsWith('root-store-tmp.pem') ? (files.push(fs.readFileSync(x, 'utf8')), FILE) : x))
    calls.push([file, a])
    if (platform === 'darwin' && args[0] === 'find-certificate') return { status: 0, stdout: `SHA-1 hash: X\n${pemOf(other.rootDer)}${present ? `SHA-1 hash: ${id.sha1}\n${pemOf(rootDer)}` : ''}` }
    if (platform === 'win32' && args[1] === '-store') return { status: present ? 0 : 1, stdout: '' }
    return { status: 0, stdout: '' }
  }
  return { run, calls }
}

for (const platform of ['darwin', 'win32']) {
  for (const op of ['add', 'has', 'remove']) {
    for (const present of [true, false]) {
      test(`CM7 ${platform} ${op} (${present ? 'in the store' : 'not in the store'}): exact argv, user store only, no -p`, () => {
        const home = tmpDir('asight-rs-')
        const files = []
        const { run, calls } = runner({ platform, present, files })
        const store = rootStore({ platform, run, home })
        const out = op === 'add' ? store.add(rootDer) : store[op](id)
        assert.deepEqual(calls, expected[platform][op](home, present))
        for (const [, args] of calls) {
          assert.ok(!args.includes('-p') || args[0] === 'find-certificate', 'no -p on a trust write') // find-certificate's -p prints PEM
          assert.ok(!args.some((a) => /localmachine|System\.keychain|-d$/i.test(a)), `a machine store: ${args.join(' ')}`)
          if (platform === 'win32') assert.equal(args[0], '-user')
        }
        for (const f of files) assert.equal(f, pemOf(rootDer), 'the file handed over is the root')
        assert.ok(!fs.existsSync(path.join(home, '.asight', 'collector', 'root-store-tmp.pem')), 'the temp file is gone')
        if (op === 'has') assert.deepEqual(out, { present })
        else if (op === 'remove' && !present) assert.deepEqual(out, { ok: true, absent: true })
        else assert.deepEqual(out, { ok: true })
      })
    }
  }
}

test('CM7 a failing tool is a reason, never a throw; Linux has no user root store; Windows needs the thumbprint', () => {
  const home = tmpDir('asight-rs-')
  const run = () => ({ status: 5, stderr: 'User canceled' })
  assert.deepEqual(rootStore({ platform: 'darwin', run, home }).add(rootDer), { ok: false, reason: 'security add-trusted-cert failed (exit 5: User canceled)' })
  assert.match(rootStore({ platform: 'darwin', run, home }).has(id).error, /find-certificate failed/)
  assert.equal(rootStore({ platform: 'win32', run, home }).add(rootDer).ok, false)
  assert.throws(() => rootStore({ platform: 'linux', run, home }), /no user root store/)
  assert.throws(() => rootStore({ platform: 'win32', run, home }).has({ fp256: id.fp256 }), /thumbprint/)
})
