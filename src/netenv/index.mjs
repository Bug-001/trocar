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

/** ~/.asight/netenv.json as it is on disk → the object, or null when it is not there or does not parse (the board says that itself: src/health/read.mjs netenvOf). */
export function readNetenvFile(home, { fs = nodeFs } = {}) {
  try { const v = JSON.parse(fs.readFileSync(netenvFile(home), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
}
/** What a write keeps of the file already there: the probe's own keys are replaced whole; `adopted` (what `on` found, 1.6 §9.5) is carried over when the new result has none, and so is each harness of
 *  `topology` the new one does not redraw (a `status codex` redraws codex only: the others keep their own `at`). */
export function mergeNetenv(prev, result) {
  const out = { ...result }
  if (!prev) return out
  if (out.adopted === undefined && prev.adopted !== undefined) out.adopted = prev.adopted
  if (out.topology !== undefined && prev.topology && typeof prev.topology === 'object') out.topology = { ...prev.topology, ...out.topology }
  else if (out.topology === undefined && prev.topology !== undefined) out.topology = prev.topology
  return out
}

/** Writes the result to ~/.asight/netenv.json whole or not at all (temp file, rename), 0600 in a 0700 directory when it had to be made → `{ path }`; throws what failed. It is the one place under
 *  src/netenv that writes (4.7 N15). */
export function writeNetenv(home, result, { fs = nodeFs } = {}) {
  const file = netenvFile(home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schema: NETENV_SCHEMA, ...mergeNetenv(readNetenvFile(home, { fs }), result) }, null, 2) + '\n', { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch { /* the failure that matters is e */ } throw e }
  return { path: file }
}

/** One look at the VPN / proxy software for a command: `{ result }`, or `{ error }` when the probe itself failed (a failed probe is 不知道 with its reason, never 「无」). `deps.netenv({ proxies })` replaces
 *  the probe (a test's); `deps.exec` / `readFile` / `mihomoRequest` / `knownSocks` / `statSock` are detectNetenv's. A refusal of the test guard (ESANDBOX) is not a failed probe: it is thrown. */
export async function probeNetenv({ home, platform, env, proxies = null, deps = {} }) {
  try { return { result: deps.netenv ? await deps.netenv({ proxies }) : await detectNetenv({ home, platform, exec: deps.exec || null, env, proxies, readFile: deps.readFile, request: deps.mihomoRequest, knownSocks: deps.knownSocks, statSock: deps.statSock }) } } catch (e) {
    if (e && e.code === 'ESANDBOX') throw e
    return { error: String((e && e.message) || e) }
  }
}

const PRODUCT = { 'clash-verge': 'Clash Verge', mihomo: 'mihomo' }
const MODE = { rule: '规则模式', global: '全局模式', direct: '直连模式', tun: 'TUN 模式', 'system-proxy': '系统代理模式', unknown: '模式不知道' }
/** The line(s) about the VPN / proxy software (§6; `status` and `on` print them). `n` = what probeNetenv returns (`{ result }` / `{ error }`) or the same unwrapped (the receipt's `netenv`: a result, or `{ error }`):
 *  what could not be read is 不知道 with the reason, never 「无」. `ids`: the harnesses to say anything about. */
export function netenvText(n, { ids = null, platform = 'linux' } = {}) {
  if (n.error) return [`本机网络环境: 不知道(${n.error})`]
  const { products, unknown } = n.result || n
  if (!products.length) return [`本机网络环境: 不知道(${unknown.map((u) => u.reason).join('; ')})`]
  return products.flatMap((p) => {
    const flags = [p.tun === true ? 'TUN 已开' : p.tun === 'unknown' ? 'TUN 开没开不知道' : null, p.system_proxy === true ? '系统代理已开' : null].filter(Boolean)
    const via = Object.entries(p.via || {}).filter(([h]) => !ids || ids.includes(h))
    const group = (v) => via.filter(([, x]) => x === v).map(([h]) => h)
    const says = [group(true).length ? `${group(true).join('、')} 的流量经过它` : null, group(false).length ? `${group(false).join('、')} 不经过它` : null, group('unknown').length ? `${group('unknown').join('、')}: 是否经过它不知道` : null, platform === 'linux' ? 'asight 没有改它' : null].filter(Boolean)
    return [`本机网络环境: ${PRODUCT[p.product] || p.product}(${[MODE[p.mode] || p.mode, ...flags, ...(p.live ? [] : ['没问到它的控制接口'])].join(',')})${says.length ? `;${says.join(';')}` : ''}`, ...(p.reason ? [`  说明: ${p.reason}`] : [])]
  })
}

