// backend.test.mjs — the macOS OS-backend readers of T13 over injected runners (no real security / ps / procenv / plutil):
// the user root store's argv (CM7: the login keychain, no `-p`), the proc readers envOf / cwdOf / parentOf with their pid +
// start-time cache, and the managed-preference reader with the platform facts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'
import { userRootStore } from '../../../../src/collector/arch/darwin/root-store.mjs'
import { envOf, cwdOf, metaOf, parentOf } from '../../../../src/collector/arch/darwin/procinfo.mjs'
import { policyReader, platformFacts, dirsOf } from '../../../../src/collector/arch/darwin/policy.mjs'

/** A runner that answers by the command's basename and logs every call. */
function runner(answers) {
  const calls = []
  const run = (file, args, opts) => {
    calls.push({ tool: path.basename(file), file, args, env: opts.env })
    const a = answers[path.basename(file)]
    const r = typeof a === 'function' ? a(args) : a
    return { status: r ? r.code ?? 0 : 1, stdout: r ? r.out ?? '' : '', stderr: r ? r.err ?? '' : '' }
  }
  return { run, calls }
}

test('CM7: the darwin root store adds to the LOGIN keychain with trustRoot and no -p, through the injected runner', () => {
  const home = tmpDir('trocar-rs-')
  const c = custodyStub(); const { rootDer } = c.create()
  const { run, calls } = runner({ security: { out: '' } })
  assert.deepEqual(userRootStore({ home, run }).add(rootDer), { ok: true })
  const add = calls.find((x) => x.args[0] === 'add-trusted-cert')
  assert.deepEqual(add.args.slice(0, 4), ['add-trusted-cert', '-r', 'trustRoot', '-k'])
  assert.equal(add.args[4], path.join(home, 'Library', 'Keychains', 'login.keychain-db'))
  assert.ok(!add.args.includes('-p'), 'no -p: the trust is unrestricted (M7, M8)')
  assert.ok(!add.args.includes('-d'), 'never the admin (system) trust domain')
  assert.ok(calls.every((x) => !x.args.some((a) => /System\.keychain/.test(a))), 'never the System keychain')
})

test('proc readers: envOf asks procenv for the named variables only, keeps nothing else, exact case, the first entry winning; one read per pid + start + name set', () => {
  // The stub answers MORE than was asked (secrets included): nothing unrequested may come back or sit in the cache.
  const extra = 'ANTHROPIC_API_KEY=sk-secret\0OPENAI_API_KEY=sk-other\0'
  const { run, calls } = runner({ procenv: { out: `HTTPS_PROXY=http://a:1\0https_proxy=lower\0${extra}PATH=/bin\0HTTPS_PROXY=second\0EMPTY=\0junk\0` } })
  const cache = new Map()
  const o = { exec: run, cache, startedAt: 1700000000000, procenvPath: '/pkg/native/procenv' }
  const sets = [['HTTPS_PROXY', 'EMPTY', 'NO_PROXY'], ['https_proxy'], ['NO_PROXY', 'EMPTY', 'HTTPS_PROXY', 'EMPTY']]
  const want = { HTTPS_PROXY: 'http://a:1', https_proxy: 'lower', EMPTY: '' }
  for (const names of sets) {
    const got = envOf(42, names, o)
    assert.deepEqual(got, Object.fromEntries(names.filter((n) => n in want).map((n) => [n, want[n]])), names.join())
  }
  assert.equal(calls.length, 2, 'the same name set (any order, duplicates) is a cache hit; another set is another read')
  assert.deepEqual(calls[0].args, ['42', 'EMPTY', 'HTTPS_PROXY', 'NO_PROXY'], 'the names ride on argv: procenv answers only them')
  assert.deepEqual(calls[1].args, ['42', 'https_proxy'])
  assert.equal(calls[0].file, '/pkg/native/procenv')
  const held = JSON.stringify([...cache.entries()])
  for (const secret of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'sk-secret', 'PATH', '/bin']) assert.ok(!held.includes(secret), `cache holds no ${secret}`)
  assert.deepEqual(envOf(42, [], o), {}, 'no names: no read')
  assert.equal(calls.length, 2)
  envOf(42, ['PATH'], { ...o, startedAt: 1700000009000 }) // the pid reused by another process life
  assert.equal(calls.length, 3, 'another start time: read again')
  envOf(42, ['PATH'], { ...o, startedAt: null }); envOf(42, ['PATH'], { ...o, startedAt: null })
  assert.equal(calls.length, 5, 'no start time: never cached')
  const failing = runner({})
  assert.equal(envOf(7, ['PATH'], { exec: failing.run, cache, startedAt: 1 }), null)
  envOf(7, ['PATH'], { exec: failing.run, cache, startedAt: 1 })
  assert.equal(failing.calls.length, 2, 'a failed read is not cached')
})

test('proc readers: cwdOf and metaOf are the helper\'s `:cwd` / `:exe` — asked together, cached by pid + start, and a fact it cannot read is null', () => {
  const { run, calls } = runner({ procenv: { out: ':exe=/Users/me/bin/claude\0:cwd=/Users/me/my project\0' } })
  const cache = new Map()
  const o = { exec: run, cache, startedAt: 5, procenvPath: '/pkg/native/procenv' }
  assert.equal(cwdOf(42, o), '/Users/me/my project')
  assert.deepEqual(metaOf(42, o), { exe: '/Users/me/bin/claude', cwd: '/Users/me/my project' })
  assert.equal(calls.length, 1, 'the cwd and the exe come from ONE read, kept for the life of the process')
  assert.deepEqual(calls[0].args, ['42', ':cwd', ':exe'], 'names an environment entry cannot have, so the helper answers the two facts and no variable')
  assert.equal(calls[0].file, '/pkg/native/procenv')
  assert.equal(cwdOf(43, { exec: runner({}).run, cache }), null, 'the helper cannot read it (another user\'s): not known, never guessed')
  assert.deepEqual(metaOf(44, { exec: runner({ procenv: { out: ':exe=/bin/x\0' } }).run, cache, startedAt: 5 }), { exe: '/bin/x', cwd: null }, 'a fact absent from the answer is null')
})

test('proc readers: parentOf → the parent pid and the PARENT\'s start time (the key of the next step up); cached', () => {
  const rows = { 42: '  100 Mon Oct  5 09:01:02 2026', 100: '    1 Sun Oct  4 08:00:00 2026' }
  const { run, calls } = runner({ ps: (args) => (rows[args[1]] ? { out: rows[args[1]] } : { code: 1 }) })
  const cache = new Map()
  const p = parentOf(42, { exec: run, cache, startedAt: 9 })
  assert.deepEqual(p, { ppid: 100, startedAt: new Date('Sun Oct 4 08:00:00 2026').getTime() })
  assert.deepEqual(parentOf(42, { exec: run, cache, startedAt: 9 }), p)
  assert.equal(calls.length, 2, 'one ps for the pid, one for its parent; the second ask is a cache hit')
  assert.deepEqual(calls[0].args, ['-p', '42', '-o', 'ppid=,lstart='])
  assert.equal(parentOf(5, { exec: run, cache }), null, 'a gone pid')
})

test('policy: the per-user plist first, then the computer-wide one; only the declared key, via plutil -extract <key> json', () => {
  const files = new Set(['/MP/alice/com.example.app.plist', '/MP/com.example.app.plist'])
  const values = { '/MP/alice/com.example.app.plist': { other: 1 }, '/MP/com.example.app.plist': { ProxyUrl: 'http://corp:8080' } }
  const { run, calls } = runner({
    plutil: (args) => {
      const [, key, , , , file] = args
      const v = values[file]
      return key in v ? { out: JSON.stringify(v[key]) } : { code: 1, err: `Could not extract value, error: No value at that key path or invalid key path: ${key}` }
    },
  })
  const read = policyReader({ user: 'alice', run, exists: (f) => files.has(f), root: '/MP' })
  assert.deepEqual(read({ domain: 'com.example.app', key: 'ProxyUrl' }), { set: true, value: 'http://corp:8080', where: '/MP/com.example.app.plist' })
  assert.deepEqual(calls.map((c) => c.args), [
    ['-extract', 'ProxyUrl', 'json', '-o', '-', '/MP/alice/com.example.app.plist'],
    ['-extract', 'ProxyUrl', 'json', '-o', '-', '/MP/com.example.app.plist'],
  ])
  assert.deepEqual(read({ domain: 'com.example.app', key: 'other' }), { set: true, value: 1, where: '/MP/alice/com.example.app.plist' }, 'the user\'s file wins')
  assert.deepEqual(read({ domain: 'com.example.app', key: 'Missing' }), { set: false })
  assert.deepEqual(read({ domain: 'com.none', key: 'ProxyUrl' }), { set: false })
  const broken = policyReader({ user: 'alice', run: runner({ plutil: { code: 1, err: 'permission denied' } }).run, exists: () => true, root: '/MP' })
  assert.match(broken({ domain: 'com.example.app', key: 'k' }).error, /plutil -extract k failed/)
  assert.ok(read({ domain: '../etc', key: 'k' }).error, 'a domain is a name, not a path')
})

test('policy: platform facts and dirs (ruling ⑤: macOS has no persistent environment)', () => {
  assert.equal(platformFacts.envCaseInsensitive, false)
  assert.deepEqual(platformFacts.persistentEnv(['HTTPS_PROXY']), {})
  const home = tmpDir('trocar-pf-')
  assert.equal(platformFacts.pathKey(path.join(home, 'a', '..', 'b')), path.join(fs.realpathSync(home), 'b').toLowerCase(), 'the real path, resolved, folded (the default APFS volume is case-insensitive)')
  assert.deepEqual(dirsOf('/Users/u'), { appSupport: '/Users/u/Library/Application Support' })
})
