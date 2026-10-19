// board.mjs — `asight board` (RFC 1.6 §4.3, D66): the board is the daemon's, so this only prints its address with the token and opens it in the
// browser. In order: the install record (the daemon's own gate, daemonMayStart: none → exit 1, nothing written); the daemon up through the one
// seam `on` uses (ensureDaemonUp, with the arch's unit; the login registration is never touched); `GET /board` on the endpoint ensureDaemonUp
// resolved through controlEndpointFor (no platform branch here). `deps.unit` replaces the arch's unit, `deps.open(file, args)` the browser start (0.1 §3).
import nodeFs from 'node:fs'
import { spawn } from 'node:child_process'
import { EXIT } from '../off/schema.mjs'
import { collectorDir } from '../off/paths.mjs'
import { readManifest, daemonMayStart } from '../off/manifest.mjs'
import { wrap, WIDTH } from './text.mjs'

const errText = (e) => String((e && e.message) || e)
// the platform's own way to hand a URL to the default browser. The URL holds `#`, so cmd gets it quoted and verbatim (`start` takes a first quoted word for a title)
const OPENERS = { darwin: (u) => ['open', [u]], win32: (u) => ['cmd', ['/c', 'start', '""', `"${u}"`]], linux: (u) => ['xdg-open', [u]] }

const OPEN_WAIT_MS = 5000 // an opener with no desktop to open on never returns (win32 `cmd /c start` over ssh, lab 2026-10-20): past this it was not opened
/** The default browser start: resolves when the opener exited 0, rejects with why otherwise (no graphical session, no opener, no answer in OPEN_WAIT_MS). */
function openWith(file, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(file, args, { stdio: 'ignore', windowsVerbatimArguments: file === 'cmd', windowsHide: true })
    const t = setTimeout(() => { try { c.kill() } catch { /* gone */ } reject(new Error(`${file} did not return within ${OPEN_WAIT_MS / 1000} s`)) }, OPEN_WAIT_MS)
    c.on('error', (e) => { clearTimeout(t); reject(e) })
    c.on('exit', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(`${file} exited ${code}`)) })
  })
}

/** → the exit code: 0 the URL is printed · 1 the board is not there (not installed, the daemon did not come up, its port taken) · 2 a usage error. */
export async function run(argv, { io, env = process.env, home, platform = process.platform, args = { positionals: [] }, deps = {} }) {
  if (args.positionals.length) { io.err('asight board: it takes no arguments. Run: asight board'); return EXIT.usage }
  const fs = deps.fs || nodeFs, dir = collectorDir(home)
  let m = null
  try { m = readManifest(dir, fs) } catch { /* unreadable is not installed for this question; status and doctor say why */ }
  if (!daemonMayStart(m)) { io.err('asight board: asight is not installed on this machine. Run: asight install'); return EXIT.incomplete }
  const down = (why) => { io.err([...wrap(`asight board: the board is not running: ${why}`, WIDTH), 'Run: asight doctor'].join('\n')); return EXIT.incomplete }
  let unit = deps.unit
  if (unit === undefined) {
    const A = await (await import('../collector/arch/index.mjs')).loadArch(platform)
    unit = A.unit && A.unit.userUnit ? A.unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env }) : null
  }
  const { ensureDaemonUp } = await import('../collector/install.mjs')
  const up = await ensureDaemonUp({ osName: platform, dir, env, fs, unit, ...(deps.sleep ? { pause: deps.sleep } : {}) })
  if (!up.up) return down(up.problems[0] || up.notes[0] || 'the daemon did not start')
  let b
  try { b = await up.ask({ socketPath: up.sock, method: 'GET', path: '/board', timeoutMs: 5000 }) } catch (e) { return down(`the daemon did not answer GET /board (${errText(e)})`) }
  if (!b || b.state !== 'serving' || !b.port || !b.token) return down((b && b.reason) || `the daemon says the board is ${(b && b.state) || 'not there'}`)
  const url = `http://127.0.0.1:${b.port}/#t=${b.token}`
  const [file, list] = (OPENERS[platform] || OPENERS.linux)(url)
  try { await (deps.open || openWith)(file, list) } catch (e) {
    io.out([...wrap(`asight board: your browser could not be opened (${errText(e)}). Open this address yourself:`, WIDTH), url].join('\n'))
    return EXIT.ok
  }
  io.out(['asight board: opened in your browser:', url].join('\n')) // the URL on a line of its own: with the token it is 68+ columns (D58 80)
  return EXIT.ok
}
