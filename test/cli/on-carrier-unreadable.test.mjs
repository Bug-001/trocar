// 1.6 §1.1: a note says what is so in words; a file error is said in 1.6 A.1's words, its errno kept as a code. `on` for a harness whose installed carrier cannot be read (pi's extension, its directory not
// readable) keeps the errno as the note's `code` and the file in it, and does not print Node's error text as its sentence. The denial is an injected
// fs in each platform's own shape: EACCES on macOS, EPERM on Windows.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { unknownWords, errnoWords } from '../../src/cli/words.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'

const neverStarts = { path: '/nowhere/unit', text: () => '', registered: () => ({ state: 'present' }), enable: () => ({ code: 1 }), start: () => ({ code: 1 }), startNow: () => ({ code: 1 }) }
const READS = new Set(['readFileSync', 'openSync', 'readdirSync'])
/** fs whose reads under `dir` throw `code` the way Node does (code, syscall, path); everything else is the real fs. */
const denying = (dir, code) => new Proxy(fs, { get: (t, k) => (READS.has(k) ? (p, ...a) => { if (String(p).startsWith(dir)) throw Object.assign(new Error(`${code}: operation not permitted, open '${p}'`), { code, syscall: 'open', path: String(p) }); return t[k](p, ...a) } : t[k]) })

for (const [os, code] of [['darwin', 'EACCES'], ['win32', 'EPERM']]) {
  test(`on (${os}): a carrier that cannot be read is a note with the errno as its code and the file in its words, not Node's message`, async () => {
    const w = await modelWorld({ os, env: (home) => ({ PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent') }) })
    fs.mkdirSync(path.join(w.home, '.pi', 'agent', 'install'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.pi', 'agent', 'install', 'current-version'), '1\n')
    assert.equal((await w.install()).exit, 0)
    const ext = path.join(w.home, '.pi', 'agent', 'extensions')
    assert.ok(fs.readdirSync(ext).length, 'install placed the extension')
    const io = fakeIo()
    const deps = { fs: denying(ext, code), getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os, harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
    await runOnCli(['pi', '--dry-run', '--json'], { io, env: w.env, home: w.home, platform: os, deps })
    const notes = JSON.parse(io.stdoutText()).notes.filter((n) => n && n.harness === 'pi')
    assert.equal(notes.length, 1, JSON.stringify(notes))
    const [n] = notes
    assert.equal(n.code, code, 'the errno is the note\'s code')
    assert.ok(n.text.includes(ext), `the file is named: ${n.text}`)
    assert.ok(n.text.includes(unknownWords('denied')), `1.6 A.1's words for a denied read: ${n.text}`)
    assert.ok(!n.text.includes(code), `the errno is the code, not the sentence: ${n.text}`)
  })
}

test('errnoWords: a denied file (EACCES, or EPERM on Windows) and a missing one read in 1.6 A.1\'s words; any other errno is not printed', () => {
  const err = (code) => Object.assign(new Error(`${code}: raw`), { code })
  assert.equal(errnoWords(err('EACCES')), unknownWords('denied'))
  assert.equal(errnoWords(err('EPERM')), unknownWords('denied'))
  assert.equal(errnoWords(err('ENOENT')), unknownWords('absent'))
  for (const verb of ['read', 'write']) for (const code of ['EACCES', 'EPERM', 'ENOENT', 'EIO']) assert.ok(!/E[A-Z]{2,}|raw/.test(errnoWords(err(code), verb)), `${code} ${verb}`)
})

test('on (darwin): a Claude Code settings file that cannot be written is a route not written, its reason in words and its errno as code', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['claude'] })
  const settings = path.join(w.home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settings), { recursive: true }); fs.writeFileSync(settings, '{}\n')
  assert.equal((await w.install()).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 'k'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: { 'GET /status': async () => ({ doors: {} }), 'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }) } })
  // the shape a read-only ~/.claude gives: the open of the file written next to settings.json is denied
  const deny = new Proxy(fs, { get: (t, k) => (k === 'openSync' ? (p, flags, ...a) => { if (String(p).startsWith(settings) && /[wa]/.test(String(flags))) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES', syscall: 'open', path: String(p) }); return t.openSync(p, flags, ...a) } : t[k]) })
  try {
    const r = await turnOnModel({ os: 'darwin', home: w.home, env: w.env, harnesses: w.harnesses, ctx: w.ctx, fs: deny, isFree: async () => true, renderHook, ids: ['claude-code'] })
    const [route] = r.routes.filter((x) => x.harness === 'claude-code' && !x.ok)
    assert.ok(route, JSON.stringify(r.routes))
    assert.equal(route.code, 'EACCES', 'the errno is kept as the code')
    assert.equal(route.at, settings, 'the file named is the settings file')
    assert.ok(!route.reason.includes('EACCES'), `no raw errno or Node message: ${route.reason}`)
  } finally { server.close() }
})
