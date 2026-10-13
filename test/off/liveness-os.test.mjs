// test/off/liveness-os.test.mjs — off judges who may hold a combined bundle on macOS and Windows too (RFC 4.6 §安装清单与卸载「判活快照」and
// 「撤销顺序」第 2 步, D39, 1.6 R3). `on` writes the liveness snapshot for the OS it runs on; `off` reads that OS's process table (`ps` on
// macOS, one Get-CimInstance question on Windows) and nothing else. A Codex that started after `on` re-reads combined-codex.pem at its next
// connection: removing the bundle under it leaves it with no network, so off keeps it without the asight CA and names the pid.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installCollector } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { listProcs } from '../../src/off/proc.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const ROOT = createCa({ commonName: 'liveness-os root' })
const roots = { node: [ROOT.certPem], osText: '' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n) => String(n).padStart(2, '0')
// `ps -o lstart` in the C locale: local time, the day padded to two columns with a space
const lstart = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`

// Each OS: where its codex lives (an install shape its form table carries — the npm vendor binary the node launcher spawns), and the
// process table that OS's reader gets, through the injected runner, with that codex in it, started a minute after `on`.
const OS = {
  darwin: {
    home: '/Users/u',
    codex: (home) => `${home}/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
    table: (exe, at) => ({ status: 0, stdout: [`  4242   4241   501 ${lstart(at)} ${exe} --model x`, `  4241      1   501 ${lstart(at)} node /opt/homebrew/bin/codex --model x`, ''].join('\n'), stderr: '' }),
  },
  win32: {
    home: 'C:\\Users\\u',
    codex: (home) => `${home}\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`,
    table: (exe, at) => ({ status: 0, stdout: JSON.stringify([{ p: 4242, pp: 4241, n: 'codex.exe', x: exe, s: at.getTime(), c: `"${exe}" --model x` }, { p: 4241, pp: 1, n: 'node.exe', x: 'C:\\Program Files\\nodejs\\node.exe', s: at.getTime(), c: 'node codex.js' }]), stderr: '' }),
  },
}

async function codexInstalled(osName) {
  const home = tmpDir('asight-liveness-os-')
  const env = path.join(home, '.codex', '.env')
  fs.mkdirSync(path.dirname(env), { recursive: true })
  fs.writeFileSync(env, 'OPENAI_API_KEY=sk-test\n')
  await installCollector({ home, env: { HOME: home }, ids: ['codex'], osName, harnesses: await loadHarnesses(), freePort: async () => 47011, scan: async () => [], roots })
  const dir = path.join(home, '.asight', 'collector')
  return { home, dir, bundle: path.join(dir, 'ca', 'combined-codex.pem'), caFp: certBlocks(fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8'))[0].fp }
}

for (const osName of Object.keys(OS)) {
  test(`${osName}: off keeps combined-codex.pem for a codex that started after on — without the asight CA, its pid named — instead of removing it under it`, async () => {
    const s = await codexInstalled(osName)
    const o = OS[osName]
    const exe = o.codex(o.home)
    const procs = () => listProcs({ uid: 501, platform: osName, exec: () => o.table(exe, new Date(Date.now() + 60_000)) })
    const r = await undoHarnesses({ dir: s.dir, home: s.home, manifest: readManifest(s.dir), ids: ['codex'], procs, roots })
    assert.ok(fs.existsSync(s.bundle), `the bundle a running codex re-reads at its next connection is still there (removed: ${r.removed.map((p) => path.basename(p)).join(', ')})`)
    assert.deepEqual(r.kept_bundles.map((k) => [path.basename(k.path), k.pids]), [['combined-codex.pem', [4242]]], 'kept, and the codex that may hold it is named')
    const left = certBlocks(fs.readFileSync(s.bundle, 'utf8'))
    assert.ok(left.length > 0 && !left.some((c) => c.fp === s.caFp), 'the same bundle without the asight CA')
    assert.deepEqual(r.still_trusting.map((p) => [p.pid, p.harness, p.until]), [[4242, 'codex', 'next-connection']], 'and the receipt says until when it trusts asight')
  })
}
