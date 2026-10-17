// chromium.mjs — which Chromium process an Electron host's process is (RFC 4.6 D51④; plan 2026-10-14-d51-name-allowlist §2.5). A name-list hit
// only makes a process a candidate: a desktop app's processes share one name, and only its network service owns the model sockets and reads the
// desktop's trust door. The role is told by Chromium's own switches, which arrive whole on every OS (darwin's argv is ps split on white space, and
// `--type=…` holds none). No harness name and no OS branch here (4.6 §结构): the harnesses read the role and pick their layers.

/** The network service's arguments, as an `args` pattern over `rest` (the name lists, D51) — the one place this switch is written. */
export const NETWORK_SERVICE_ARG = '(^| )--utility-sub-type=network\\.mojom\\.NetworkService( |$)'

const NETWORK_SERVICE = new RegExp(NETWORK_SERVICE_ARG)
const TYPE = /(^| )--type=\S/
const UTILITY = /(^| )--type=utility( |$)/

/** chromiumRole(argv) → 'network-service' (--type=utility with the network service sub-type) · 'child' (any other --type=) · null (no --type=). */
export function chromiumRole(argv) {
  const line = (Array.isArray(argv) ? argv : []).map((a) => String(a).replace(/"/g, '')).join(' ')
  if (!TYPE.test(line)) return null
  return UTILITY.test(line) && NETWORK_SERVICE.test(line) ? 'network-service' : 'child'
}
