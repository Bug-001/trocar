// facts.mjs (src/netenv) — what the topology and `doctor` are made of: NetFacts (RFC 1.6 §9.7). `gatherNetFacts` puts together what `status` already read (the switch, the daemon, the link, the entry and the
// processes of each harness), what the harness files say of how their agents read a proxy (`proxy` export, plus readProxySetting for what they are set to now), the VPN / proxy software (§6, read-only: product,
// mode, port, TUN), and what the platform adds through `archFacts` (Linux: the listeners on this machine and TUN; Windows: proxy mode's kernel and forms, 4.8 §10.1). Nothing here changes anything.
//
//   NetFacts = { at, platform, routing: 'driver' | 'proxy' | 'legacy' | 'none' | 'unknown',
//     desired: { <h>: 'on' | 'off' }, daemon: { state, pid, enginePort }, link: { attached: true | false | null, helper: 'ok' | 'missing', ids: [number] },
//     listeners: [ { addr, port, pid, exe, product } | { addr, port, unknown: { reason, detail } } ],
//     vpn: null | { product, version, pid, port, mode, tun: true | false | null, unknown? },          // read-only: no rules, no secret, no node (D43)
//     forwarder: null | { pid, up, forms: { <form>: { h, port, state: 'on' | 'forward-only', upstream, source, clients: [pid] } } },   // proxy mode's own kernel (4.8 §10.1)
//     harnesses: { <h>: { installed, entry: { state }, installedAt, setting, systemProxy: null | { value, pac } | { unknown },
//                         behaviour: { follows: { http, ws }, schemes, unsupported, branches, measured, restart, files }, procs: [ { pid, name, exe, version, startedAt, watched, trusted, reason, negative,
//                         startSetting: null | setting, elevated } ], negatives: [ { pid, host, reason } ], apiHosts, adopted: null | { at, routing, chain, source, sha256 }, forms: null | [ … ] } },
//     linger: true | false | null (Linux: does the OS keep the daemon after the last logout), otherRedirector: true | false | null (another connect-rewriter on the machine: a platform that cannot tell says null),
//     vpnKnown: whether the probe answered (a changed VPN is only judged against an answer),
//     unknowns: [ { fact, reason, detail } ] }                                                    // a read that failed: said with its reason, never left out (R11)
//
// `archFacts(ctx)` is the platform's part, `ctx = { status, harnesses, settings, netenv, env, home, deps }` → `{ routing, listeners?, procs?: { <h>: [proc] }, forwarder?, forms?: { <h>: [form] }, systemProxy?,
// tun?, unknowns? }`; one that throws (not the test guard's refusal) leaves the routing unknown and says why. A platform without one has routing 'unknown'.
import nodeFs from 'node:fs'
import { readProxySetting, proxyFilesOf } from './adopt.mjs'

const rethrowSandbox = (e) => { if (e && e.code === 'ESANDBOX') throw e } // a refusal of the test guard is never "the read failed" (0.1 §3)
const errText = (e) => String((e && (e.code || e.message)) || e)
const iso = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : typeof t === 'string' ? t : null)

/** The VPN / proxy software as the topology states it: the first product `detectNetenv` found (`status` / `doctor` read it once), reduced to what is read-only and printable. */
function vpnOf(netenv, unknowns) {
  if (!netenv) return null
  if (netenv.error) { unknowns.push({ fact: 'vpn', reason: 'denied', detail: netenv.error }); return null }
  const n = netenv.result || netenv
  const p = (n.products || [])[0]
  if (!p) return null
  return { product: p.product, version: p.version ?? null, pid: p.pid ?? null, port: p.mixed_port ?? null, mode: p.mode, tun: p.tun === true ? true : p.tun === false ? false : null,
    ...(p.live === false ? { unknown: { reason: 'controller-unreadable', detail: p.reason || 'the product\'s control socket did not answer' } } : {}) }
}

/**
 * NetFacts for the harnesses `status` knows. `status` = gatherStatus's facts, `harnesses` = the descriptors, `netenv` = what the VPN probe returned (`{ result }` / `{ error }`).
 * `adopted` is what `~/.asight/netenv.json` holds (`readNetenv`): the settings `on` found and the drift is measured against.
 */
export async function gatherNetFacts({ platform = process.platform, home, env = process.env, harnesses, status, netenv = null, archFacts = null, adopted = null, now = Date.now, fs = nodeFs, deps = {} }) {
  const unknowns = []
  const byName = new Map(harnesses.map((d) => [d.name, d]))
  const settings = {}
  for (const h of status.harnesses) {
    const d = byName.get(h.id)
    if (d) settings[h.id] = readProxySetting(d, { home, env, fs })
  }
  let part = { routing: 'unknown', unknowns: [] }
  if (archFacts) {
    try { part = { ...part, ...(await archFacts({ status, harnesses, settings, netenv, env, home, adopted, deps })) } } catch (e) {
      rethrowSandbox(e)
      part = { routing: 'unknown', unknowns: [{ fact: 'arch', reason: 'denied', detail: `the platform's network facts could not be read (${errText(e)})` }] }
    }
  } else part.unknowns.push({ fact: 'arch', reason: 'absent', detail: `no reader of the network facts for ${platform}` })
  const reply = status.daemon.reply
  const f = {
    at: new Date(now()).toISOString(), platform, routing: part.routing,
    desired: Object.fromEntries(status.harnesses.map((h) => [h.id, h.desired === 'on' ? 'on' : h.desired === 'off' ? 'off' : null])),
    daemon: { state: status.daemon.state, pid: status.daemon.pid ?? null, enginePort: (reply && reply.engine && reply.engine.port) ?? (status.daemon.lock && status.daemon.lock.engine_port) ?? null },
    link: { attached: status.link.attached, helper: status.link.helper, ids: reply && Array.isArray(reply.links) ? reply.links.map((l) => l.id).filter((x) => Number.isInteger(x)) : [] },
    listeners: part.listeners || [], vpn: null, vpnKnown: false, forwarder: part.forwarder || null, harnesses: {}, unknowns: [...(part.unknowns || [])],
    linger: status.linger && typeof status.linger.linger === 'boolean' ? status.linger.linger : null, otherRedirector: typeof part.otherRedirector === 'boolean' ? part.otherRedirector : null,
  }
  f.vpn = vpnOf(netenv, f.unknowns)
  f.vpnKnown = !!netenv && !netenv.error // a probe that did not run, or failed, says nothing about whether the VPN changed
  if (f.vpn && f.vpn.tun === null && typeof part.tun === 'boolean') f.vpn.tun = part.tun // the product did not say; the routing table did
  for (const l of f.listeners) if (!l.unknown && !l.product && f.vpn && f.vpn.port === l.port) l.product = f.vpn.product
  for (const h of status.harnesses) {
    const d = byName.get(h.id)
    if (!d) { f.unknowns.push({ fact: h.id, reason: 'absent', detail: `${h.id} has no harness descriptor in this build` }); continue }
    const pr = d.proxy, setting = settings[h.id]
    const procs = (part.procs && part.procs[h.id]) || []
    f.harnesses[h.id] = {
      installed: h.installed, entry: { state: h.entry.state }, installedAt: iso(h.installedAt), setting,
      systemProxy: part.systemProxy && (pr.systemProxy.http !== false || pr.systemProxy.ws !== false) ? part.systemProxy : null,
      behaviour: { follows: { ...pr.systemProxy }, schemes: [...pr.schemes], unsupported: { ...pr.unsupported }, branches: [...pr.branches], measured: pr.measured[platform] || 'inferred', restart: { ...pr.restart }, files: proxyFilesOf(d, { home, env }),
        fileKeys: pr.files.map((x) => ({ path: x.path({ home, env }), format: x.format, key: x.format === 'json' ? x.keys[0].join('.') : x.keys[0] })) },
      procs, negatives: reply && Array.isArray(reply.negatives) ? reply.negatives.filter((n) => procs.some((p) => p.pid === n.pid)).map((n) => ({ pid: n.pid, host: n.host, reason: 'negative-cache' })) : [],
      apiHosts: [...(d.hosts || [])], fakeIp: part.fakeIp && part.fakeIp[h.id] === true ? true : null, adopted: adopted && adopted[h.id] ? adopted[h.id] : null, forms: (part.forms && part.forms[h.id]) || null,
      ...(part.legacy && part.legacy[h.id] ? { legacy: part.legacy[h.id] } : {}),
    }
  }
  return f
}
