// test/helpers/no-real-os.mjs — the test side of the `npm test` preload test/helpers/no-real-os.cjs.
//
// The preload refuses a real launchctl / systemctl / security / certutil / loginctl (src/off/exec.mjs and a wrapper over
// node:child_process) and keeps a ledger of the refusals; a test process that ends with an unacknowledged one exits 1. A test that
// provokes a refusal on purpose takes its entries out of the ledger here, and asserts on them:
//
//   import { takeRefusals } from '../helpers/no-real-os.mjs'
//   assert.throws(() => execTool('launchctl', ['list']), { code: 'ESANDBOX' })
//   assert.deepEqual(takeRefusals().map((r) => r.tool), ['launchctl'])
//
// A test that never provokes one leaves the ledger empty and needs nothing from here.

/** Removes and returns the refusals recorded in this process so far: `[{ tool, message }]`. Throws when the preload is not loaded. */
export function takeRefusals() {
  const ledger = globalThis[Symbol.for('asight.no-real-os')]
  if (!ledger) throw new Error('no-real-os: the preload is not loaded; run with --require ./test/helpers/no-real-os.cjs (npm test does)')
  return ledger.takeRefusals()
}
