// `trocar update` on the script channel, end to end (RFC 1.6 §5.5 third branch, V111; D74⑧): the real CLI, placed by the real install.sh
// from a loopback registry, runs its own bundled install.sh --stage, `place`, and starts the new code through the real launcher. The new
// version's bin/trocar.mjs is a stand-in that answers --version and writes down the arguments it was started with — the new code's own
// finish (daemon, install, on) is not this test's: it is the existing finish path. The download failing first shows nothing changes then.
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
const run$ = promisify(execFile)
const skip = process.platform === 'win32' && 'install.sh is the macOS / Linux installer'
const { name, version: V } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const V2 = V.replace(/\d+$/, (n) => String(Number(n) + 1))
const sha = (algo, b) => crypto.createHash(algo).update(b).digest()

function go(file, args, env) {
  return new Promise((done) => {
    const c = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => done({ code, out, err }))
  })
}

test('script channel: update stages the new version before anything changes, places it, and starts it through the launcher', { skip, timeout: 180_000 }, async () => {
  const work = tmpDir('trocar-update-script-')
  // the sandbox lets trocar run only what sits in the temp dir: an `sh` there that is the system's
  fs.mkdirSync(path.join(work, 'bin'))
  fs.writeFileSync(path.join(work, 'bin', 'sh'), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 })
  const nv = process.versions.node, target = `${process.platform}-${process.arch}`, stem = `node-v${nv}-${target}`
  fs.mkdirSync(path.join(work, 'n', stem, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(work, 'n', stem, 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
  const nodeFiles = {}
  for (const [ext, z] of [['tar.gz', 'z'], ['tar.xz', 'J']]) {
    const f = path.join(work, `${stem}.${ext}`)
    try { await run$('tar', [`-c${z}f`, f, '-C', path.join(work, 'n'), stem]) } catch { continue }
    nodeFiles[`${stem}.${ext}`] = fs.readFileSync(f)
  }
  const pin = Object.entries(nodeFiles).map(([f, b]) => `${sha('sha256', b).toString('hex')}  ${f}\n`).join('')

  await run$('npm', ['pack', '--silent', '--pack-destination', work], { cwd: REPO, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } })
  const tgz = {}
  for (const [v, dir] of [[V, 'a'], [V2, 'b']]) {
    fs.mkdirSync(path.join(work, dir))
    await run$('tar', ['-xzf', path.join(work, `${name}-${V}.tgz`), '-C', path.join(work, dir)])
    const pkg = path.join(work, dir, 'package')
    fs.writeFileSync(path.join(pkg, 'install', 'node.sha256'), pin)
    if (v === V2) {
      const meta = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ ...meta, version: V2 }))
      fs.writeFileSync(path.join(pkg, 'bin', 'trocar.mjs'), `import fs from 'node:fs'\nif (process.argv[2] === '--version') console.log('trocar ${V2}')\nelse fs.writeFileSync(${JSON.stringify(path.join(work, 'started'))}, JSON.stringify(process.argv.slice(2)))\n`)
    }
    await run$('tar', ['-czf', path.join(work, `${dir}.tgz`), '-C', path.join(work, dir), 'package'])
    tgz[v] = fs.readFileSync(path.join(work, `${dir}.tgz`))
  }
  const routes = {}
  const up = await mockUpstream(routes)
  up.routes = routes
  try {
    const publish = (v) => {
      routes[`/r/${name}/latest`] = { body: JSON.stringify({ name, version: v, dist: { tarball: `${up.base}/r/${name}/-/${name}-${v}.tgz`, integrity: `sha512-${sha('sha512', tgz[v]).toString('base64')}` } }) }
      routes[`/r/${name}/-/${name}-${v}.tgz`] = { body: tgz[v] }
    }
    for (const [f, b] of Object.entries(nodeFiles)) routes[`/n/v${nv}/${f}`] = { body: b }
    publish(V)

    const home = tmpDir('trocar-update-script-home-')
    const env = { ...process.env, HOME: home, PATH: `${path.join(work, 'bin')}${path.delimiter}${process.env.PATH}`, TROCAR_REGISTRY: `${up.base}/r`, TROCAR_NODE_MIRROR: `${up.base}/n` }
    for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[k]
    const app = path.join(home, '.trocar', 'app'), launcher = path.join(home, '.trocar', 'bin', 'trocar')
    const handover = path.join(home, '.trocar', 'collector', 'update.json')
    const pointer = () => fs.readFileSync(path.join(app, 'current'), 'utf8')

    const first = await go('/bin/sh', [path.join(REPO, 'install', 'install.sh')], env)
    assert.equal(first.code, 0, first.err)
    assert.equal(pointer(), `${V} ${nv}-${target}\n`)

    publish(V2)
    delete routes[`/r/${name}/-/${name}-${V2}.tgz`] // the newest version cannot be downloaded: nothing changes
    const failed = await go(launcher, ['update', '--yes', '--json'], env)
    assert.equal(failed.code, 1, failed.err)
    assert.equal(JSON.parse(failed.out).error.code, 'installer-failed')
    assert.equal(failed.err, '', '--json: stderr stays empty')
    assert.equal(pointer(), `${V} ${nv}-${target}\n`)
    assert.ok(!fs.existsSync(handover) && !fs.existsSync(path.join(app, V2)))

    publish(V2)
    const updated = await go(launcher, ['update', '--yes', '--json'], env)
    assert.equal(updated.code, 0, updated.err + updated.out)
    assert.equal(pointer(), `${V2} ${nv}-${target}\n`)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work, 'started'), 'utf8')), ['update', '--yes', '--json'], 'the new code was started through the launcher, to finish')
    assert.deepEqual(JSON.parse(fs.readFileSync(handover, 'utf8')), { from: V, on: [] }, 'the handover the new code finishes from')
    assert.ok(fs.existsSync(path.join(app, V, 'bin', 'trocar.mjs')), 'the previous version is kept')
  } finally { up.close() }
})
