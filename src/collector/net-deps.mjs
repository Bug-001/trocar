// net-deps.mjs (src/collector) — what a command that starts no daemon needs of arch and harness, and nothing else (RFC 1.6 §9.7, 4.8 W39).
//
// `trocar status` and `trocar doctor` read the machine; they wire nothing. Reaching this through daemon.mjs made them load the daemon's whole
// graph — the engine, the TLS issuer, the record store, the seal queue, the index keeper — for two values: the harness descriptors and the
// platform's reader of the network facts. That import alone cost 89 ms of a 584 ms `status` on a Windows test machine (D62, 1.6 §3.1). `on` and `install` take their parts view
// (loadParts) from here for the same reason.
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

// What install / uninstall need from arch and harness, without starting anything: the descriptors, the OS key,
// and the process table (`scan` reads /proc; it does not need the helper).
export async function loadParts({ arch = null, harnesses = null, env = process.env, agentList = [], platform = process.platform } = {}) {
  const [{ createRegistry }, { isModelOs }] = await Promise.all([import('./core/registry.mjs'), import('./model-install.mjs')])
  const A = arch || (await loadArch(platform)) // the CLI's platform (V14: a platform with no collector is refused here, by loadArch's own error)
  const list = harnesses || (await loadHarnesses())
  // darwin / win32 run the collector model (runModelDaemon): no redirector here, and this parts view answers an empty process table
  // the registry judges by name on every OS (D51) and is built FIRST: the doors ask it (identify), the redirector does not feed it
  const registry = createRegistry(list, { agentList }) // agentList: readAgentList's entries (the user's ~/.trocar/agents.json, D51③); the daemon swaps them in place
  const redirector = isModelOs(A.os) ? null : await A.createRedirector({ env }) // awaited: a test's arch may answer async
  // linger: whether the OS keeps this user's daemon after logout (true / false; null = not readable) — `trocar on` says so (1.6 §1.1), it never enables it (R8)
  return { arch: A, os: A.os, harnesses: list, registry, scan: () => (redirector ? redirector.scan() : []), match: (f) => registry.match(f), linger: () => (redirector && typeof redirector.linger === 'function' ? redirector.linger() : null), lingerRead: () => (redirector && typeof redirector.lingerRead === 'function' ? redirector.lingerRead() : { state: null, error: 'this platform has no reader of the linger state' }) }
}

/** The forms of this OS present on this machine, per harness (1.6 §3.5, 4.11 P5): proxy mode's arch reader, else driver mode's (4.6), loaded only when asked. */
export async function presentForms(o) {
  if ((await import('./model-install.mjs')).isModelOs(o.os)) return (await import('./arch/model-backends.mjs')).presentForms(o)
  return (await import('./driver-setup.mjs')).driverPresent(o)
}
export async function formPrograms(o) { return (await import('./arch/model-backends.mjs')).formPrograms(o) }
