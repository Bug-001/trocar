// src/control/board.mjs — the board's control verbs, run in the query worker (RFC 4.4 §控制面; D26② · D66②). Each verb calls the CLI's own function
// — never its argv shell, never a second validation — and answers `{status, doc}`; the worker writes `doc` as the one JSON line the command prints
// with --json. The face (src/server.mjs) parsed only the small request body and never reads what comes back (D63).
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * planThenConfirm({ dryRun, run, confirm }) → {status, doc} — 4.4 「先计划后确认」, shared by every verb that changes something. `dryRun()` is the
 * command's own dry-run receipt; its `planned` bytes ARE the plan, and `plan_id` is their sha256. No `confirm`, or one that is not the plan of now
 * (the machine changed between the two requests) → 409 with the plan of now and nothing written; the same → `run()`'s receipt. A dry run that
 * already failed (ok:false) is the answer: there is nothing to confirm.
 */
export async function planThenConfirm({ dryRun, run, confirm }) {
  const receipt = await dryRun()
  if (receipt.ok === false) return { status: 200, doc: receipt }
  const plan_id = crypto.createHash('sha256').update(JSON.stringify(receipt.planned)).digest('hex')
  if (confirm !== plan_id) return { status: 409, doc: { need: 'confirm', plan: receipt.planned, receipt, plan_id } }
  return { status: 200, doc: await run() }
}

export const VERBS = Object.freeze({
  /** GET /control/status: per harness what `status --json` says of its switch and its setup — that very document, so the two cannot differ (V91). */
  async status(_body, { home, deps }) {
    const { statusDoc } = await import('../cli/status.mjs')
    const doc = await statusDoc({ home: path.dirname(home), env: deps.env || process.env, platform: deps.platform || process.platform, deps })
    return { status: 200, doc: { control: true, user: doc.user, root: false, harnesses: Object.entries(doc.harnesses).map(([harness, h]) => ({ harness, desired: h.desired, setup: h.setup })) } }
  },
})
