// scripts/test-browser.mjs — `npm run test:browser [-- <file>…]`: the browser suite (Playwright on, one file at a time), or only the
// files named. Appending a file to the suite's globs ran the whole suite plus that file, ~40 min for one file (2026-10-23).
import { spawnSync } from 'node:child_process'

const files = process.argv.slice(2)
const suite = ['test/web-v2/browser/*.test.mjs', 'test/web-v2/browser/seq/*.test.mjs']
const preloads = ['flush-exit', 'leak-guard', 'no-real-os'].flatMap((p) => ['--require', `./test/helpers/${p}.cjs`])
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...preloads, ...(files.length ? files : suite)],
  { stdio: 'inherit', env: { ...process.env, TROCAR_PLAYWRIGHT: '1' } })
process.exit(r.status ?? 1)
