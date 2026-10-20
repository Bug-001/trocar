// exec.mjs — the one way code in `src/off/` and `src/cli/` runs an OS tool (launchctl, systemctl, security, certutil, loginctl, …).
//
// Every caller takes an optional `run` (the injected runner; a test's fake) and passes it here: with one, nothing is spawned.
// Without one this is `spawnSync` — except under `npm test`. 0.1 §3 「不碰真实机器」: a test that forgot to inject a runner must not
// reach the real launchctl / systemctl / security / certutil of the machine it runs on (the author's Mac is running the old capture
// while the tests run). `test/helpers/no-real-os.cjs`, which `npm test` preloads, sets ASIGHT_TEST_SANDBOX=1; then a spawn is allowed
// only when the file it would run, after symlinks, is inside the temp dir (a stub a test wrote on a PATH of its own), and anything
// else throws code ESANDBOX. The flag is read from the process as well as from the `env` handed in: a test that passes a bare env
// does not switch the guard off. The same preload also wraps `node:child_process`, so code that does not come through here is
// refused too; a refusal is written to the preload's ledger, and a test process that ends with a refusal nobody acknowledged
// (`takeRefusals()` in test/helpers/no-real-os.mjs) exits 1 — so a caller that catches ESANDBOX as "the tool failed" turns the
// test red instead of passing over a path it never ran. Callers MUST NOT catch ESANDBOX. Nothing but node:* is imported (0.1 §2).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFile, spawn } from 'node:child_process'

/** The file `file` names, on `PATH` (or as given when it holds a slash): null when it is nowhere. */
function lookupOnPath(file, PATH) {
  if (file.includes('/')) return file
  for (const dir of String(PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, file)
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch { /* next directory */ }
  }
  return null
}

/** Throws ESANDBOX unless `file` resolves, symlinks followed, to a file inside the temp dir. */
function refuseRealTool(file, args, env) {
  const found = lookupOnPath(file, env.PATH)
  let real = null
  try { real = found && fs.realpathSync(found) } catch { /* missing: refused below */ }
  const tmp = fs.realpathSync(os.tmpdir())
  if (real && real.startsWith(tmp + path.sep)) return
  const err = Object.assign(new Error(`refusing to run ${file} for real under npm test (0.1 §3): inject a runner, or put a stub on PATH inside the temp dir`), { code: 'ESANDBOX' })
  const ledger = globalThis[Symbol.for('asight.no-real-os')] // the preload's: absent when the flag was set by hand, or in production
  if (ledger && Array.isArray(ledger.refused)) ledger.refused.push({ tool: String(file), command: [file, ...args].join(' ').slice(0, 200), message: err.message })
  throw err
}

/** Runs `file args…` and returns `{ code, out, err }`: the exit code (null: killed by the timeout, by more output than `maxBuffer`
 *  — spawnSync's ENOBUFS, `out` then cut short —, or never started), stdout and stderr trimmed; when stderr is empty and the spawn
 *  itself failed, `err` is that error's message. `maxBuffer` (bytes) is spawnSync's own, 1 MiB when not given: a question about the
 *  whole process table passes more. `run(file, args, opts)` replaces the spawn (it returns what `spawnSync` does: `{ status, stdout,
 *  stderr, error? }`); what it throws is not caught. */
export function execTool(file, args, { run = null, env = process.env, input = null, timeoutMs = 10000, maxBuffer = undefined } = {}) {
  const opts = { encoding: 'utf8', env, input, timeout: timeoutMs, ...(maxBuffer ? { maxBuffer } : {}) }
  if (!run && (process.env.ASIGHT_TEST_SANDBOX === '1' || env.ASIGHT_TEST_SANDBOX === '1')) refuseRealTool(file, args, env)
  const r = (run || spawnSync)(file, args, opts)
  const shape = (x) => ({ code: x.status ?? null, out: String(x.stdout || '').trim(), err: String(x.stderr || (x.error && x.error.message) || '').trim() })
  return r && typeof r.then === 'function' ? r.then(shape) : shape(r) // an async runner (runAsync) gives the same shape, later
}

/** spawnSync's runner shape without blocking the event loop (a daemon that serves doors must not stop for an `lsof`): `execFile`, the
 *  same options execTool passes, resolving `{ status, stdout, stderr, error? }` — status null when it was killed (the timeout) or never started.
 *  `quiet` asks for no output and settles on the child's exit (`inherit`: the child writes on this process's own streams instead — a child
 *  that IS the command the user is running, `asight update`'s new code, §5.5 step 3); `windowsVerbatimArguments` is spawn's own (cmd's quoting).
 *  Pass it as execTool's `run`; it refuses a real tool under npm test the way execTool does (only a stub inside the temp dir runs). */
export function runAsync(file, args, opts = {}) {
  const env = opts.env || process.env
  if (process.env.ASIGHT_TEST_SANDBOX === '1' || env.ASIGHT_TEST_SANDBOX === '1') refuseRealTool(file, args, env)
  const win = { windowsVerbatimArguments: !!opts.windowsVerbatimArguments, windowsHide: true }
  if (opts.quiet) { // no output wanted: settle on exit, not on the pipes closing (a child it starts, a browser, may hold them for its whole life)
    return new Promise((resolve) => {
      const c = spawn(file, args, { env, stdio: opts.inherit ? 'inherit' : 'ignore', ...win })
      const t = opts.timeout ? setTimeout(() => { try { c.kill() } catch { /* gone */ } resolve({ status: null, stdout: '', stderr: '', error: new Error(`${file} did not return within ${opts.timeout / 1000} s`) }) }, opts.timeout) : null
      c.on('error', (error) => { clearTimeout(t); resolve({ status: null, stdout: '', stderr: '', error }) })
      c.on('exit', (code) => { clearTimeout(t); resolve({ status: code, stdout: '', stderr: '' }) })
    })
  }
  return new Promise((resolve) => {
    const c = execFile(file, args, { encoding: 'utf8', env, timeout: opts.timeout, maxBuffer: opts.maxBuffer || 1024 * 1024, ...win }, (error, stdout, stderr) =>
      resolve({ status: error ? (Number.isInteger(error.code) ? error.code : null) : 0, stdout, stderr, ...(error && !Number.isInteger(error.code) && !stderr ? { error } : {}) }))
    if (c.stdin) c.stdin.end(opts.input ?? undefined)
  })
}
