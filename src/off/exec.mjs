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
import { spawnSync } from 'node:child_process'

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

/** Runs `file args…` and returns `{ code, out, err }`: the exit code (null: killed by the timeout, or never started), stdout and
 *  stderr trimmed; when stderr is empty and the spawn itself failed, `err` is that error's message. `run(file, args, opts)` replaces
 *  the spawn (it returns what `spawnSync` does: `{ status, stdout, stderr, error? }`); what it throws is not caught. */
export function execTool(file, args, { run = null, env = process.env, input = null, timeoutMs = 10000 } = {}) {
  const opts = { encoding: 'utf8', env, input, timeout: timeoutMs }
  if (!run && (process.env.ASIGHT_TEST_SANDBOX === '1' || env.ASIGHT_TEST_SANDBOX === '1')) refuseRealTool(file, args, env)
  const r = (run || spawnSync)(file, args, opts)
  return { code: r.status ?? null, out: String(r.stdout || '').trim(), err: String(r.stderr || (r.error && r.error.message) || '').trim() }
}
