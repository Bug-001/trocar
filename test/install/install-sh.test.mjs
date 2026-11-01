// install/install.sh against a loopback registry and Node mirror (spec 4.5 section A and acceptance 6-8, D74, 1.6 V109).
// The package is this repo's own `npm pack`, with install/node.sha256 swapped for a pin of a stand-in Node archive whose bin/node
// runs this test's node (and leaves a witness file, so "nothing was executed" is checkable). Only contracts: exit codes, the
// --stage / --check last line, what lands under ~/.trocar, and which requests the upstream saw.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { mockUpstream } from '../helpers/mock-upstream.mjs'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = path.join(REPO, 'install', 'install.sh')
const run$ = promisify(execFile)
const skip = process.platform === 'win32' && 'install.sh is the macOS / Linux installer'
const { name, version: V } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const sha = (algo, b) => crypto.createHash(algo).update(b).digest()

let work, up, nid, witness, other
const tgzPath = `/${name}/-/${name}-${V}.tgz`

test.before(async () => {
  if (skip) return
  work = tmpDir('trocar-install-sh-')
  witness = path.join(work, 'witness')
  const nv = process.versions.node, target = `${process.platform}-${process.arch}`, stem = `node-v${nv}-${target}`
  nid = `${nv}-${target}`
  const node = {}
  for (const kind of ['good', 'other']) { // other = a well-formed archive with different bytes: only the hash tells them apart
    fs.mkdirSync(path.join(work, kind, stem, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(work, kind, stem, 'bin', 'node'), `#!/bin/sh\n# ${kind}\necho ran >> '${witness}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
    for (const [ext, z] of [['tar.gz', 'z'], ['tar.xz', 'J']]) {
      const f = path.join(work, `${kind}-${stem}.${ext}`)
      try { await run$('tar', [`-c${z}f`, f, '-C', path.join(work, kind), stem]) } catch { continue } // GNU tar without xz: no .tar.xz line
      ;(node[kind] ||= {})[`${stem}.${ext}`] = fs.readFileSync(f)
    }
  }
  other = node.other
  await run$('npm', ['pack', '--silent', '--pack-destination', work], { cwd: REPO, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } }) // npm caches compiled code in the OS temp dir otherwise
  fs.mkdirSync(path.join(work, 'p'))
  await run$('tar', ['-xzf', path.join(work, `${name}-${V}.tgz`), '-C', path.join(work, 'p')])
  fs.writeFileSync(path.join(work, 'p', 'package', 'install', 'node.sha256'), Object.entries(node.good).map(([f, b]) => `${sha('sha256', b).toString('hex')}  ${f}\n`).join(''))
  await run$('tar', ['-czf', path.join(work, 'pkg.tgz'), '-C', path.join(work, 'p'), 'package'])
  const tgz = fs.readFileSync(path.join(work, 'pkg.tgz'))
  const routes = {}
  up = await mockUpstream(routes)
  const packument = JSON.stringify({ name, version: V, dist: { tarball: `${up.base}/r1${tgzPath}`, integrity: `sha512-${sha('sha512', tgz).toString('base64')}` } })
  for (const r of ['r1', 'r2']) { routes[`/${r}/${name}/latest`] = { body: packument }; routes[`/${r}${tgzPath}`] = { body: tgz } }
  for (const [f, b] of Object.entries(node.good)) for (const m of ['n1', 'n2']) routes[`/${m}/v${nv}/${f}`] = { body: b }
  up.routes = routes
})
test.after(() => up?.close())

/** Runs the installer with a fresh (or given) HOME; `input` pipes that text to `sh -s` instead of passing the file. */
function install(args, { home = tmpDir('trocar-install-home-'), shell = 'sh', input, path: PATH = process.env.PATH } = {}) {
  const env = { ...process.env, HOME: home, PATH, TROCAR_REGISTRY: `${up.base}/r1 ${up.base}/r2`, TROCAR_NODE_MIRROR: `${up.base}/n1 ${up.base}/n2` }
  for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[k]
  const asked = up.requests.length
  return new Promise((done) => {
    const c = spawn(shell, input === undefined ? [SCRIPT, ...args] : ['-s', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
    c.stdin.end(input ?? '')
    c.on('close', (code) => done({ code, out, err, home, app: path.join(home, '.trocar', 'app'), asked: up.requests.slice(asked) }))
  })
}
const last = (s) => s.trim().split('\n').at(-1)
const metaOnly = (asked) => asked.every((r) => r.path.endsWith(`/${name}/latest`))

test('a staged install verifies, gates and places one version; a re-run asks for the package record only', { skip }, async () => {
  const shells = ['sh', ...(fs.existsSync('/bin/dash') ? ['/bin/dash'] : [])]
  for (const shell of shells) {
    const r = await install(['--stage'], { shell })
    assert.equal(r.code, 0, `${shell}: ${r.err}`)
    assert.equal(last(r.out), `trocar-installer: staged ${V} ${path.join(r.app, V)}`)
    assert.ok(fs.existsSync(path.join(r.app, V, 'bin', 'trocar.mjs')) && fs.existsSync(path.join(r.app, 'node', nid, 'bin', 'node')))
    assert.ok(!fs.existsSync(path.join(r.app, 'current')), '--stage does not switch the pointer')
    assert.deepEqual(fs.readdirSync(r.app).filter((f) => f.startsWith('.staging-')), [])
    assert.deepEqual(fs.readdirSync(path.join(r.app, '.dl')), [])

    const again = await install(['--stage'], { home: r.home, shell })
    assert.equal(again.code, 0, again.err)
    assert.ok(metaOnly(again.asked), 'a placed version is complete: nothing is downloaded again')
    fs.writeFileSync(path.join(r.app, 'current'), `${V} ${nid}\n`) // what `trocar place` leaves
    const done = await install([], { home: r.home, shell })
    assert.equal(done.code, 0, done.err)
    assert.ok(metaOnly(done.asked))
    assert.ok(done.err.includes(`${path.join(r.home, '.trocar', 'bin', 'trocar')} update`), 'an up-to-date re-run still names the next command')
    assert.equal(last((await install(['--stage'], { home: r.home, shell })).out), `trocar-installer: up-to-date ${V}`)
  }
})

test('a truncated script runs nothing: no request, nothing written', { skip }, async () => {
  const text = fs.readFileSync(SCRIPT, 'utf8')
  const tail = text.lastIndexOf('{ main')
  for (const cut of [Math.floor(text.length / 3), Math.floor(text.length / 2), tail, tail + 6, text.lastIndexOf('}')]) {
    const r = await install([], { input: text.slice(0, cut) })
    assert.deepEqual(r.asked, [], `cut at ${cut}`)
    assert.deepEqual(fs.readdirSync(r.home), [], `cut at ${cut}`)
  }
})

test('bytes that match no hash on any source: exit 1, nothing placed or run, the pointer unchanged', { skip }, async () => {
  const good = {}
  for (const [p, r] of Object.entries(up.routes)) if (p.startsWith('/n')) { good[p] = r.body; r.body = other[path.basename(p)] }
  try {
    const home = tmpDir('trocar-install-home-')
    fs.mkdirSync(path.join(home, '.trocar', 'app'), { recursive: true })
    fs.writeFileSync(path.join(home, '.trocar', 'app', 'current'), '0.0.1 old\n')
    fs.rmSync(witness, { force: true })
    const r = await install([], { home })
    assert.equal(r.code, 1, r.err)
    assert.ok(!fs.existsSync(path.join(r.app, V)) && !fs.existsSync(path.join(r.app, 'node', nid)))
    assert.equal(fs.readFileSync(path.join(r.app, 'current'), 'utf8'), '0.0.1 old\n')
    assert.ok(!fs.existsSync(witness), 'the downloaded Node never ran')
  } finally { for (const [p, b] of Object.entries(good)) up.routes[p].body = b }
})

test('a download cut off on the first source resumes on the next with a Range request', { skip }, async () => {
  const r1 = up.routes[`/r1${tgzPath}`]
  r1.cut = Buffer.from(r1.body).length >> 1
  try {
    const r = await install(['--stage'])
    assert.equal(r.code, 0, r.err)
    assert.ok(r.asked.some((q) => q.path === `/r2${tgzPath}` && q.range === `bytes=${r1.cut}-`), JSON.stringify(r.asked))
  } finally { delete r1.cut }
})

test('root is refused before anything is asked or written', { skip }, async () => {
  const bin = tmpDir('trocar-install-bin-')
  fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\n[ "$1" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n', { mode: 0o755 })
  const r = await install([], { path: `${bin}:${process.env.PATH}` })
  assert.equal(r.code, 2)
  assert.deepEqual(r.asked, [])
  assert.deepEqual(fs.readdirSync(r.home), [])
})
