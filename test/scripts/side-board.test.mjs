// test/scripts/side-board.test.mjs — the side board (RFC 1.12 §3, AN5-AN8): the real script in its own process, on a real socket.
// Every home here is a temp one, the "real" home of --real included. The worker the script forks has no no-real-os preload, so these
// never ask `status` or `doctor`, the two names that read the machine (test/query/raw-home.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { within } from '../helpers/bounded.mjs'
import { request } from '../server/face.mjs'
import { snapshot } from '../query/raw-home.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { sideHome } from '../../scripts/side-board.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/side-board.mjs', import.meta.url))
const DEMO = fileURLToPath(new URL('../../samples/demo-session.ndjson', import.meta.url))
const SEGMENT = '20260719T090000Z'
const DEMO_SESSION = 'demo-0000-4a1b-9c2d-000000000001' // the session id in the sample's own request headers
const SMALL = ['--synthetic', '--bytes', '200000']
const START_MS = 120_000, EXIT_MS = 30_000, BUILD_MS = 120_000

/** The script's process in a temp HOME and a temp TMPDIR of its own, until it exits. */
function run(args, { home = tmpDir('trocar-sb-user-'), tmp = tmpDir('trocar-sb-tmp-') } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8').on('data', (c) => { out.stdout += c })
  child.stderr.setEncoding('utf8').on('data', (c) => { out.stderr += c })
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }))
  return { child, out, exited, tmp }
}

/** Runs `fn` against a started board and ends it with SIGINT; `urlOf` says where its address shows up. → the exit, and what it printed. */
async function withBoard(args, opts, fn, urlOf = (p) => p.out.stdout.split('\n')[0]) {
  const p = run(args, opts)
  try {
    const t0 = Date.now()
    let at = ''
    while (!(at = urlOf(p))) {
      assert.equal(p.child.exitCode, null, `the board exited before it served: ${p.out.stderr}`)
      assert.ok(Date.now() - t0 < START_MS, `no address after ${START_MS} ms: ${p.out.stderr}`)
      await new Promise((r) => setTimeout(r, 50))
    }
    const url = new URL(at.trim())
    const port = Number(url.port), token = url.hash.replace('#t=', '')
    assert.equal(url.hostname, '127.0.0.1')
    const raw = (where, method = 'GET') => request(port, where, { method, headers: { [CONTROL_TOKEN_HEADER]: token } })
    const get = async (name, params = {}) => {
      const r = await raw(`/api/${name}?${new URLSearchParams(params)}`)
      assert.equal(r.status, 200, `${name}: ${r.body.slice(0, 300)}`)
      return JSON.parse(r.body)
    }
    await fn({ raw, get, token, at, ...p })
    p.child.kill('SIGINT')
    const end = await within(p.exited, EXIT_MS, 'the board after SIGINT')
    return { ...end, ...p.out, tmp: p.tmp }
  } finally {
    if (p.child.exitCode === null && p.child.signalCode === null) { p.child.kill('SIGKILL'); await p.exited }
  }
}

/** A "real" ~/.trocar under a temp user home: an unsealed segment, its segment index, a collector dir and a top-level file. */
async function realHome() {
  const user = tmpDir('trocar-sb-real-'), home = path.join(user, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(home, 'collector'), { mode: 0o700 })
  fs.writeFileSync(path.join(home, 'raw', `${SEGMENT}.ndjson`), fs.readFileSync(DEMO), { mode: 0o600 })
  fs.writeFileSync(path.join(home, 'collector', 'control.json'), '{"port":1}\n', { mode: 0o600 })
  fs.writeFileSync(path.join(home, 'install.json'), '{}\n', { mode: 0o600 })
  await segmentIndex({ home, segment: SEGMENT, owner: true })
  assert.ok(fs.readdirSync(path.join(home, 'index')).length > 0, 'the real home has an index to copy')
  return { user, home }
}

const trocarSide = (tmp) => fs.readdirSync(tmp).filter((f) => f.startsWith('trocar-side-'))

test('AN5: --synthetic serves the demo session and the generated ones, SIGINT exits 0 and leaves no temp dir', { timeout: START_MS + EXIT_MS + 30_000 }, async () => {
  const end = await withBoard(SMALL, {}, async ({ get, tmp }) => {
    assert.equal(trocarSide(tmp).length, 1, 'the side home is a temp dir')
    const ids = (await get('sessions')).sessions.map((s) => s.session_id)
    assert.ok(ids.some((id) => id.includes(DEMO_SESSION)), `the demo session: ${ids}`)
    assert.ok(ids.some((id) => id.startsWith('ds-')), `the generated sessions: ${ids}`)
  })
  assert.deepEqual([end.code, end.signal], [0, null], end.stderr)
  assert.deepEqual(trocarSide(end.tmp), [])
})

test('AN6: --real answers every read over a real home, and that home keeps every byte and name', { timeout: START_MS + BUILD_MS + EXIT_MS + 30_000 }, async () => {
  const { user, home } = await realHome()
  const before = snapshot(home)
  const end = await withBoard(['--real'], { home: user }, async ({ get }) => {
    const { sessions } = await get('sessions')
    const id = sessions.find((s) => s.session_id.includes(DEMO_SESSION)).session_id
    const t0 = Date.now()
    let doc = await get('session', { id })
    for (; doc.pending; doc = await get('session', { id })) {
      assert.ok(Date.now() - t0 < BUILD_MS, `still pending: ${JSON.stringify(doc.pending)}`)
      await new Promise((r) => setTimeout(r, 100))
    }
    const lane = doc.lanes.find((l) => l.kind === 'main')?.lane
    assert.ok(lane, 'the session has a main lane')
    assert.equal((await get('lane', { id, lane })).lane, lane)
    assert.equal((await get('block', { ref: `${SEGMENT}:1` })).ok, true)
    for (const name of ['overview', 'classes', 'segments', 'traffic']) assert.equal((await get(name)).ok, true, name)
  })
  assert.deepEqual([end.code, end.signal], [0, null], end.stderr)
  assert.deepEqual(snapshot(home), before, 'the real home is byte for byte what it was, and a link followed on the way out took nothing with it')
  assert.equal(fs.existsSync(path.join(home, 'index', 'ctx')), false)
  assert.deepEqual(trocarSide(end.tmp), [])
})

test('AN7: every method but GET is 405 on the control, data and static planes, in both modes', { timeout: 2 * (START_MS + EXIT_MS) + 30_000 }, async () => {
  const { user } = await realHome()
  for (const [args, opts] of [[SMALL, {}], [['--real'], { home: user }]]) {
    await withBoard(args, opts, async ({ raw }) => {
      for (const where of ['/control/harness', '/api/sessions', '/']) {
        for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await raw(where, method)).status, 405, `${args[0]} ${method} ${where}`)
      }
    })
  }
})

test('AN8: --url-file holds the address and stdout does not, stdout is one line without it, --board-dir is the build served', { timeout: 2 * (START_MS + EXIT_MS) + 30_000 }, async () => {
  const dir = tmpDir('trocar-sb-url-'), file = path.join(dir, 'url')
  let token = null
  const quiet = await withBoard([...SMALL, '--url-file', file], {}, async ({ get, token: t }) => {
    token = t
    assert.ok(Array.isArray((await get('sessions')).sessions))
  }, () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''))
  assert.ok(token.length > 0)
  assert.equal(quiet.stdout.includes(token), false)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)

  const build = tmpDir('trocar-sb-web-'), page = '<!doctype html><title>a build of mine</title>\n'
  fs.writeFileSync(path.join(build, 'index.html'), page)
  const loud = await withBoard([...SMALL, '--board-dir', build], {}, async ({ raw, at }) => {
    assert.equal((await raw('/')).body, page)
    assert.match(at, /^http:\/\/127\.0\.0\.1:\d+\/#t=\S+$/)
  })
  assert.equal(loud.stdout.trimEnd().split('\n').length, 1, loud.stdout)
})

test('a run that names no one mode is refused with 2; --real with no ~/.trocar with 1', { timeout: 3 * EXIT_MS }, async () => {
  for (const [args, code] of [[[], 2], [['--real', '--synthetic'], 2], [['--real'], 1]]) {
    const p = run(args)
    assert.equal((await within(p.exited, EXIT_MS, `side-board ${args}`)).code, code, `${args}: ${p.out.stderr}`)
    assert.deepEqual(trocarSide(p.tmp), [])
  }
})

test('sideHome: a file gone from the real index mid-copy leaves an empty index of its own, and the links stand', async () => {
  const { home } = await realHome()
  fs.symlinkSync(path.join(home, 'no-such-file'), path.join(home, 'index', 'gone')) // what the copy meets when the daemon renames a file under it
  const side = path.join(tmpDir('trocar-sb-side-'), '.trocar')
  sideHome(home, side)
  assert.deepEqual(fs.readdirSync(path.join(side, 'index')), [])
  assert.equal(fs.lstatSync(path.join(side, 'index')).isSymbolicLink(), false)
  assert.equal(fs.realpathSync(path.join(side, 'raw')), fs.realpathSync(path.join(home, 'raw')))
})

test('sideHome: a top-level directory is a link, a file is a copy no write gets through, and what is neither stays out', async () => {
  const { home } = await realHome()
  const here = process.cwd(), pipe = net.createServer()
  process.chdir(home) // a relative socket path: a temp dir can be longer than a socket name may be
  try { pipe.listen('live.sock'); await once(pipe, 'listening') } finally { process.chdir(here) }
  try {
    const bytes = Buffer.from([0, 0xff, 0x0d, 0x0a])
    fs.writeFileSync(path.join(home, 'plain.json'), bytes)
    fs.mkdirSync(path.join(home, 'empty'))
    fs.symlinkSync(path.join(home, 'plain.json'), path.join(home, 'file-link'))
    fs.symlinkSync(path.join(home, 'raw'), path.join(home, 'dir-link'))
    fs.symlinkSync(path.join(home, 'no-such-file'), path.join(home, 'gone.tmp-1')) // what the walk meets when the daemon renames a file away
    const side = path.join(tmpDir('trocar-sb-side-'), '.trocar')
    sideHome(home, side)
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (e.name === 'index') continue
      const inSide = path.join(side, e.name), real = path.join(home, e.name)
      const st = fs.existsSync(real) && fs.statSync(real)
      if (st && st.isDirectory()) assert.equal(fs.realpathSync(inSide), fs.realpathSync(real), e.name)
      else if (st && st.isFile()) {
        assert.equal(fs.lstatSync(inSide).isSymbolicLink(), false, `${e.name} is not a link`)
        assert.deepEqual(fs.readFileSync(inSide), fs.readFileSync(real), e.name)
      } else assert.equal(fs.readdirSync(side).includes(e.name), false, `${e.name} stays out`)
    }
    fs.writeFileSync(path.join(side, 'plain.json'), 'side')
    assert.deepEqual(fs.readFileSync(path.join(home, 'plain.json')), bytes)
  } finally { pipe.close() }
})
