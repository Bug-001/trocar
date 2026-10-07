// probe.mjs — what is running on this machine as proxy / VPN software, and what it is doing, from facts (RFC 4.7 §2 · §6; acceptance N1 N2). A pure function: the facts come from the platform (on Windows
// src/collector/arch/win32/netfacts.mjs, Task 10, with the Verge adapter's facts()), so this file reads no file, opens no socket and imports no platform. Read only: nothing here has a write.
// What is not read is not "none": every fact that could not be read becomes an `unknown` entry with a reason (the closed set of 1.6 §9.4: denied · timeout · absent · unparseable · owner-unreadable · pac ·
// controller-unreadable …, and `not-adapted` for a product whose settings nobody reads yet); `products: null` is "not known", `[]` is "nothing of the table runs". Nothing that is secret goes in: the
// result is what `~/.asight/netenv.json` holds, so it has no secret, no subscription address, no node and no group name of the user's, no pipe name.
//
// facts = {
//   procs:        { ok: true, rows: [{ pid, name, exe }] } | { ok: false, reason }                 the helper's `ps`
//   listeners:    { ok: true, rows: [{ pid, port, addr }] } | { ok: false, reason }                the helper's `tcp-table`, LISTEN rows
//   systemProxy:  { ok: true, enable, server, autoConfigUrl, override? } | { ok: false, reason }   the helper's `reg-read` of Internet Settings (ProxyEnable · ProxyServer · AutoConfigURL), as readSystemProxy() of src/collector/arch/win32/upstream.mjs gives it.
//                 `override` (ProxyOverride: the user's own host list) is the upstream rule's, for the bypass table (4.8 §2.2): detect() never copies it, so it never reaches netenv.json
//   interfaces:   { ok: true, rows: [{ name, description, up }], defaultIface } | { ok: false, reason }    `net-if` and `route` (the interface the default route takes)
//   focusPorts:   [port]                                                                         ports whose owner matters (an agent's proxy setting names them); the system proxy's port always does
//   verge:        the Verge adapter's facts() | null                                               { fields, running, runtime, controller }
//   productFacts: { <product id>: { mode, mixedPort, tun } }                                         optional: what a reader of another product found
// }
import { PRODUCTS_WIN32, productsOfImage } from './products-win32.mjs'

// what the probe may put in `unknown.reason`: 1.6 §9.4's closed set (the part a probe can say) plus `not-adapted` (4.7 §6: recognised or listening, but no reader for it yet)
export const PROBE_UNKNOWN_REASONS = Object.freeze(['denied', 'timeout', 'absent', 'unparseable', 'owner-unreadable', 'pac', 'controller-unreadable', 'not-adapted'])
const CLOSED = new Set(PROBE_UNKNOWN_REASONS)
// a reason a fact reports that is not in the set is `unparseable` with what it said in `detail`, never a string of the platform's own in a field the CLI validates
const reasonOf = (f) => (f && typeof f.reason === 'string' ? f.reason : 'absent')
const why = (what, f, extra = {}) => { const r = reasonOf(f); return CLOSED.has(r) ? { what, ...extra, reason: r } : { what, ...extra, reason: 'unparseable', detail: r } }
// an fs error code from the adapter's read of a data file → the closed set
const fileReason = (code) => (code === 'ENOENT' ? 'absent' : code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' ? 'denied' : 'unparseable')
const bool = (v) => (typeof v === 'boolean' ? v : null)

// "127.0.0.1:7897", or "http=127.0.0.1:7897;https=127.0.0.1:7897;socks=127.0.0.1:7898": the address of the http(s) entry, else the first one
function proxyAddress(server) {
  if (typeof server !== 'string' || server.trim() === '') return null
  const parts = server.split(';').map((x) => x.trim()).filter(Boolean)
  const pick = parts.find((x) => /^https?=/i.test(x)) ?? parts[0]
  const m = /^(?:[a-z]+=)?(?:[a-z]+:\/\/)?(\[[^\]]+\]|[^:\s/]+):(\d{1,5})\/?$/i.exec(pick)
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 65535 ? { host: m[1], port: Number(m[2]) } : null
}

export function detect(facts = {}, { products = PRODUCTS_WIN32 } = {}) {
  const unknown = []
  const byId = new Map(products.map((p) => [p.id, p]))
  // ---- which products run
  let running = null // Map id -> { images }
  let ambiguous = []
  if (facts.procs && facts.procs.ok && Array.isArray(facts.procs.rows)) {
    running = new Map()
    const sharedOnly = new Map()
    for (const row of facts.procs.rows) {
      const { own, shared } = productsOfImage(row.name, products)
      for (const id of own) running.set(id, [...(running.get(id) || []), row.name])
      if (!own.length) for (const id of shared) sharedOnly.set(String(row.name).toLowerCase(), [...new Set([...(sharedOnly.get(String(row.name).toLowerCase()) || []), id])])
    }
    // a shared image (sing-box.exe) is a product's only when one of its candidates runs by an image of its own; else the entry says which it could be
    for (const [image, ids] of sharedOnly) { const owned = ids.filter((id) => running.has(id)); if (owned.length === 1) running.get(owned[0]).push(image); else ambiguous.push({ image, ids }) }
  } else unknown.push(why('products', facts.procs))
  // ---- the system proxy
  let systemProxy = { enabled: null, host: null, port: null, pac: null }
  const sp = facts.systemProxy
  if (sp && sp.ok) {
    const addr = proxyAddress(sp.server)
    const pac = typeof sp.autoConfigUrl === 'string' && sp.autoConfigUrl !== ''
    systemProxy = { enabled: bool(sp.enable), host: addr ? addr.host : null, port: addr ? addr.port : null, pac }
    if (pac) unknown.push({ what: 'system-proxy', reason: 'pac' }) // asight does not run a PAC script: where it sends a connection is not known
    else if (systemProxy.enabled === true && !addr) unknown.push({ what: 'system-proxy', reason: 'unparseable' })
  } else unknown.push(why('system-proxy', sp))
  // ---- the products
  const ifaces = facts.interfaces && facts.interfaces.ok ? facts.interfaces : null
  const tunOf = (p) => {
    if (!ifaces) return null
    const mine = ifaces.rows.filter((i) => p.tunAdapters.some((n) => [i.name, i.description].some((x) => String(x ?? '').toLowerCase() === n.toLowerCase())))
    return mine.length > 0 && mine.some((i) => i.up === true && i.name === ifaces.defaultIface)
  }
  const out = running === null ? null : []
  for (const [id] of running || []) {
    const p = byId.get(id)
    const v = id === 'clash-verge-rev' ? facts.verge : null
    const rt = v && v.runtime && !v.runtime.unknown ? v.runtime : {}
    const fl = v && v.fields ? v.fields : {}
    const other = (facts.productFacts && facts.productFacts[id]) || {}
    const entry = {
      id, name: p.name, adapted: p.adapted, running: true,
      version: rt.version ?? null,
      mode: rt.mode ?? fl.mode ?? other.mode ?? null,
      tun: rt.tun ?? fl.tun ?? other.tun ?? tunOf(p),
      systemProxy: bool(fl.systemProxy), // the product's own setting (Verge's `enable_system_proxy`); a product nobody reads has none here, and the system's own is `systemProxy` of the result
      mixedPort: rt.mixedPort ?? fl.mixedPort ?? other.mixedPort ?? null,
      controller: p.adapted ? (v && v.runtime && !v.runtime.unknown ? 'readable' : 'unreadable') : 'not-applicable',
      serviceMode: p.adapted ? bool(fl.serviceMode) : null,
    }
    if (entry.tun === null) unknown.push(why('tun', facts.interfaces, { product: id })) // neither the product's word nor the adapter list says
    if (p.adapted && v && v.runtime && v.runtime.unknown) unknown.push(why('controller', { reason: v.runtime.unknown.reason ?? 'controller-unreadable' }, { product: id }))
    if (p.adapted && v && v.fields) for (const u of v.fields.unreadable || []) unknown.push({ what: 'product-file', product: id, reason: fileReason(u.reason), detail: u.file })
    if (!p.adapted && !facts.productFacts?.[id]) unknown.push({ what: 'product-settings', product: id, reason: 'not-adapted' }) // recognised, and nobody reads its settings yet
    out.push(entry)
  }
  for (const a of ambiguous) unknown.push({ what: 'product', reason: 'not-adapted', detail: a.image, candidates: a.ids })
  // ---- who listens where it matters
  const focus = [...new Set([...(Array.isArray(facts.focusPorts) ? facts.focusPorts : []), ...(systemProxy.enabled === true && systemProxy.port ? [systemProxy.port] : [])])]
  const listeners = []
  if (facts.listeners && facts.listeners.ok && facts.procs && facts.procs.ok) {
    for (const port of focus) {
      const rows = facts.listeners.rows.filter((r) => r.port === port)
      if (rows.length === 0) { listeners.push({ port, product: null, image: null }); unknown.push({ what: 'listener', port, reason: 'absent' }); continue }
      for (const r of rows) {
        const proc = facts.procs.rows.find((x) => x.pid === r.pid)
        const image = proc ? proc.name : null
        const owner = image ? productsOfImage(image, products) : { own: [], shared: [] }
        const sharedRunning = owner.shared.filter((x) => running && running.has(x)) // a shared image is the product's whose own image runs beside it
        const id = owner.own.length === 1 ? owner.own[0] : sharedRunning.length === 1 ? sharedRunning[0] : null
        listeners.push({ port, product: id, image })
        if (!id) unknown.push(image ? { what: 'listener', port, reason: 'not-adapted', detail: image } : { what: 'listener', port, reason: 'owner-unreadable' }) // 「不知道 · 未适配」 and its image name, never 「无」
      }
    }
  } else if (focus.length) unknown.push(why('listeners', facts.listeners && facts.listeners.ok ? facts.procs : facts.listeners))
  return { products: out, systemProxy, listeners, unknown }
}
