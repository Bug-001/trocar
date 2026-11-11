// scripts/browser-suite.mjs — `npm run test:browser [-- <file>…]`: the browser suite (Playwright on, one file at a time), or only the
// files named. Appending a file to the suite's globs ran the whole suite plus that file, ~40 min for one file (2026-10-23).
// The files run against a fresh build of web/ (1.2 §涉及源文件): built once into a temp dir, which the test face serves from memory exactly
// as the daemon serves the committed build (TROCAR_BOARD_DIR → createServer({ webDir })), removed after the run.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const files = process.argv.slice(2)
const suite = ['test/web-v2/browser/*.test.mjs', 'test/web-v2/browser/seq/*.test.mjs']
const preloads = ['flush-exit', 'leak-guard', 'no-real-os'].flatMap((p) => ['--require', `./test/helpers/${p}.cjs`])
// a test that names no timeout fails after 5 min, and the file then exits however its browser hangs (a WebKit close held one case and
// the run 24 min, 2026-11-06): leak-guard names and ends the browser left behind. The longest case without its own timeout takes ~75 s.
const BROWSER_TEST_MS = 5 * 60_000
const env = { ...process.env, TROCAR_PLAYWRIGHT: '1' }
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-board-'))
let status = 1
try {
  // npm's own CLI under this node when npm started us (npm_execpath), else npm through the shell on win32 (npm.cmd); the caller sets the priority
  const build = ['run', 'build:board', '--', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], npm = process.env.npm_execpath
  const b = npm ? spawnSync(process.execPath, [npm, ...build], { stdio: 'inherit' }) : spawnSync('npm', build, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (b.status !== 0) throw new Error('the board build failed')
  env.TROCAR_BOARD_DIR = out
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', `--test-timeout=${BROWSER_TEST_MS}`, ...preloads, ...(files.length ? files : suite)], { stdio: 'inherit', env })
  status = r.status ?? 1
} finally {
  fs.rmSync(out, { recursive: true, force: true })
}
process.exit(status)
