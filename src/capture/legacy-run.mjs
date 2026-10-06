// legacy-run.mjs — what `asight capture` (the reverse proxy) and `asight mitm` share about their own life (D38,
// transitional — deleted with the old capture; RFC 4.1 「过渡期采集源的失败也不静默」 落地细节 (3)(4)):
//   - the capture sink: envelopes go through createEnvelopeWriter (0600, synchronous append); a write that fails
//     never throws (it used to be a WriteStream with no 'error' listener: the process crashed, the buffered
//     envelopes were lost and launchd restarted it over and over, with a stack trace only in mitm.log). Each failed
//     write is one `sink` failure line naming the envelope id — never its bytes — and forwarding goes on;
//   - its lifecycle: mitm-start once listening, mitm-stop with the signal on SIGTERM / SIGINT / SIGHUP, and an
//     uncaught exception is a `crash` line (first stack line) before the non-zero exit. The board reads them per
//     `source` (src/health/read.mjs).
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
// process or home.
export function legacyLifecycle({ source, port, out, record = appendLegacyEvent, proc = process, log = (m) => process.stderr.write(m + '\n') }) {
  const stop = (signal) => { record({ event: 'mitm-stop', source, pid: proc.pid, port, signal }); proc.exit(0) }
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) proc.once(s, () => stop(s))
  proc.once('uncaughtException', (e) => {
    const stack = String((e && e.stack) || e)
    log(stack)
    record({ event: 'failure', where: source, code: 'crash', reason: stack.split('\n')[0] })
    proc.exit(1)
  })
  return { started(actualPort = port) { port = actualPort; record({ event: 'mitm-start', source, pid: proc.pid, port, out }) } }
}
