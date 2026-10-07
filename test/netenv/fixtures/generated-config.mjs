// The config the real-mihomo contract test (W57) loads, built from the generator of src/netenv/mihomo/rules.mjs (Task 5; it replaced the inline template in inline-block.mjs, which the Windows spike still
// ships its stand-in). What the generator wrote is used as it is; only what a Mac loopback run cannot do is the test's. One shape since D43 (the VPN-block shape, an `http` listener beside the user's own
// rules, is gone with the route): the own forwarder's. buildForwarderConfig()'s text with an overlay: the listener demands users (the stand-in and the re-entry connection are told apart by user, since the
// stand-in and the engine are this one process and a process rule cannot tell them apart), asight-re carries the re-entry user, find-process-mode off, unified-delay as the test wants, debug logs (the test
// counts destinations). The overlay changes nothing else.
// `upstream` exists so that the loopback `AND ... DIRECT` rule (4.8 §3.3, the core of the fallback design) can go red: a next hop of 'direct' lets a probe to the re-entry point through by accident and hides a
// missing rule, and a real user's tail (a VPN, a proxy that refuses loopback) does not. A next hop other than direct, which the test then makes refuse every target but the origin, is that user.
// The unmodified text is loaded too (the "verbatim" tests of the contract): that is the product's config.
import { buildForwarderConfig, routeFile } from '../../../src/netenv/mihomo/rules.mjs'

export const G = 'spike' // the id the recorded probe bytes (mihomo-probe.bytes) were taken with
export const TOKEN = '0123456789abcdef0123456789abcdef' // a fixture value, never a real token
export const PATTERN = String.raw`\\asight-test-client\.exe` // a stand-in image: the macOS run identifies the stand-in another way, the file is rewritten by the test

export const groupOf = (g = G) => ({ g, pathPatterns: [PATTERN], names: [] })

/** The forwarder's text, parsed, overlaid for the Mac (see the header), and written back as JSON. */
export function forwarderLikeConfig({ ports, secret, token = TOKEN, unifiedDelay = true, g = G, upstream = 'direct' }) {
  const text = buildForwarderConfig({ forms: [{ g, port: ports.form, upstream }], enginePort: ports.engine, token, controller: { port: ports.controller, secret }, on: true })
  const config = JSON.parse(text)
  config.listeners[0].users = [{ username: 'agent', password: 'ap' }, { username: 're', password: 'rp' }]
  Object.assign(config.proxies.find((p) => p.name === `asight-re-${g}`), { username: 're', password: 'rp' })
  Object.assign(config, { 'find-process-mode': 'off', 'unified-delay': unifiedDelay, 'log-level': 'debug' })
  return { config, routeFile, route: config['rule-providers'][`asight-r-${g}`].path, onLines: ['IN-USER,agent'] }
}
