// legacy-run.mjs — what `asight capture` (the reverse proxy) and `asight mitm` share about their own life (D38,
// transitional — deleted with the old capture; RFC 4.1 「过渡期采集源的失败也不静默」 落地细节 (3)(4)):
//   - the capture sink: envelopes go through createEnvelopeWriter (0600, synchronous append); a write that fails
//     never throws (it used to be a WriteStream with no 'error' listener: the process crashed, the buffered
//     envelopes were lost and launchd restarted it over and over, with a stack trace only in mitm.log). Each failed
//     write is one `sink` failure line naming the envelope id — never its bytes — and forwarding goes on;
//   - its lifecycle: mitm-start once listening, mitm-stop with the signal on SIGTERM / SIGINT / SIGHUP, and an
//     uncaught exception is a `crash` line (first stack line) before the non-zero exit. The board reads them per
//     `source` (src/health/read.mjs).
//   - its drain (RFC 1.6 §4 「旧 MITM 达到 off 保证的条件」): given its `server`, SIGTERM — which `launchctl unload` makes launchd send, a direct
//     SIGTERM to a KeepAlive agent is only relaunched — stops it accepting, waits for the connections already open to end by themselves for at most
//     `drainMs` (10 s; the old MITM does not follow response boundaries), then cuts what is left and says how many in `mitm-stop` as `cut`. SIGINT and
//     SIGHUP (a person at the terminal) stop at once, as before. The plist carries ExitTimeOut 15, so launchd waits for the drain before it kills.
import { createEnvelopeWriter } from './envelope.mjs'
import { appendLegacyEvent, failureOf } from './events.mjs'

export function createCaptureSink(out, { record = appendLegacyEvent, openWriter = createEnvelopeWriter } = {}) {
  let w = null, written = 0, lost = 0
  return {
    write(env) {
      try {
        if (!w) w = openWriter(out)
        w.write(env)
        written++
        return true
      } catch (e) {
        try { if (w) w.close() } catch { /* the fd is gone already */ }
        w = null // reopened on the next write: a full disk that frees up resumes the capture
        lost++
        record(failureOf('sink', e, 'record-error', { file: out, id: (env && env.id) || null,
          reason: `could not write an envelope to ${out} (${(e && e.message) || e}): this call is not captured (${lost} lost since start); the agent's request went through` }))
        return false
      }
    },
    close() { try { if (w) w.close() } catch { /* nothing left to save */ } w = null },
    get stats() { return { written, lost } },
  }
}

// started() — call once the server listens. `proc` and `record` are injectable so tests never touch the real
// process or home; `clock` ({ ms, sleep }) so a test does not wait ten seconds for a drain.
export function legacyLifecycle({ source, port, out, record = appendLegacyEvent, proc = process, log = (m) => process.stderr.write(m + '\n'), server = null, drainMs = 10000, clock = { ms: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } }) {
  const open = new Set() // the client connections open now: the only thing the MITM can count of what a stop would cut (it does not follow response boundaries)
  if (server) server.on('connection', (sock) => { open.add(sock); sock.once('close', () => open.delete(sock)) })
  const stopNow = (signal, extra = {}) => { record({ event: 'mitm-stop', source, pid: proc.pid, port, signal, ...extra }); proc.exit(0) }
  const drain = async (signal) => {
    try { server.close() } catch { /* not listening (yet): nothing to stop accepting */ }
    const end = clock.ms() + drainMs
    while (open.size > 0 && clock.ms() < end) await clock.sleep(100)
    const cut = open.size
    for (const sock of open) { try { sock.destroy() } catch { /* already gone */ } }
    stopNow(signal, { cut })
  }
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) proc.once(s, () => { if (server && s === 'SIGTERM') drain(s); else stopNow(s) })
  proc.once('uncaughtException', (e) => {
    const stack = String((e && e.stack) || e)
    log(stack)
    record({ event: 'failure', where: source, code: 'crash', reason: stack.split('\n')[0] })
    proc.exit(1)
  })
  return { started(actualPort = port) { port = actualPort; record({ event: 'mitm-start', source, pid: proc.pid, port, out }) } }
}
