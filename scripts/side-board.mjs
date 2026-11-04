// scripts/side-board.mjs — this clone's board over generated or real captures, apart from the installed daemon (RFC 1.12 §3).
//
//   node scripts/side-board.mjs --synthetic [--bytes <n>] [--board-dir <dir>] [--url-file <file>]
//   node scripts/side-board.mjs --real [--board-dir <dir>] [--url-file <file>]
//
// Both modes run the real createServer and createQueryService over a home in a temp dir, and only GET gets through. --real reads
// ~/.trocar through links and keeps its own index, so everything the worker writes lands in the temp dir. Ctrl-C removes the temp dir.
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from '../src/server.mjs'
import { createQueryService } from '../src/query/service.mjs'
import { generate } from './gen-dataset.mjs'

const DEMO = new URL('../samples/demo-session.ndjson', import.meta.url)
const DEMO_SEGMENT = '20260719T090000Z.ndjson'
const DEFAULT_BYTES = 20_000_000
const USAGE = 'usage: side-board --synthetic [--bytes <n>] | --real, then [--board-dir <dir>] [--url-file <file>]'
const say = (line) => process.stderr.write(`side-board: ${line}\n`)

/**
 * A home at `dest` that reads `realHome` and cannot write to it: one link per top-level entry, and a copy of index/ without the context
 * projections, every link followed (an index reached through a link would hand the worker the real one, a second writer, 4.3 §4).
 * The index can be rebuilt, so a file the daemon renames away mid-copy costs the copy, not the run.
 */
export function sideHome(realHome, dest) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 })
  const entries = fs.readdirSync(realHome, { withFileTypes: true })
  for (const e of entries) {
    if (e.name !== 'index') fs.symlinkSync(path.resolve(realHome, e.name), path.join(dest, e.name), e.isDirectory() ? 'junction' : 'file') // the type counts on Windows only
  }
  if (!entries.some((e) => e.name === 'index')) return
  const index = path.join(realHome, 'index'), copy = path.join(dest, 'index')
  try {
    fs.cpSync(index, copy, { recursive: true, dereference: true, filter: (p) => path.relative(index, p).split(path.sep)[0] !== 'ctx' })
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    fs.rmSync(copy, { recursive: true, force: true })
    fs.mkdirSync(copy, { mode: 0o700 })
    say('the index changed while it was copied: starting from an empty one, the worker rebuilds it')
  }
}

function syntheticHome(home, bytes) {
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(home, 'raw', DEMO_SEGMENT), fs.readFileSync(DEMO), { mode: 0o600 })
  generate({ home, bytes })
}

/** Read-only on every plane: a control verb, a static path and an unknown one alike, ahead of the face's own gates. */
function onlyGet(server) {
  const [face] = server.listeners('request')
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    if (req.method === 'GET') return face(req, res)
    res.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' }).end('{"error":"method not allowed"}')
  })
}

function publish(url, file) {
  if (!file) return process.stdout.write(`${url}\n`)
  fs.writeFileSync(`${file}.tmp`, `${url}\n`, { mode: 0o600 }) // a rename, so a reader never sees half of it and an older file's mode does not carry over
  fs.renameSync(`${file}.tmp`, file)
}

/** → the exit code when the run ends here; serving runs until a signal. */
async function main(argv) {
  let o
  try { o = parseArgs({ args: argv, options: { synthetic: { type: 'boolean' }, real: { type: 'boolean' }, bytes: { type: 'string', default: String(DEFAULT_BYTES) }, 'board-dir': { type: 'string' }, 'url-file': { type: 'string' } } }).values } catch (e) { say(e.message); say(USAGE); return 2 }
  const bytes = Number(o.bytes)
  if (Boolean(o.synthetic) === Boolean(o.real) || !Number.isInteger(bytes) || bytes <= 0) { say(USAGE); return 2 }
  const real = path.join(os.homedir(), '.trocar')
  if (o.real && !fs.existsSync(real)) { say(`${real} does not exist: nothing to read`); return 1 }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-side-')), home = path.join(tmp, '.trocar')
  const clean = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) // retries: the worker just killed may still be writing
  let svc = null, server = null
  const stop = () => { svc?.stop(); server?.close(); clean(); process.exit(0) }
  process.on('SIGINT', stop).on('SIGTERM', stop)
  try {
    if (o.real) sideHome(real, home); else syntheticHome(home, bytes)
    // Before the service exists: trocarHome() reads os.homedir(), and the worker inherits this environment.
    process.env.HOME = process.env.USERPROFILE = tmp
    const token = randomBytes(24).toString('hex')
    svc = createQueryService({ home, failure: (where, e) => say(`${where}: ${e.code}: ${e.message}`), say: (m) => process.stderr.write(`${m}\n`) })
    ;({ server } = createServer({ home, token, query: svc, webDir: o['board-dir'] }))
    onlyGet(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    publish(`http://127.0.0.1:${server.address().port}/#t=${token}`, o['url-file'])
  } catch (e) {
    svc?.stop()
    clean()
    say(e.message)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2))
  if (code !== undefined) process.exit(code)
}
