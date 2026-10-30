// test/helpers/flush-exit.cjs — `--require` preload for `node --test --test-force-exit`: the forced exit waits for the reporter's
// output to leave the process before it takes the process down.
//
// `--test-force-exit` is how a test file ends while a DuckDB handle (which never lets the event loop empty) is still open. It
// calls `process.exit()` the moment the root test's reporter closes. But each test file runs in a child process whose reporter
// output (v8-serialized events) goes through an async generator and then a socket to the runner, and `process.exit()` drops
// whatever of that is still in flight. The runner counts only the events it received, so a file that ran 13 tests reports 5 or
// 8 of them, "0 fail" for the part it saw. Node 20 does not wait for the output at all (its whole `npm test` reported 1903 to
// 1924 tests where 1936 ran, and `journal.test.mjs` 6 of 13); Node 22 waits for the destination to close, which narrows the
// window and does not shut it (300 chatty tests in one file reported 294 to 299 on 8 of 25 runs). The runner process calls the same
// `process.exit()` when its own reporter closes, and its stdout (the TAP summary `count-tests.mjs` reads) loses its last bytes the
// same way when whoever reads it lags: 2 of 60 runs of four chatty files, piped, had no summary line.
//
// The fix is to do what the test runner's code should: when IT calls `process.exit()` (in the runner's process or in a test file's),
// let the event loop run until nothing has reached stdout for a few turns (the reporter pipeline hands its last events over in a
// handful of turns) and then until the writes already queued on stdout / stderr have completed, and only then exit. One such check
// is not enough: the pipeline can hand its last event to stdout after the queued writes completed, and a single check lost 1 to 3
// tests in about 3 of 10 runs on Node 20 with four chatty files in one runner (measured; test/helpers/flush-exit.test.mjs runs that
// case). So the exit waits for SETTLED_ROUNDS quiet-then-drained rounds in a row, and any byte written restarts the count (with
// three rounds 0 of 150 runs on Node 20 and 0 of 120 on Node 22 lost a test or the summary). Any other `process.exit()` (a fixture
// that calls `process.exit(0)` because its env var is unset, and expects execution to stop there) gets the real, immediate exit.
//
// Load it with the CLI flag `--require`, never NODE_OPTIONS: the tests spawn node processes of their own, and those would inherit
// it. `--require` runs in the runner's process and in every test file's process; `--import` runs only in the latter (the runner's
// own process loads only `--require` preloads), so it would leave the runner's exit as it was.
// Guard: test/helpers/flush-exit.test.mjs.

'use strict'

const QUIET_TURNS = 25 // consecutive event-loop turns with no new stdout bytes. The last bytes were seen 3 to 8 turns after the exit call.
const SETTLED_ROUNDS = 3 // quiet-then-drained rounds in a row, with nothing written in between, before the exit goes ahead
const BACKSTOP_MS = 5000 // a stdout nobody reads must not hold the process for ever

const realExit = process.exit
let exiting = false

/** True when the caller of `process.exit` is inside Node's test runner (its stack has `node:internal/test_runner/` frames). */
function calledByTestRunner() {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 50
  const stack = new Error().stack ?? ''
  Error.stackTraceLimit = limit
  return stack.includes('node:internal/test_runner/')
}

/** Calls `next` once everything written to `stream` so far has been handed to the OS (a write's callback runs after the ones before it). */
function drained(stream, next) {
  if (!stream || stream.destroyed || stream.writableEnded || !stream.writable) return next()
  try { stream.write('', next) } catch { next() }
}

process.exit = function exit(code) {
  if (code !== undefined) process.exitCode = code
  if (!calledByTestRunner()) return realExit.call(process, process.exitCode)
  if (exiting) return
  exiting = true
  const finish = () => { clearTimeout(backstop); realExit.call(process, process.exitCode) }
  const backstop = setTimeout(finish, BACKSTOP_MS)
  let quiet = 0
  let settled = 0
  let seen = process.stdout.bytesWritten
  const moved = () => { const now = process.stdout.bytesWritten; const m = now !== seen; seen = now; return m }
  const wait = () => {
    if (moved()) { quiet = 0; settled = 0 } else quiet++
    if (quiet < QUIET_TURNS) return setImmediate(wait)
    drained(process.stdout, () => {
      if (moved()) { quiet = 0; settled = 0; return setImmediate(wait) } // something was written while the queue drained: start over
      if (++settled < SETTLED_ROUNDS) { quiet = 0; return setImmediate(wait) }
      drained(process.stderr, finish)
    })
  }
  setImmediate(wait)
}
