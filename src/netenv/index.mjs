// index.mjs (src/netenv) — the machine's VPN / proxy software as asight sees it (RFC 1.6 §6 「探测」; V22). `status`, `doctor` and the first `on` call detectNetenv() and show what
// it says; the answer is also written to ~/.asight/netenv.json (0600; outside collector/, so a platform with no new collector writes it too), which the board reads through
// `/api/capture-health` (4.4). First version knows Clash Verge and mihomo (clash.mjs); every other product is 「不知道」 with the reason — never 「无」 (R11): an empty `products` always
// comes with a non-empty `unknown`. Only the product, the mode, the switches and, per harness, whether its traffic goes through it are kept: no secret, subscription address,
// node or proxy URL ever enters the result (V22, V52). Read-only: the only writes in this directory are writeNetenv's own file.
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asightHome } from '../off/paths.mjs'
import { HARNESS_IDS } from '../cli/harness-names.mjs'
import { readClash, unixGet } from './clash.mjs'

export const NETENV_SCHEMA = 1
/** `mode` of a product: its core's mode (rule / global / direct), or for a product that has no such mode the way it takes traffic in (tun / system-proxy); unknown when it could not be read. */
export const NETENV_MODES = Object.freeze(['rule', 'global', 'direct', 'tun', 'system-proxy', 'unknown'])
export const netenvFile = (home = os.homedir()) => path.join(asightHome(home), 'netenv.json')

/** → `{ at, products: [{ product: 'clash-verge' | 'mihomo', mode, tun, system_proxy, mixed_port, live, via: { <harness>: true | false | 'unknown' }, reason? }], unknown: [{ reason }] }`.
 *  Everything the world gives is a parameter a test replaces (0.1 §3): `exec` (the runner of `ps`), `readFile`, `request` (GET over the core's unix socket), `knownSocks`, `statSock`, `env`.
 *  `proxies` = { <harness>: [proxy URL…] } is what each harness is set to use, when the caller has read it (1.6 §9 reads it for every harness; here a caller that has none leaves it out and
 *  a harness is then through the product only when TUN is on). */
export async function detectNetenv({ home = os.homedir(), platform = process.platform, exec = null, readFile = nodeFs.readFileSync, request = unixGet, env = process.env, uid, statSock, knownSocks, proxies = null, harnesses = HARNESS_IDS, now = () => new Date() } = {}) {
  const clash = await readClash({ home, platform, env, exec, readFile, request, uid, statSock, knownSocks, harnesses, proxies })
  return { at: now().toISOString(), products: clash.products, unknown: clash.unknown }
}

/** Writes the result to ~/.asight/netenv.json whole or not at all (temp file, rename), 0600 in a 0700 directory when it had to be made → `{ path }`; throws what failed. */
export function writeNetenv(home, result, { fs = nodeFs } = {}) {
  const file = netenvFile(home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schema: NETENV_SCHEMA, ...result }, null, 2) + '\n', { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch { /* the failure that matters is e */ } throw e }
  return { path: file }
}
