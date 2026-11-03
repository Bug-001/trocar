// scripts/test-browser.mjs — `npm run test:browser [-- [--desk-next] <file>…]`: the browser suite (Playwright on, one file at a time), or
// only the files named. Appending a file to the suite's globs ran the whole suite plus that file, ~40 min for one file (2026-10-23).
// --desk-next: the same files against the desk-next build (1.2 §涉及源文件, D75③): built once into a temp dir, which the test face serves
// from memory exactly as the daemon serves the committed build (TROCAR_BOARD_DIR → createServer({ webDir })), removed after the run.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const deskNext = args.includes('--desk-next')
const files = args.filter((a) => a !== '--desk-next')
const suite = ['test/web-v2/browser/*.test.mjs', 'test/web-v2/browser/seq/*.test.mjs']
const preloads = ['flush-exit', 'leak-guard', 'no-real-os'].flatMap((p) => ['--require', `./test/helpers/${p}.cjs`])
const env = { ...process.env, TROCAR_PLAYWRIGHT: '1' }
const out = deskNext ? fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-desk-next-')) : null
let status = 1
try {
  if (out) {
    // npm's own CLI under this node when npm started us (npm_execpath), else npm through the shell on win32 (npm.cmd); the caller sets the priority
    const build = ['run', 'build:board', '--', '--mode', 'desk-next', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], npm = process.env.npm_execpath
    const b = npm ? spawnSync(process.execPath, [npm, ...build], { stdio: 'inherit' }) : spawnSync('npm', build, { stdio: 'inherit', shell: process.platform === 'win32' })
    if (b.status !== 0) throw new Error('the desk-next build failed')
    env.TROCAR_BOARD_DIR = out
  }
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...preloads, ...(files.length ? files : suite)], { stdio: 'inherit', env })
  status = r.status ?? 1
} finally {
  if (out) fs.rmSync(out, { recursive: true, force: true })
}
process.exit(status)
