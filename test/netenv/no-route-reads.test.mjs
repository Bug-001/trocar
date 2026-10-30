// test/netenv/no-route-reads.test.mjs — D49, 4.7: trocar reads no routing table and no interface list — the readings that would let it
// recognise a TUN-mode VPN. The exec lists of the code status and doctor run (src/cli/{doctor,status}.mjs, src/netenv/**, and the per-OS fact sources
// status hands them, src/collector/arch/*/netfacts.mjs) contain no route / ifconfig / ip route / Get-NetRoute. A command shown to the user is not an exec.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findIn } from '../helpers/code-text.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.mjs$/.test(e.name) ? [path.join(d, e.name).split(path.sep).join('/')] : [])
const FILES = ['src/cli/doctor.mjs', 'src/cli/status.mjs', ...walk('src/netenv'), ...['darwin', 'win32', 'linux'].map((os) => `src/collector/arch/${os}/netfacts.mjs`).filter((f) => fs.existsSync(path.join(ROOT, f)))]
// a runner called with the tool as its first argument (run / exec / execFile / spawn / execTool, sync or not), the tool a route or interface reader.
// `netstat` is the one tool that reads either: its routing table and interface list are `-r` / `-i` (what D49 forbids), its SOCKET table is `-anv -p tcp`
// — which is how the engine finds a connection's owner (arch/darwin/socktable.mjs) and how `status` reads the listeners (arch/darwin/netfacts.mjs), and
// which names no route and no interface. So netstat is red only with a flag that holds `r` or `i`.
const RUNNER = String.raw`\b(?:run|exec|execFile|execFileSync|spawn|spawnSync|execSync|execTool|runAsync)\s*\(\s*`
const EXEC_ROUTE = new RegExp([
  `${RUNNER}(['"\`])(?:route|ifconfig|ip|Get-NetRoute|Get-NetIPInterface|Get-NetAdapter)(?:\\.exe)?\\1`,
  `${RUNNER}(['"\`])netstat\\2\\s*,\\s*\\[[^\\]]*(['"\`])-[a-zA-Z]*[ri]`,
  String.raw`(['"\`])[^'"\`\n]*\b(?:ip route|route -n get|route print|ifconfig|Get-NetRoute)\b[^'"\`\n]*\4\s*[,)]\s*(?:\[|\{|$)`,
].join('|'), 'g')
export const routeReads = (files, read) => files.flatMap((f) => findIn(read(f), EXEC_ROUTE).map((h) => `${f}:${h.line} ${h.text}`))

test('status and doctor run no route / interface reader (D49)', () => {
  assert.ok(FILES.length > 5)
  assert.deepEqual(routeReads(FILES, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')), [], 'a TUN reading lets trocar recognise a VPN; D49 reads only the agent\'s and the system\'s proxy')
})

test('the scan goes red on a seeded route read, and not on a comment, a user-facing command or another tool', () => {
  const seeded = {
    'src/netenv/x.mjs': "const r = run('route', ['-n', 'get', 'default'])\n// run('ifconfig')\nconst cmd = { run: 'netstat -rn', shell: 'sh' }\nconst l = run('lsof', ['-nP'])\nexecFile('ip', ['route', 'get', '1.1.1.1'])\nrun('netstat', ['-anv', '-p', 'tcp'])\nexecTool('netstat', ['-rn'])\nrun('netstat', ['-i'])",
    'src/cli/status.mjs': "const out = execSync('ip route show default', {})",
  }
  assert.deepEqual(routeReads(Object.keys(seeded), (f) => seeded[f]).map((x) => x.replace(/ .*/, '')),
    ['src/netenv/x.mjs:1', 'src/netenv/x.mjs:5', 'src/netenv/x.mjs:7', 'src/netenv/x.mjs:8', 'src/cli/status.mjs:1'],
    'the socket-table read of line 6 is not a route read; netstat with -rn or -i is')
})
