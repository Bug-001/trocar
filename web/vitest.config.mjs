// web/vitest.config.mjs — component tests (`npm run test:web`, D75④): jsdom, only web/**/*.test.tsx. The run carries the guards
// `npm test` preloads (0.1 §3): this, the main process, owns the run's private TMPDIR and fails the run on leftovers and blamed
// children (leak-guard's runner side); each worker loads web/vitest.setup.mjs (no-real-os, and leak-guard's test-file side).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

createRequire(import.meta.url)('../test/helpers/leak-guard.cjs').guardRun()

export default {
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    environment: 'jsdom',
    include: ['web/**/*.test.tsx'],
    pool: 'forks',
    setupFiles: [fileURLToPath(new URL('./vitest.setup.mjs', import.meta.url))],
  },
}
