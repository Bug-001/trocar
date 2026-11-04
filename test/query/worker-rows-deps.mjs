// test/query/worker-rows-deps.mjs — the query worker's deps (src/query/worker.mjs argv[3]) for test/query/worker-rows.test.mjs: an empty machine
// for `status`, and `beforeRows`, which holds the worker's first pass over the rows until the file named by TROCAR_TEST_ROWS_GATE appears, so a
// test forces what is answered before that pass ends instead of timing it. Exports only: node --test runs every .mjs.
import fs from 'node:fs'
import path from 'node:path'
import { boardDeps } from '../helpers/board-world.mjs'

const gate = process.env.TROCAR_TEST_ROWS_GATE, home = path.dirname(process.argv[2])

export default {
  ...await boardDeps({ platform: process.platform, home, env: { HOME: home, USERPROFILE: home }, dirs: null }),
  beforeRows: async () => { while (!fs.existsSync(gate)) await new Promise((r) => setTimeout(r, 10)) },
}
