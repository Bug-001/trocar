// The configs the real-mihomo contract test (W57) loads, built from the generators of src/netenv/mihomo/rules.mjs (Task 5; they replaced the inline template in
// inline-block.mjs, the Windows spike's stand-in). What the generator wrote is used as it is; only what a Mac loopback run cannot do is the test's:
//   shape 1 (Verge-like): the user's side is the test's: the mixed port, an `http` listener for the agent stand-in (told apart by IN-NAME, since the stand-in and the engine are
//     this one process and a process rule cannot tell them apart), the user's rules after the block (a blocked port, MATCH,DIRECT), debug logs (the test counts destinations).
//   shape 2 (own forwarder): buildForwarderConfig()'s text with an overlay: the listener demands users (the stand-in and the re-entry connection are told apart by user, for the
//     same reason), asight-re carries the re-entry user, find-process-mode off, unified-delay as the test wants, debug logs. The overlay changes nothing else.
// Two options exist so that the loopback `AND ... DIRECT` rule (4.8 §3.3, the core of the fallback design) can go red: a user whose tail lets a probe to the re-entry point through
// by accident (MATCH,DIRECT, a next hop of 'direct') hides a missing rule, and a real user's tail (a VPN, a proxy that refuses loopback) does not. `strictTail` (shape 1) ends the
// user's rules in REJECT but for the origin; `upstream` (shape 2) names a next hop other than direct, which the test then makes refuse every target but the origin.
// The unmodified text is loaded too (the "verbatim" tests of the contract): that is the product's config.
import { buildBlock, buildForwarderConfig, routeFile } from '../../../src/netenv/mihomo/rules.mjs'

export const G = 'spike' // the id the recorded probe bytes (mihomo-probe.bytes) were taken with
export const TOKEN = '0123456789abcdef0123456789abcdef' // a fixture value, never a real token
export const PATTERN = String.raw`\\asight-test-client\.exe` // a stand-in image: the macOS run identifies the stand-in another way, the file is rewritten by the test

export const groupOf = (g = G) => ({ g, route: 'vb', pathPatterns: [PATTERN], names: [] })

const base = ({ controller, secret, unifiedDelay }) => ({
  'allow-lan': false, 'bind-address': '127.0.0.1', mode: 'rule', 'log-level': 'debug', ipv6: false,
  'unified-delay': unifiedDelay, 'find-process-mode': 'off',
  'external-controller': `127.0.0.1:${controller}`, secret,
  // no tun, no dns section, no geodata download (the geox URLs point at the discard port): a loopback-only run
  'geo-auto-update': false, 'geox-url': { geoip: 'http://127.0.0.1:9/g', geosite: 'http://127.0.0.1:9/g', mmdb: 'http://127.0.0.1:9/g', asn: 'http://127.0.0.1:9/g' },
})

/** Shape 1: the Verge-like config around buildBlock()'s output. `route` is the provider's own path: the test writes the stand-in's on-lines there. */
export function vergeLikeConfig({ ports, secret, token = TOKEN, unifiedDelay = true, g = G, strictTail = false }) {
  const b = buildBlock({ groups: [groupOf(g)], enginePort: ports.engine, token, reenter: { host: '127.0.0.1', port: ports.mixed } })
  return {
    config: {
      ...base({ controller: ports.controller, secret, unifiedDelay }),
      'mixed-port': ports.mixed,
      listeners: [{ name: 'agent-in', type: 'http', port: ports.agent, listen: '127.0.0.1' }],
      proxies: b.proxies, 'proxy-groups': b.groups, 'rule-providers': b.providers,
      rules: [...b.rules, `DST-PORT,${ports.blocked},REJECT`, ...(strictTail ? [`DST-PORT,${ports.origin},DIRECT`, 'MATCH,REJECT'] : ['MATCH,DIRECT'])],
    },
    routeFile, route: b.providers[`asight-r-${g}`].path, onLines: ['IN-NAME,agent-in'],
  }
}

/** Shape 2: the forwarder's text, parsed, overlaid for the Mac (see the header), and written back as JSON. */
export function forwarderLikeConfig({ ports, secret, token = TOKEN, unifiedDelay = true, g = G, upstream = 'direct' }) {
  const text = buildForwarderConfig({ forms: [{ g, port: ports.form, upstream }], enginePort: ports.engine, token, controller: { port: ports.controller, secret }, on: true })
  const config = JSON.parse(text)
  config.listeners[0].users = [{ username: 'agent', password: 'ap' }, { username: 're', password: 'rp' }]
  Object.assign(config.proxies.find((p) => p.name === `asight-re-${g}`), { username: 're', password: 'rp' })
  Object.assign(config, { 'find-process-mode': 'off', 'unified-delay': unifiedDelay, 'log-level': 'debug' })
  return { config, routeFile, route: config['rule-providers'][`asight-r-${g}`].path, onLines: ['IN-USER,agent'] }
}
