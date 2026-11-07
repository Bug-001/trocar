// net-deps.mjs (src/collector) — what a READ-ONLY command needs of arch and harness, and nothing else (RFC 1.6 §9.7, 4.8 W39).
//
// `trocar status` and `trocar doctor` read the machine; they wire nothing. Reaching this through daemon.mjs made them load the daemon's whole
// graph — the engine, the TLS issuer, the record store, the seal queue, the index keeper — for two values: the harness descriptors and the
// platform's reader of the network facts. That import alone cost 89 ms of a 584 ms `status` on a Windows test machine (D62, 1.6 §3.1).
//
// So this is the small arch-facing entry, and the layering rule names it beside daemon.mjs: the two files outside arch/ and harness/ that may
// import them (W39, test/collector/layering.test.mjs rule 5). It starts nothing, writes nothing and reads no machine state of its own.
import { loadArch } from './arch/index.mjs'
import { loadHarnesses } from './harness/index.mjs'

/** What `trocar status` and `doctor` need to draw the network topology (1.6 §9.7): the harness descriptors and this platform's part of the facts.
 *  A platform with no collector has no part of its own (`archFacts` null), which the facts side says as an unknown (R11). */
export async function netFactsDeps({ arch = null, harnesses = null, platform = process.platform } = {}) {
  let A = arch
  if (!A) { try { A = await loadArch(platform) } catch { A = null } }
  return { harnesses: harnesses || (await loadHarnesses()), archFacts: A && A.netFacts ? A.netFacts : null }
}

/** The forms of this OS present on this machine, per harness (proxy mode; 1.6 §3.5, 4.11 P5): the arch's reader, loaded only when asked. */
export async function presentForms(o) { return (await import('./arch/model-backends.mjs')).presentForms(o) }
export async function formPrograms(o) { return (await import('./arch/model-backends.mjs')).formPrograms(o) }

/** The login entry in the platform's own words (a Windows user told to run `systemctl` has been handed nothing; tested on Windows 2026-10-11 and macOS 2026-10-18). */
export const entryWords = (osName, unit) => (osName === 'win32' ? 'the scheduled task \\trocar\\collector' : osName === 'darwin' ? `the LaunchAgent ${(unit && unit.name) || 'com.trocar.collector'}` : 'the systemd user unit trocar-collector.service')
/** `registered()`'s answer in one phrase: `on`'s refusal, install's read-back of the entry it registered and `status` say it the same way. */
export const entryState = (osName, unit, q) => `${entryWords(osName, unit)} ${q.state === 'absent' ? 'is not registered' : q.how === 'masked' ? "is masked (a link to /dev/null, which trocar install replaces with trocar's unit)" : q.state === 'disabled' ? 'is registered but switched off' : `could not be read (${q.err || 'no reason given'})`}`

/** 附录 B / C.1: the login entry is not registered or is switched off — `on`'s refusal and `status`'s problem. */
export const AUTOSTART_MISSING = 'autostart-missing'

/** The query worker's answers, per home (1.6 §3.5 Login): the board polls status every 1.5 s, and each ask spawns an OS tool. */
const asked = new Map()
const ASK_AGAIN_MS = 60_000 // an outside change (the user's own launchctl / schtasks / systemctl) is seen within this

/** D61 / 1.6 §3.5: the login entry as `status` reports it — the arch unit's `registered()`, the question `on` asks (one question per OS, no platform
 *  branch here). `unit`: a test's (0.1 §3), else this platform's. `stamp`: given only by the query worker — the identity of the files trocar's own
 *  commands write (install record, desired state); the answer is kept until it changes or ASK_AGAIN_MS passes; the CLI passes none and asks each time.
 *  → { entry, state, code, reason } (code AUTOSTART_MISSING for absent / disabled; reason null when present), or null: no autostart unit on this platform. */
export async function loginEntry({ platform = process.platform, home, env, run = null, script = process.argv[1], unit, stamp = null, now = Date.now }) {
  const kept = stamp != null ? asked.get(home) : null
  if (kept && kept.stamp === stamp && now() - kept.at < ASK_AGAIN_MS) return kept.value
  let u = unit
  if (u === undefined) {
    let A = null
    try { A = await loadArch(platform) } catch { A = null }
    u = A && A.unit && A.unit.userUnit ? A.unit.userUnit({ home, node: process.execPath, script, run, env }) : null
  }
  let value = null
  if (u) { const q = u.registered(); value = { entry: entryWords(platform, u), state: q.state, code: q.state === 'absent' || q.state === 'disabled' ? AUTOSTART_MISSING : null, reason: q.state === 'present' ? null : entryState(platform, u, q) } }
  if (stamp != null) asked.set(home, { stamp, at: now(), value })
  return value
}
