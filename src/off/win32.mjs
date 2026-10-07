// win32.mjs (src/off) — what `asight off` and `asight uninstall` do on Windows that no other OS needs (RFC 4.8 §4.2, §7; 1.6 R3, R7). It imports Node's own modules and files of src/off and nothing else: the standalone `asight-off`
// is made of the files of this directory alone, so it cannot reach the helper, the collector or the source tree (0.1 §2). Today this file holds the elevation check; the Windows undo (`undoWin32`, plan Task 9(b)) joins it.
//
// R7 on Windows (4.8 §7): asight never runs with an elevated token or as SYSTEM, so `on`, `daemon`, `off` and `uninstall` refuse to. `on` and `daemon` ask the helper (arch/win32/autostart.mjs `refuseElevated`); `off` and
// `uninstall` cannot start a helper (the standalone has none, and `off` has to work when asight is broken), so they ask `whoami /groups` through execTool. The SIDs are the same in every language of Windows, so the check reads
// SIDs, never group names: the integrity label is `S-1-16-<rid>` (High is 12288, System 16384) and SYSTEM is `S-1-5-18`.
import { execTool } from './exec.mjs'

const HIGH_RID = 12288

/** → `{ elevated: false }` · `{ elevated: true, why: 'high-integrity' | 'system' }` · `{ elevated: null, reason }` (R11: not readable is not "no", and `reason` says why). `run` is the injected runner (execTool's). */
export function elevationByWhoami({ run = null, env = process.env } = {}) {
  const r = execTool('whoami', ['/groups', '/fo', 'csv', '/nh'], { run, env })
  if (r.code !== 0) return { elevated: null, reason: `whoami /groups ${r.code === null ? `did not run (${r.err || 'no reason given'})` : `failed (exit ${r.code})`}` }
  const rids = [...r.out.matchAll(/\bS-1-16-(\d+)\b/g)].map((m) => Number(m[1]))
  if (/\bS-1-5-18\b/.test(r.out)) return { elevated: true, why: 'system' }
  if (!rids.length) return { elevated: null, reason: 'whoami /groups gave no mandatory label (S-1-16-…)' }
  return Math.max(...rids) >= HIGH_RID ? { elevated: true, why: 'high-integrity' } : { elevated: false }
}

/** → null (go on) or `{ code: 'elevated-token', reason }`. A token that cannot be read is not a refusal: an undo that stops on a broken `whoami` is not an undo. */
export function refuseElevatedByWhoami(opts = {}) {
  const e = elevationByWhoami(opts)
  if (e.elevated !== true) return null
  return { code: 'elevated-token', reason: `用你自己的账号跑,不要「以管理员身份运行」,也不要用 SYSTEM(R7:asight 不以提升的令牌运行;这个令牌是${e.why === 'system' ? ' SYSTEM' : '高完整性级别'})` }
}
