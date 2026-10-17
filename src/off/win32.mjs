// win32.mjs (src/off) — what `asight off` and `asight uninstall` do on Windows that no other OS needs (RFC 4.8 §4.2, §7; 1.6 R3, R7). It imports Node's own modules and files of src/off and nothing else: the standalone `asight-off`
// is made of the files of this directory alone, so it cannot reach the helper, the collector or the source tree (0.1 §2). Today this file holds the elevation check; the Windows undo (`undoWin32`, plan Task 9(b)) joins it.
//
// R7 on Windows (4.8 §7): asight never runs with an elevated token or as SYSTEM, so `on`, `daemon`, `off` and `uninstall` refuse to. All four ask `whoami /groups` through execTool (`on` and `daemon`
// by arch/win32/autostart.mjs `refuseElevated`, which calls elevationByWhoami): a helper started for the question cost on 1.2 s (2026-10-17), and off has to work when asight is broken. The SIDs are the same in every language of Windows, so the check reads
// SIDs, never group names: the integrity label is `S-1-16-<rid>` (High is 12288, System 16384) and SYSTEM is `S-1-5-18`.
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import { execTool } from './exec.mjs'

const HIGH_RID = 12288

/** → `{ elevated: false }` · `{ elevated: true, why: 'high-integrity' | 'system' }` · `{ elevated: null, reason }` (R11: not readable is not "no", and `reason` says why). `run` is the injected runner (execTool's). */
export function elevationByWhoami({ run = null, env = process.env } = {}) {
  const r = execTool('whoami', ['/groups', '/fo', 'csv', '/nh'], { run, env })
  if (r.code !== 0) return { elevated: null, reason: `whoami /groups ${r.code === null ? `did not run (${r.err || 'no reason given'})` : `failed (exit ${r.code})`}` }
  const rids = [...r.out.matchAll(/\bS-1-16-(\d+)\b/g)].map((m) => Number(m[1]))
  if (/\bS-1-5-18\b/.test(r.out)) return { elevated: true, why: 'system' }
  if (!rids.length) return { elevated: null, reason: 'whoami /groups gave no mandatory label (S-1-16-…)' }
  if (Math.max(...rids) < HIGH_RID) return { elevated: false }
  return unsplitByReg({ run, env }) ? { elevated: false, why: 'unsplit' } : { elevated: true, why: 'high-integrity' }
}

// R7's unsplit-token exception (1.6 R7, D53③): with no split token every shell of the account is High, so `on` and `off` share one token. whoami cannot see a
// linked token, so the two settings that make one are read: UAC off (EnableLUA = 0), or the built-in Administrator (user RID 500) without Admin Approval
// Mode (FilterAdministratorToken absent or 0). A setting that cannot be read is not known to be off: the token stays refused.
const UAC_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'
const regDword = (name, { run, env }) => {
  const r = execTool('reg', ['query', UAC_KEY, '/v', name], { run, env })
  const m = r.code === 0 && new RegExp(`\\b${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(r.out)
  return m ? parseInt(m[1], 16) : r.code === 1 ? 'absent' : null
}
function unsplitByReg({ run, env }) {
  if (regDword('EnableLUA', { run, env }) === 0) return true
  const u = execTool('whoami', ['/user', '/fo', 'csv', '/nh'], { run, env })
  if (u.code !== 0 || !/"S-1-5-21-[\d-]+-500"/.test(u.out)) return false
  const f = regDword('FilterAdministratorToken', { run, env })
  return f === 0 || f === 'absent'
}

/** → null (go on) or `{ code: 'elevated-token', reason }`. A token that cannot be read is not a refusal: an undo that stops on a broken `whoami` is not an undo. */
export function refuseElevatedByWhoami(opts = {}) {
  const e = elevationByWhoami(opts)
  return e.elevated === true ? elevatedRefusal(e.why === 'system') : null
}
/** The refusal of an elevated (`system` false) or SYSTEM token, the same words for every command (R7). */
export const elevatedRefusal = (system) => ({ code: 'elevated-token', reason: `用你自己的账号跑,不要「以管理员身份运行」,也不要用 SYSTEM(R7:asight 不以提升的令牌运行;这个令牌是${system ? ' SYSTEM' : '高完整性级别'})` })

// ── the collector's undo pieces (plan Task 9(b); RFC 4.8 §4.2, §7) ───────────────────────────────────────────────────────────
// src/off cannot import arch/, so the task and Run-value undo are inlined here with the SAME fixed questions, the SAME verbs and the
// SAME "never on a guess" rules as arch/win32/autostart.mjs's own (test/off/win32.test.mjs holds the two equal, the way Linux's
// unit.mjs and src/off/autostart.mjs are held). The names and paths are written here too; the equality test holds them.

/** The scheduled task's name and the Run value's place — the same literals as arch/win32/autostart.mjs's TASK_NAME and RUN_KEY (the test holds them equal). */
export const TASK_NAME = '\\asight\\collector'
export const RUN_KEY = Object.freeze({ hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'asight-collector' })
const RUN_PATH = `${RUN_KEY.hive}\\${RUN_KEY.key}`
const ours = (value) => /\bdaemon --supervise\s*$/.test(value) // what an earlier `on` of asight wrote: the supervised daemon command

/** The Run value, read (arch's readRunValue, inlined): `{ present: true, kind, value, lossy? }` · `{ present: false }` · `{ error }`. */
export function readRunValue({ run = null, env = process.env } = {}) {
  const r = execTool('reg', ['query', RUN_PATH, '/v', RUN_KEY.name], { run, env })
  if (r.code === null) return { error: `reg query did not run (${r.err || 'no reason given'})` }
  if (r.code !== 0) return { present: false }
  const m = new RegExp(`^[ \\t]+${RUN_KEY.name}[ \\t]+(REG_[A-Z_]+)(?:[ \\t]+(.*))?$`, 'mi').exec(r.out)
  if (!m) return { error: `reg query answered, but not with the value ${RUN_KEY.name}` }
  const value = m[2] ?? ''
  return { present: true, kind: m[1].toUpperCase(), value, ...(value.includes('�') ? { lossy: true } : {}) }
}

/** Takes asight's Run value out, and only that value (arch's removeRunValue, inlined): ours with no prior deleted, ours over a prior
 *  restored with its kind, a value that is not ours left, an absent one already as asked. → `{ ok, result: 'removed'|'restored'|'left'|'absent'|'failed', reason? }`. */
export function undoRunKey({ prior = null, run = null, env = process.env } = {}) {
  const cur = readRunValue({ run, env })
  if (cur.error) return { ok: false, result: 'failed', reason: cur.error }
  if (!cur.present) return { ok: true, result: 'absent' }
  if (!ours(cur.value)) return { ok: true, result: 'left' }
  const r = prior ? execTool('reg', ['add', RUN_PATH, '/v', RUN_KEY.name, '/t', prior.kind, '/d', prior.value, '/f'], { run, env }) : execTool('reg', ['delete', RUN_PATH, '/v', RUN_KEY.name, '/f'], { run, env })
  return r.code === 0 ? { ok: true, result: prior ? 'restored' : 'removed' } : { ok: false, result: 'failed', reason: `reg ${prior ? 'add' : 'delete'} failed (exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
}

/** The task off the login path — the TASK alone, before the ledger's entries go (an `off`'s step 5 and `uninstall`'s own step call this; the Run value is a
 *  manifest entry and goes with the rest): `/Change /DISABLE` for an `off` (it does not end a running instance — the supervisor is stopped first, 4.8 §4.2),
 *  `/Delete /F` for an `uninstall`. A task that is not there is already as asked; a query that cannot tell changes nothing on a guess. → `{ ok, task:
 *  'disabled'|'deleted'|'absent'|'failed', reason? }`. */
export function disableScheduledTask({ uninstall = false, run = null, env = process.env } = {}) {
  const q = taskState({ run, env })
  if (q.state === 'present') {
    const r = execTool('schtasks', [uninstall ? '/Delete' : '/Change', '/TN', TASK_NAME, ...(uninstall ? ['/F'] : ['/DISABLE'])], { run, env })
    return r.code === 0 ? { ok: true, task: uninstall ? 'deleted' : 'disabled' } : { ok: false, task: 'failed', reason: `schtasks ${uninstall ? '/Delete' : '/Change /DISABLE'} failed (${r.code === null ? `did not run (${r.err || 'no reason given'})` : `exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''}`})` }
  }
  if (q.state === 'absent') return { ok: true, task: 'absent' }
  return { ok: false, task: 'failed', reason: `${q.err}; nothing was changed on a guess` }
}

/** Is the scheduled task there? `/Query`'s exit code answers (0 there, 1 not) — never a localised error text; a query that did not run at
 *  all is NOT "not there" (arch's taskState, inlined): → 'present' | 'absent' | { state: 'unknown', err }. */
export function taskState({ run = null, env = process.env } = {}) {
  const r = execTool('schtasks', ['/Query', '/TN', TASK_NAME], { run, env })
  if (r.code === 0) return { state: 'present' }
  if (r.code === null) return { state: 'unknown', err: `schtasks /Query did not run (${r.err || 'no reason given'})` }
  if (r.code === 1) return { state: 'absent' }
  return { state: 'unknown', err: `schtasks /Query exited ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''}: whether the task ${TASK_NAME} is registered is not known` }
}

/** The task off the login path AND asight's Run value taken out, the two as one undo whatever an earlier `on` used (§7: exactly one login mechanism is
 *  left live; arch's undoScheduledTask, the Run value half inlined with it): `/Change /DISABLE` for an `off`, `/Delete /F` for an `uninstall`. →
 *  `{ ok, task: 'disabled'|'deleted'|'absent'|'failed', runKey: 'removed'|'restored'|'left'|'absent'|'failed', reason?, runKeyReason? }`. */
export function undoScheduledTask({ uninstall = false, prior = null, run = null, env = process.env } = {}) {
  const t = disableScheduledTask({ uninstall, run, env })
  const k = undoRunKey({ prior, run, env })
  return { ok: t.ok && k.ok, ...t, runKey: k.result, ...(k.ok ? {} : { runKeyReason: k.reason }) }
}

