#!/usr/bin/env node
// Fake Windows helper (RFC 4.8 §1): speaks the line protocol of src/collector/arch/win32/helper.ps1 from a JSON
// fixture, so helper.mjs is exercised end to end with a real child process and no Windows. usage:
//   ASIGHT_FAKE_HELPER=1 node fake-helper.mjs '<fixture json>'      (or a path to a .json file)
// fixture = {
//   ready: false            → exit before the ready line (a helper that could not start); `readyDelayMs`, `hangBeforeReady`
//   stderr: ['line', …]     → written to stderr first      exitCode: 3 → the code `exitAfter` / `ready:false` exit with
//   exitAfter: n            → exit once n requests were answered        log: '<file>' → every received line is appended
//   noise: ['text', …]      → non-JSON lines on stdout before the ready line     native: false, nativeError: '…' → the ready line says the native code did not compile
//   verbs: { <verb>: { data } | { seq: [data, …] } (successive answers, the last repeats) | { error } | { delayMs } | { hang } } }
// `tcp-table` honours the same filters the real helper does (pids, remotePort, localPort, states) on `data.rows`.
// node --test runs every file under test/: unless the driver sets ASIGHT_FAKE_HELPER=1 this exits at once.
import fs from 'node:fs'
import readline from 'node:readline'

if (process.env.ASIGHT_FAKE_HELPER !== '1') process.exit(0)

const arg = process.argv[2] || '{}'
const fx = JSON.parse(arg.trim().startsWith('{') ? arg : fs.readFileSync(arg, 'utf8'))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
for (const l of fx.stderr || []) process.stderr.write(l + '\n')
for (const l of fx.noise || []) process.stdout.write(l + '\n')
if (fx.ready === false) setTimeout(() => process.exit(fx.exitCode ?? 1), 10)
else if (fx.hangBeforeReady) setInterval(() => {}, 1000)
else setTimeout(() => {
  out({ ready: true, proto: fx.proto ?? 1, pid: process.pid, ps: 'fake', native: fx.native !== false, ...(fx.nativeError ? { nativeError: fx.nativeError } : {}) })
  listen()
}, fx.readyDelayMs || 0)

function listen() {
  let answered = 0
  const idx = new Map() // verb → how many answers were given (for seq)
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return
    if (fx.log) fs.appendFileSync(fx.log, line + '\n')
    let req
    try { req = JSON.parse(line) } catch { return out({ id: null, ok: false, error: 'bad-json' }) }
    const spec = (fx.verbs || {})[req.verb] || (req.verb === 'version' ? { data: { proto: 1, ps: 'fake', pid: process.pid, native: true } } : null)
    const reply = () => {
      if (!spec) out({ id: req.id, ok: false, error: `not in the fixture: ${req.verb}` })
      else if (spec.error) out({ id: req.id, ok: false, error: spec.error })
      else {
        let data = spec.data
        if (spec.seq) { const i = idx.get(req.verb) || 0; idx.set(req.verb, i + 1); data = spec.seq[Math.min(i, spec.seq.length - 1)] }
        if (req.verb === 'tcp-table' && data && data.rows) data = { ...data, rows: filterRows(data.rows, req.args || {}) }
        out({ id: req.id, ok: true, data })
      }
      if (fx.exitAfter != null && ++answered >= fx.exitAfter) setTimeout(() => process.exit(fx.exitCode ?? 0), 5)
    }
    if (spec && spec.hang) return
    if (spec && spec.delayMs) setTimeout(reply, spec.delayMs)
    else reply()
  }).on('close', () => process.exit(0))
}

function filterRows(rows, a) {
  const pids = Array.isArray(a.pids) && a.pids.length ? new Set(a.pids) : null
  const states = Array.isArray(a.states) && a.states.length ? new Set(a.states) : null
  return rows.filter((r) => (!pids || pids.has(r.pid)) && (!a.remotePort || r.remotePort === a.remotePort) && (!a.localPort || r.localPort === a.localPort) && (!states || states.has(r.state)))
}
