// src/control/board.mjs — the board's control verbs, run in the query worker (RFC 4.4 §控制面; D26② · D66②). Each verb calls the CLI's own function
// — never its argv shell, never a second validation — and answers `{status, doc}`; the worker writes `doc` as the one JSON line the command prints
// with --json. The face (src/server.mjs) parsed only the small request body and never reads what comes back (D63).
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { hideUserinfoIn as hidden } from '../off/io.mjs'

// `on` starts the daemon (its autostart unit, D61's direct start) with the CLI's own script; in this worker process.argv[1] is the worker
const SCRIPT = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))

/**
 * planThenConfirm({ dryRun, run, confirm }) → {status, doc} — 4.4 「先计划后确认」, shared by every verb that changes something. `dryRun()` is the
 * command's own dry-run receipt; its `planned` bytes ARE the plan, and `plan_id` is their sha256. No `confirm`, or one that is not the plan of now
 * (the machine changed between the two requests) → 409 with the plan of now and nothing written; the same → `run()`'s receipt. A dry run that
 * already failed (ok:false) is the answer: there is nothing to confirm. Both answers are what the command prints with --json, so a URL's password
 * is `***@` in them (1.6 §1.2「不印凭据」); the plan_id is over the plan as shown.
 */
export async function planThenConfirm({ dryRun, run, confirm }) {
  const receipt = hidden(await dryRun())
  if (receipt.ok === false) return { status: 200, doc: receipt }
  const plan_id = crypto.createHash('sha256').update(JSON.stringify(receipt.planned)).digest('hex')
  if (confirm !== plan_id) return { status: 409, doc: { need: 'confirm', plan: receipt.planned, receipt, plan_id } }
  return { status: 200, doc: hidden(await run()) }
}

// Every verb runs with the daemon's environment (deps.env || process.env): the login job's, not a shell's. A variable exported only in some shell
// (CODEX_HOME, SSL_CERT_FILE …) reaches the CLI run from that shell and never the board; V91 is equality under one environment (4.4 §控制面).
export const VERBS = Object.freeze({
  /** GET /control/status: per harness what `status --json` says of its switch and its setup — that very document, so the two cannot differ (V91). */
  async status(_body, { home, deps }) {
    const { statusDoc } = await import('../cli/status.mjs')
    const doc = await statusDoc({ home: path.dirname(home), env: deps.env || process.env, platform: deps.platform || process.platform, deps })
    return { status: 200, doc: { control: true, user: doc.user, root: false, harnesses: Object.entries(doc.harnesses).map(([harness, h]) => ({ harness, desired: h.desired, setup: h.setup })) } }
  },
  /** POST /control/classes: `trocar classes`'s own change (classesChange), planned then confirmed; `source:'board'` marks it in the change log.
   *  A ClassArgError is the caller's mistake: 400 and nothing written. */
  async classes({ confirm, source: _source, ...op }, { home }) {
    const [{ classesChange }, { ClassArgError }] = await Promise.all([import('../cli/classes.mjs'), import('../classes/table.mjs')])
    const change = (dryRun) => classesChange(op, { home, source: 'board', dryRun }).receipt
    try { return await planThenConfirm({ dryRun: () => change(true), run: () => change(false), confirm }) } catch (e) {
      if (e instanceof ClassArgError) return { status: 400, doc: { error: e.message } }
      throw e
    }
  },
  /** POST /control/harness: `trocar on` (runOn, with --json and --dry-run / --yes) or `trocar off` (runOff) for one harness, planned then confirmed;
   *  the receipt is the one `--json` prints, a refusal included. `source:'board'` marks every flows/ record the run writes. The plan is the dry-run
   *  receipt's `planned` — for an off with an install record that is [] (1.6 附录 C.2), so its plan_id binds nothing but the harness. */
  async harness({ harness, on, confirm }, { home, deps }) {
    const [{ resolveHarnesses }, { newReceipt }] = await Promise.all([import('../off/harness-names.mjs'), import('../cli/schema.mjs')])
    const named = typeof harness === 'string' ? resolveHarnesses([harness]) : { ok: false }
    if (!named.ok) return { status: 400, doc: { error: `harness must be one of the harness names, not ${JSON.stringify(harness)}` } }
    if (typeof on !== 'boolean') return { status: 400, doc: { error: 'on must be true or false' } }
    const ids = named.ids, user = path.dirname(home), env = deps.env || process.env, platform = deps.platform || process.platform, d = { script: SCRIPT, ...deps }
    const out = [], err = []
    const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } }
    const runOnce = async (dryRun) => {
      out.length = err.length = 0
      try {
        if (!on) return (await (await import('../off/orchestrate.mjs')).runOff({ home: user, env, ids, dryRun, yes: true, interactive: false, io, say: () => {}, deps: { platform, ...d }, source: 'board' })).receipt
        await (await import('../cli/on.mjs')).runOn({ io, env, home: user, platform, deps: d, ids, flags: new Set(['--json', dryRun ? '--dry-run' : '--yes']), json: true, source: 'board' })
        if (out.length) return JSON.parse(out.at(-1))
        return { ...newReceipt('on'), ok: false, notes: [...err] } // a refusal said on stderr only (root, 1.6 §1.5): the receipt the CLI's --json would have had
      } catch (e) { return { ...newReceipt(on ? 'on' : 'off'), ok: false, notes: [String((e && e.message) || e)] } } // what the CLI prints when the command throws
    }
    return planThenConfirm({ dryRun: () => runOnce(true), run: () => runOnce(false), confirm })
  },
  /** POST /control/setup: `trocar install`'s own function for one harness (only), planned then confirmed (D65④). Its plan is that harness's missing
   *  carriers ([] when it has them all); the root and the login entry are install's steps, read back when in place, asked as install asks when not —
   *  a dialog nobody answered is a `pending` row carrying `trocar install`, the harness's carriers placed all the same (4.4 「Set up 的三件实话」). */
  async setup({ harness, confirm }, { home, deps }) {
    const [{ resolveHarnesses }, { newReceipt }, { install }] = await Promise.all([import('../off/harness-names.mjs'), import('../cli/schema.mjs'), import('../cli/install.mjs')])
    const named = typeof harness === 'string' ? resolveHarnesses([harness]) : { ok: false }
    if (!named.ok || named.ids.length !== 1) return { status: 400, doc: { error: `harness must be one of the harness names, not ${JSON.stringify(harness)}` } }
    const out = [], err = []
    const io = { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } }
    const runOnce = async (dryRun) => {
      out.length = err.length = 0
      try {
        await install({ io, env: deps.env || process.env, home: path.dirname(home), platform: deps.platform || process.platform, deps: { script: SCRIPT, ...deps }, flags: new Set(['--json', dryRun ? '--dry-run' : '--yes']), only: named.ids[0] })
        return out.length ? JSON.parse(out.at(-1)) : { ...newReceipt('install'), ok: false, notes: [...err] } // a refusal said on stderr only (root, op.lock)
      } catch (e) { return { ...newReceipt('install'), ok: false, notes: [String((e && e.message) || e)] } }
    }
    return planThenConfirm({ dryRun: () => runOnce(true), run: () => runOnce(false), confirm })
  },
})
