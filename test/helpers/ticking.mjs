// test/helpers/ticking.mjs — a child process waited on while it makes progress, never for a fixed window.
//
// A read or a fold in a child of its own takes as long as the machine gives it CPU: a fixed window measures the machine's load, not
// the child, and a loaded full run cancels a test that sits near its window. So a wait on such a child lasts while the child reports
// progress (TICK: a byte on its progress pipe, as it reads or folds a record and between its phases; a line on its stdout) and fails
// after STALL ms with none — a child that hangs or is stopped fails loudly, a slow one is waited for.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { whileMoving } from './bounded.mjs'

/** The first line of a child script (`node -e`) that reports progress: `tick()` writes one byte to the progress pipe `child()` gave
 *  it, at most every 100 ms (a synchronous write: nothing is queued in the heap a test measures); without that pipe it does nothing. */
export const TICK = `const tick = ((write, fd, t = 0) => () => { const n = Date.now(); if (fd && n - t >= 100) { t = n; try { write(fd, '.') } catch {} } })((await import('node:fs')).writeSync, Number(process.env.TROCAR_TICK_FD) || 0); delete process.env.TROCAR_TICK_FD`

/** child(args, what) → {next(), send(line), stop()}: `node args` with a progress pipe for TICK. `next()` is its next stdout line,
 *  parsed as JSON, waited for while the child ticks or writes; `send` writes a line to its stdin; `stop()` ends it and waits until
 *  it is gone. */
export function child(args, what) {
  const p = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env: { ...process.env, TROCAR_TICK_FD: '3' } })
  const lines = []
  let moved = 0, end = null
  p.stdio[3].on('data', (b) => { moved += b.length })
  createInterface({ input: p.stdout, crlfDelay: Infinity }).on('line', (l) => { lines.push(l); moved++ })
  const closed = new Promise((r) => p.on('close', (code, sig) => { end = sig || code; r() }))
  p.stdin.on('error', () => {}) // a child that ended does not read what is sent: next() says it ended
  return {
    async next() {
      await whileMoving(() => lines.length > 0 || end !== null, () => moved, what)
      if (!lines.length) throw new Error(`${what}: the child ended (${end})`)
      return JSON.parse(lines.shift())
    },
    send(line) { p.stdin.write(`${line}\n`) },
    async stop() { p.stdin.end(); if (end === null) p.kill('SIGKILL'); await closed },
  }
}

/** once(args, what) → the one line a child that answers once writes, waited for as `child` waits; the child is gone when it returns. */
export async function once(args, what) {
  const c = child(args, what)
  try { return await c.next() } finally { await c.stop() }
}
