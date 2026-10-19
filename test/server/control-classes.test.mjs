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
