// on-adopt.mjs (src/cli) — what `trocar on` does about the proxy an agent already uses (RFC 1.6 §9.5): it reads the setting the way the agent reads it, draws where a new connection will go once trocar is
// on, prints that chain (credentials masked) in the plan and in the receipt, and records it as `adopted.<harness>` in ~/.trocar/netenv.json, which is what a later drift is measured against.
// In driver mode (Linux eBPF) trocar writes no network setting at all: the kernel steers the connection and the engine hands the CONNECT on to the user's proxy as it was. A routing that owns a proxy
// field (proxy mode: `deps.routing`, supplied by its platform) is told the setting that was there (`routing.adopt`) — the platform hands it to the engine's door as the upstream and writes the field, as a manifest
// entry like any other — and `on` asks first when the user edited that field since the last `on` (R6, the confirmation reason 「你改过的代理设置」). Only `on` ever writes an agent's setting (D30); this file
// writes one file of trocar's own, netenv.json, through writeNetenv.
import { gatherNetFacts } from '../netenv/facts.mjs'
import { readProxySetting, readAdopted, chainsAfterOn, adoptedRecord, proxyFilesOf } from '../netenv/adopt.mjs'
import { writeNetenv, netenvFile } from '../netenv/index.mjs'
import nodeFs from 'node:fs'

const errText = (e) => String((e && (e.code || e.message)) || e)
const rethrowSandbox = (e) => { if (e && e.code === 'ESANDBOX') throw e }

/** The facts and chains `on` needs, for every harness the platform has descriptors for → `{ facts, chains, descriptors, adopted }`; `null` when this platform has no network facts to read (then `on` adopts nothing); or `{ error }`.
 *  `deps.netFactsDeps()` may also answer `deps` — the platform reader's own injections (a test's fake helper): they ride into `gatherNetFacts` untouched. The production one does not (the Windows
 *  facts start the resident helper of their own); it is the seam a sandbox reaches the real `gatherWin32Facts` through, the same seam `status`'s direct calls have. */
export async function prepareAdoption({ home, env, platform, deps, parts, now = Date.now }) {
  try {
    const fs = deps.fs || nodeFs
    const nd = deps.netFactsDeps ? await deps.netFactsDeps() : { harnesses: parts && parts.harnesses, archFacts: parts && parts.arch && parts.arch.netFacts }
    if (!nd.archFacts || !nd.harnesses) return null
    const status = { daemon: { state: 'unknown', pid: null, reply: null, lock: null }, link: { attached: null, helper: 'ok' }, matched: [],
      harnesses: nd.harnesses.map((d) => ({ id: d.name, installed: true, desired: 'on', entry: { state: 'intact' }, installedAt: null, procs: [] })) }
    const adopted = readAdopted(home, { fs })
    const facts = await gatherNetFacts({ platform, home, env, harnesses: nd.harnesses, status, archFacts: nd.archFacts, adopted, now, fs, deps: { exec: deps.exec || null, ...(deps.procRoot ? { procRoot: deps.procRoot } : {}), ...((nd && nd.deps) || {}) } })
    if (facts.routing === 'unknown') return null
    return { facts, descriptors: nd.harnesses, adopted: adopted || {}, chains: (ids) => chainsAfterOn(facts, ids) }
  } catch (e) { rethrowSandbox(e); return { error: `the network settings could not be read (${errText(e)})` } }
}

/** The harnesses whose proxy field the user edited since the last `on`: only where a routing owns the field, and only a field `on` wrote before (a first `on` finds the user's own setting, which is adopted, not overwritten). */
export function editedFields({ adoption, routing, targets, home, env, fs = nodeFs }) {
  if (!adoption || adoption.error || !routing) return []
  return targets.filter((h) => routing.ownsProxyField(h) && adoption.adopted[h] && adoption.adopted[h].written_sha256).flatMap((h) => {
    const d = adoption.descriptors.find((x) => x.name === h), a = adoption.adopted[h]
    const now = d ? readProxySetting(d, { home, env, fs, paths: a.file_paths || null, vars: false }) : null
    if (!now || now.unknown) return []
    if ([a.written_sha256, a.file_sha256].includes(now.sha256 ?? null)) return [] // what trocar wrote, or what the user had before it: not an edit
    const field = routing.fieldOf(h) || {}
    return [{ harness: h, where: field.key ? `${field.path} ${field.key}` : field.path || null, now: now.value, was: a.proxy ?? null }]
  })
}

/**
 * After a successful `on`: hands each harness's setting to the routing that owns the field (it writes the field and gives the door its upstream), then records `adopted.<h>` — once, and only what changed (a second `on`
 * writes nothing, R9). → { adopted: { <h>: record }, wrote: path | null, notes: [], failed: [harness] }.
 */
export async function recordAdoption({ adoption, routing, targets, home, env, now = Date.now, fs = nodeFs }) {
  const out = { adopted: {}, wrote: null, notes: [], failed: [] }
  const chains = adoption.chains(targets), changed = {}
  for (const h of targets) {
    const d = adoption.descriptors.find((x) => x.name === h)
    if (!d || !adoption.facts.harnesses[h]) continue
    const setting = adoption.facts.harnesses[h].setting
    const files = readProxySetting(d, { home, env, fs, vars: false }), paths = proxyFilesOf(d, { home, env }) // the files alone, found by the environment `on` runs in: what the daemon and `doctor` compare with
    let written = null
    if (routing && routing.ownsProxyField(h)) {
      try { await routing.adopt(h, setting && !setting.unknown ? setting : null) } catch (e) { rethrowSandbox(e); out.failed.push(h); out.notes.push(`${h}: ${errText(e)}`); continue }
      written = readProxySetting(d, { home, env, fs, vars: false }) // what the field holds now: trocar's own value, which a later edit is told from
    }
    const prev = adoption.adopted[h] || null
    const rec = adoptedRecord({ facts: adoption.facts, topology: chains, h, now, files: files.unknown ? null : files, paths, prev, written: written && !written.unknown ? written : null })
    out.adopted[h] = rec
    if (rec !== prev) changed[h] = rec
  }
  if (Object.keys(changed).length) {
    try { writeNetenv(home, { adopted: { ...adoption.adopted, ...changed } }, { fs }); out.wrote = netenvFile(home) } catch (e) { rethrowSandbox(e); out.notes.push(`${netenvFile(home)} could not be written (${errText(e)}): what trocar found of ${Object.keys(changed).join(', ')} is not recorded, so a later change of it cannot be told`) }
  }
  return out
}
