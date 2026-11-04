// scripts/test-build.mjs — `npm run test:build`: the board build check (test/web/board-build.test.mjs) with TROCAR_BUILD_CHECK=1,
// set here so the script line is the same on every OS.
import { spawnSync } from 'node:child_process'

const preloads = ['flush-exit', 'leak-guard', 'no-real-os'].flatMap((p) => ['--require', `./test/helpers/${p}.cjs`])
const r = spawnSync(process.execPath, ['--test', ...preloads, 'test/web/board-build.test.mjs'],
  { stdio: 'inherit', env: { ...process.env, TROCAR_BUILD_CHECK: '1' } })
process.exit(r.status ?? 1)
