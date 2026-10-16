// test/netenv/no-route-reads.test.mjs — the backlog (D49, 4.7): asight reads no routing table and no interface list — the readings that would let it
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
// a runner called with the tool as its first argument (run / exec / execFile / spawn / execTool, sync or not), the tool a route or interface reader
const EXEC_ROUTE = /\b(?:run|exec|execFile|execFileSync|spawn|spawnSync|execSync|execTool|runAsync)\s*\(\s*(['"`])(?:route|ifconfig|ip|netstat|Get-NetRoute|Get-NetIPInterface|Get-NetAdapter)(?:\.exe)?\1|(['"`])[^'"`\n]*\b(?:ip route|route -n get|route print|ifconfig|Get-NetRoute)\b[^'"`\n]*\2\s*[,)]\s*(?:\[|\{|$)/g
export const routeReads = (files, read) => files.flatMap((f) => findIn(read(f), EXEC_ROUTE).map((h) => `${f}:${h.line} ${h.text}`))

test('status and doctor run no route / interface reader (D49)', () => {
  assert.ok(FILES.length > 5)
  assert.deepEqual(routeReads(FILES, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')), [], 'a TUN reading lets asight recognise a VPN; D49 reads only the agent\'s and the system\'s proxy')
})

test('the scan goes red on a seeded route read, and not on a comment, a user-facing command or another tool', () => {
  const seeded = {
    'src/netenv/x.mjs': "const r = run('route', ['-n', 'get', 'default'])\n// run('ifconfig')\nconst cmd = { run: 'netstat -rn', shell: 'sh' }\nconst l = run('lsof', ['-nP'])\nexecFile('ip', ['route', 'get', '1.1.1.1'])",
    'src/cli/status.mjs': "const out = execSync('ip route show default', {})",
  }
  assert.deepEqual(routeReads(Object.keys(seeded), (f) => seeded[f]).map((x) => x.replace(/ .*/, '')), ['src/netenv/x.mjs:1', 'src/netenv/x.mjs:5', 'src/cli/status.mjs:1'])
})
