// The config the real-mihomo contract test (W57 W70 W72) loads, built from the generator of src/netenv/mihomo/rules.mjs (it replaced the inline template in inline-block.mjs).
// What the generator wrote is used as it is; only what a Mac loopback run cannot do is the test's: the stand-in agent and the engine are one process, and a process rule cannot tell them apart, so the form's process rule is
// replaced by the stand-in's own listener user (the engine's re-entry connection is `re.<g>`, which the generator already tells apart), find-process-mode is off, unified-delay is as the test wants, debug logs
// (the test counts destinations). The overlay changes nothing else.
// `upstream` exists so that the loopback `AND ... DIRECT` rule (4.8 §3.3, the core of the fallback design) can go red: an upstream of 'direct' lets a probe to the re-entry point through by accident and hides a
// missing rule, and a real user's tail (a VPN, a proxy that refuses loopback) does not. An upstream other than direct, which the test then makes refuse every target but the origin, is that user.
// The unmodified text is loaded too (the "verbatim" tests of the contract): that is the product's config.
import { buildForwarderConfig, processRulesOf } from '../../../src/netenv/mihomo/rules.mjs'

export const G = 'spike' // the id the recorded probe bytes (mihomo-probe.bytes) were taken with; here the group and its one form are the same id
export const TOKEN = '0123456789abcdef0123456789abcdef' // a fixture value, never a real token
export const LISTENER_TOKEN = 'fedcba9876543210fedcba9876543210' // a fixture value: the listener's password
export const PATTERN = String.raw`\\asight-test-client\.exe` // a stand-in image: the macOS run identifies the stand-in another way, the file is rewritten by the test
export const OWN_IMAGES = [process.execPath, '/opt/asight/asight-forwarder'] // the images the loop check is told are asight's own (the stand-in's rule matches neither)

/** One group `g` with one form `f` and the product's rules around it. `on` false is the forward-only config. */
export const groupOf = ({ g = G, f = g, port, upstream = 'direct', bypass = [], on = true, auth = true } = {}) => ({ g, port, on, upstream, bypass, auth, forms: [{ f, rules: processRulesOf({ pathPatterns: [PATTERN] }) }] })
export const textOf = ({ groups, ports, secret, token = TOKEN, listenerToken = LISTENER_TOKEN }) => buildForwarderConfig({ groups, enginePort: ports.engine, token, listenerToken, controller: { port: ports.controller, secret }, ownImages: OWN_IMAGES })

/** The kernel's text, parsed, overlaid for the Mac (see the header). `agent` is the stand-in's Basic login: the group's own user. */
export function overlay(text, { unifiedDelay = true } = {}) {
  const config = JSON.parse(text)
  for (const [rule, lines] of Object.entries(config['sub-rules'])) config['sub-rules'][rule] = lines.map((l) => (/^PROCESS-/.test(l) ? l.replace(/^PROCESS-[A-Z-]+,[^,]*,/, `IN-USER,${rule.slice(3)},`) : l))
  Object.assign(config, { 'find-process-mode': 'off', 'unified-delay': unifiedDelay, 'log-level': 'debug' })
  return config
}

/** The kernel-like config for `shape()`: one group, on, overlaid; `agentAuth` is the stand-in's login. */
export function forwarderLikeConfig({ ports, secret, unifiedDelay = true, g = G, upstream = 'direct', bypass = [], on = true }) {
  return { config: overlay(textOf({ groups: [groupOf({ g, port: ports.form, upstream, bypass, on })], ports, secret }), { unifiedDelay }), agentAuth: `${g}:${LISTENER_TOKEN}` }
}
