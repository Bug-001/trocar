// test/server/control-classes.test.mjs — the board's control plane (RFC 4.4 §控制面, 验收 8 · 10 · 11; 1.6 V91): the face relays /control/* to a
// real query worker (test/helpers/worker-fork.mjs) behind a real board socket, and the worker runs the CLI's own functions. Sandbox HOMEs only;
// what status asks of the machine is the deps module the worker is forked with (src/query/worker.mjs argv[3]), the same object the CLI side gets.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serveFace, request, withToken, TOKEN } from './face.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { fakeIo } from '../cli/fixtures/on-ctx.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { snapshot } from '../query/raw-home.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const STATUS_CTX = pathToFileURL(fileURLToPath(new URL('../cli/fixtures/status-ctx.mjs', import.meta.url))).href

/** A deps module for the worker: no daemon, an empty process table, no OS tool, the sandbox's own environment. → its path */
function depsModule(env) {
  const file = path.join(tmpDir('asight-deps-'), 'deps.mjs')
  fs.writeFileSync(file, `import { down, SOCK } from ${JSON.stringify(STATUS_CTX)}
export default { request: down(), socketPath: SOCK, procs: async () => [], lingerRead: () => ({ state: true }), user: 'alice',
  exec: () => ({ status: 0, stdout: '', stderr: '' }), platform: 'linux', env: ${JSON.stringify(env)} }
`)
  return file
}

const post = (port, p, body, headers = withToken()) => request(port, p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('V91: GET /control/status gives per harness the desired and the setup `status --json` gives on the same sandbox', async () => {
  const s = await installedHome()
  const file = depsModule({ ...s.sh.env, XDG_RUNTIME_DIR: path.join(s.home, 'run') })
  const deps = (await import(pathToFileURL(file).href)).default
  const io = fakeIo()
  await runStatusCli(['--json'], { io, home: s.home, platform: deps.platform, env: deps.env, deps })
  const doc = io.json()
  const f = await serveFace({ home: path.join(s.home, '.asight'), deps: file })
  try {
    const r = await request(f.port, '/control/status', { headers: withToken() })
    assert.equal(r.status, 200, r.body)
    const j = JSON.parse(r.body)
    assert.deepEqual([j.control, j.root, j.user], [true, false, doc.user])
    assert.ok(j.harnesses.length > 0)
    assert.deepEqual(j.harnesses, Object.entries(doc.harnesses).map(([harness, h]) => ({ harness, desired: h.desired, setup: h.setup })))
  } finally { f.close() }
})

test('4.4 #8: no token or a wrong one on /control/status and /control/classes is 403 and the worker gets no line', async () => {
  const home = tmpDir('asight-ctl-')
  const f = await serveFace({ home })
  try {
    for (const headers of [{}, { [CONTROL_TOKEN_HEADER]: `${TOKEN}x` }, { [CONTROL_TOKEN_HEADER]: '' }]) {
      assert.equal((await request(f.port, '/control/status', { headers })).status, 403)
      assert.equal((await post(f.port, '/control/classes', { kind: 'set', class: 'llm', keep: 'log' }, headers)).status, 403)
    }
    assert.deepEqual(f.relays, [])
    assert.deepEqual(snapshot(home), {})
  } finally { f.close() }
})

test('4.4 root: a daemon running as root mounts no control endpoint — status says root, POST /control/classes is 405, HOME unchanged', async () => {
  const home = tmpDir('asight-ctl-')
  const f = await serveFace({ home, uid: 0 })
  try {
    const r = await request(f.port, '/control/status', { headers: withToken() })
    assert.equal(r.status, 200)
    const j = JSON.parse(r.body)
    assert.deepEqual([j.control, j.root, j.harnesses, typeof j.user], [false, true, [], 'string'])
    assert.equal((await post(f.port, '/control/classes', { kind: 'set', class: 'llm', keep: 'log' })).status, 405)
    assert.deepEqual(f.relays, [])
    assert.deepEqual(snapshot(home), {})
  } finally { f.close() }
})

// ── POST /control/classes (4.4 #10 · #11) ─────────────────────────────────────────────────────────
const asightOf = (userHome) => path.join(userHome, '.asight')
/** Every file under `dir`, as bytes; `restore` puts exactly these back (the receipt names absolute paths, so the CLI's twin run is on the same HOME). */
function freeze(dir) {
  const out = new Map()
  const walk = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) walk(r); else out.set(r, fs.readFileSync(path.join(dir, r))) } }
  if (fs.existsSync(dir)) walk('')
  return out
}
function restore(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [r, b] of files) { fs.mkdirSync(path.dirname(path.join(dir, r)), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(dir, r), b, { mode: 0o600 }) }
}
const lastLog = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'classes.ndjson'), 'utf8').trim().split('\n').pop())

/** `asight classes <argv> --json` on `userHome` → its stdout bytes (what it prints into a pipe). */
async function cli(argv, userHome) {
  const { runCli } = await import('../../src/cli/main.mjs')
  const io = fakeIo()
  const exit = await runCli(['classes', ...argv, '--json'], { io, uid: 1000, platform: 'linux', home: userHome })
  return { exit, out: io.stdoutText() }
}

/** The ops, generated over the builtin table: each level of each class, a rule added (with and without a harness), its first rule removed, the class
 *  removed, a new class, reset. → [[body, argv]] */
async function ops() {
  const { BUILTIN } = await import('../../src/classes/table.mjs')
  const { RETENTION_LEVELS } = await import('../../src/capture/envelope.mjs')
  const out = []
  for (const c of BUILTIN) {
    for (const keep of RETENTION_LEVELS) out.push([{ kind: 'set', class: c.class, keep }, ['set', c.class, keep]])
    if (c.class === 'other') continue
    out.push([{ kind: 'add', class: c.class, host: 'api\\.example\\.com', path: '/v1/x' }, ['add', c.class, 'api\\.example\\.com', '/v1/x']])
    out.push([{ kind: 'add', class: c.class, host: 'h\\.example', harness: 'codex' }, ['add', c.class, 'h\\.example', '--harness', 'codex']])
    if (c.rules.length) out.push([{ kind: 'rm', class: c.class, rule: 1 }, ['rm', c.class, '1']])
    out.push([{ kind: 'rm', class: c.class }, ['rm', c.class]])
  }
  out.push([{ kind: 'add', class: 'catalog', host: 'models\\.example' }, ['add', 'catalog', 'models\\.example']])
  out.push([{ kind: 'reset' }, ['reset']])
  return out
}

test('4.4 #10 #11: per op, no confirm is 409 with the plan and HOME untouched; the confirmed receipt is the bytes `asight classes … --json` prints', async () => {
  const userHome = tmpDir('asight-ctlc-'), dir = asightOf(userHome)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const f = await serveFace({ home: dir })
  try {
    // two starting tables: the builtin one (no classes.json), and a table of yours (one edit made)
    for (const seed of [[], ['set', 'telemetry', 'log']]) {
      restore(dir, new Map())
      if (seed.length) assert.equal((await cli(seed, userHome)).exit, 0)
      const start = freeze(dir)
      for (const [body, argv] of await ops()) {
        const what = `${argv.join(' ')} (from ${seed.join(' ') || 'builtin'})`
        const asked = await post(f.port, '/control/classes', body)
        assert.equal(asked.status, 409, `${what}: ${asked.body}`)
        const plan = JSON.parse(asked.body)
        assert.equal(plan.need, 'confirm')
        assert.deepEqual([Array.isArray(plan.plan), plan.receipt.dry_run, typeof plan.plan_id], [true, true, 'string'], what)
        assert.deepEqual(plan.plan, plan.receipt.planned, what)
        assert.deepEqual(freeze(dir), start, `${what}: the plan wrote something`)
        const done = await post(f.port, '/control/classes', { ...body, confirm: plan.plan_id })
        assert.equal(done.status, 200, `${what}: ${done.body}`)
        assert.equal(lastLog(dir).source, 'board', what)
        restore(dir, start)
        const c = await cli(argv, userHome)
        assert.equal(c.exit, 0, what)
        assert.equal(done.body, c.out, `${what}: the board's receipt is the CLI's`)
        assert.equal(lastLog(dir).source, 'cli', what)
        restore(dir, start)
      }
    }
  } finally { f.close() }
})

test('4.4 #10: a bad op or a body that is not one JSON object is 400, and classes.json and the change log are byte-identical', async () => {
  const userHome = tmpDir('asight-ctlc-'), dir = asightOf(userHome)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  assert.equal((await cli(['set', 'telemetry', 'log'], userHome)).exit, 0)
  const start = freeze(dir)
  const f = await serveFace({ home: dir })
  try {
    const bad = [{ kind: 'set', class: 'nope', keep: 'log' }, { kind: 'set', class: 'llm', keep: 'most' }, { kind: 'add', class: 'other', host: 'x' },
      { kind: 'add', class: 'llm', host: '(' }, { kind: 'add', class: 'llm', host: 'x', harness: 'no-such-agent' }, { kind: 'rm', class: 'llm', rule: 99 },
      { kind: 'rm', class: 'other' }, { kind: 'rename', class: 'llm' }, { kind: 'set', class: 'BAD NAME', keep: 'log' },
      // a request body is any JSON: a field of another type is refused, never coerced into a name, a regex or a rule number
      { kind: 'add', class: 7, host: 'y\\.com' }, { kind: 'add', class: ['zz'], host: 'y\\.com' }, { kind: 'add', class: 'llm', host: {} },
      { kind: 'add', class: 'llm', host: 'x', path: ['/a', '/b'] }, { kind: 'rm', class: 'llm', rule: true }, { kind: 'rm', class: 'llm', rule: [1] }]
    for (const body of bad) {
      for (const confirm of [undefined, 'f'.repeat(64)]) {
        const r = await post(f.port, '/control/classes', { ...body, confirm })
        assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.body}`)
        assert.equal(typeof JSON.parse(r.body).error, 'string')
      }
    }
    for (const raw of ['not json', '[1]', 'null', JSON.stringify({ kind: 'reset', pad: 'x'.repeat(64 * 1024) })]) {
      assert.equal((await post(f.port, '/control/classes', raw)).status, 400, raw.slice(0, 20))
    }
    assert.deepEqual(freeze(dir), start)
  } finally { f.close() }
})

test('4.4 #10: a classes.json that cannot be read is a receipt with ok:false and its error — the CLI\'s bytes — and nothing is written', async () => {
  const userHome = tmpDir('asight-ctlc-'), dir = asightOf(userHome)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'classes.json'), '{"version":1,"classes":[', { mode: 0o600 })
  const start = freeze(dir)
  const f = await serveFace({ home: dir })
  try {
    const r = await post(f.port, '/control/classes', { kind: 'set', class: 'llm', keep: 'log' })
    assert.equal(r.status, 200, r.body)
    const doc = JSON.parse(r.body)
    assert.deepEqual([doc.ok, typeof doc.error.code], [false, 'string'])
    assert.deepEqual(freeze(dir), start)
    const c = await cli(['set', 'llm', 'log'], userHome)
    assert.equal(r.body, c.out)
    assert.deepEqual(freeze(dir), start)
  } finally { f.close() }
})

for (const body of [{ kind: 'set', class: 'telemetry', keep: 'log' }, { kind: 'reset' }]) test(`4.4 #11: a stale plan_id (the table changed between the two requests) is 409 with a new plan_id, and nothing is written: ${body.kind}`, async () => {
  const userHome = tmpDir('asight-ctlc-'), dir = asightOf(userHome)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  assert.equal((await cli(['set', 'llm', 'log'], userHome)).exit, 0) // classes.json exists before and after, so only its content differs
  const f = await serveFace({ home: dir })
  try {
    const first = JSON.parse((await post(f.port, '/control/classes', body)).body)
    assert.equal((await cli(['add', 'telemetry', 't\\.example'], userHome)).exit, 0)
    const between = freeze(dir)
    const r = await post(f.port, '/control/classes', { ...body, confirm: first.plan_id })
    assert.equal(r.status, 409, r.body)
    const again = JSON.parse(r.body)
    assert.equal(again.need, 'confirm')
    assert.notEqual(again.plan_id, first.plan_id)
    assert.deepEqual(freeze(dir), between)
  } finally { f.close() }
})
