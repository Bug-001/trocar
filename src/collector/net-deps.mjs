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

/** The forms of this OS present on this machine, per harness (1.6 §3.5, 4.11 P5): proxy mode's arch reader, else driver mode's (4.6), loaded only when asked. */
export async function presentForms(o) {
  if ((await import('./model-install.mjs')).isModelOs(o.os)) return (await import('./arch/model-backends.mjs')).presentForms(o)
  return (await import('./driver-setup.mjs')).driverPresent(o)
}
export async function formPrograms(o) { return (await import('./arch/model-backends.mjs')).formPrograms(o) }
