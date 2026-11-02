// web/vitest.setup.mjs — loaded in each Vitest worker before its test file: the same guards as `npm test`'s preloads, not copies.
// no-real-os refuses a real launchctl / security / … (ESANDBOX); leak-guard kills a child left running and marks it for the runner.
// A worker does not reach its 'exit' hooks in a way Vitest sees, so both end-of-file checks run here, after the file's tests: a child
// still running is killed and marked (the main process fails the run on the mark), and a refusal nobody acknowledged (takeRefusals(),
// test/helpers/no-real-os.mjs) fails the file.
import { createRequire } from 'node:module'
import { afterAll, expect } from 'vitest'

const require = createRequire(import.meta.url)
require('../test/helpers/no-real-os.cjs')
const endChildren = require('../test/helpers/leak-guard.cjs').guardChildren()

afterAll(() => {
  endChildren(expect.getState().testPath)
  const refused = globalThis[Symbol.for('trocar.no-real-os')].takeRefusals()
  if (refused.length) throw new Error(`no-real-os: refused and never acknowledged: ${refused.map((r) => r.command || r.tool).join('; ')}`)
})
