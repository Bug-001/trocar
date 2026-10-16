// test/netenv/no-vpn-writes-switch.test.mjs — 4.7 N15(b) run for real (D43 · D49, invariant 6): with the platform injected as
// darwin and as win32, the real install → on → on → off → off → uninstall of every harness (switch-kit.mjs's driver, a sandbox HOME) writes nothing under
// a VPN / proxy product's data directory and runs nothing that sets the system proxy. The check is the sandbox's own byte / mtime snapshots and the
// world's exec log, not a count of asight's write calls: it sees any writer, by any fs. The product directories are no-vpn-writes.test.mjs's
// PRODUCT_NAMES, placed under the per-user app-data folder and the XDG config folder with a file each.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { OSES, casesFor, run, diff, label } from '../helpers/switch-kit.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

const PRODUCT_NAMES = ['io.github.clash-verge-rev.clash-verge-rev', 'mihomo-party', 'FlClash', 'GUI.for.SingBox', 'v2rayN']
/** The product folders of world `w`: under its app-data folder and under ~/.config, each with one file of the product's own. */
const productDirs = (w) => PRODUCT_NAMES.flatMap((n) => [path.join(w.ctx.dirs.appSupport, n), path.join(w.home, '.config', n)])
const placeProducts = (w) => { for (const d of productDirs(w)) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'config.yaml'), 'mixed-port: 7897\n') } }
// what sets a system proxy: networksetup's set verbs and scutil writes (macOS); the Internet Settings values (Windows), by reg.exe or PowerShell
const SYSPROXY_WRITE = /networksetup\s+-set(web|secureweb|socksfirewall|autoproxy|proxyautodiscovery|ftp)|scutil\b.*\b(set|add)\b|\b(reg(\.exe)?\s+(add|delete|import)|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty)\b.*Internet Settings|netsh\s+winhttp\s+(set|import|reset)\s+proxy/i

/** The N15(b) findings of one run: a changed path under a product folder between any two snapshots, an exec that sets the system proxy. */
export function n15b(r) {
  const rel = productDirs(r.w).map((d) => path.relative(r.w.home, d))
  const inProduct = (p) => rel.some((d) => p === d || p.startsWith(d + path.sep))
  const snaps = [r.s0, r.s1, r.s2, r.s3, r.sE, r.s4, r.s5, r.s6]
  const bad = snaps.slice(1).flatMap((s, i) => diff(snaps[i], s).filter(({ p }) => inProduct(p)).map(({ p, why }) => `step ${i + 1}: ${p} ${why}`))
  return [...bad, ...r.s6.exec.filter((x) => SYSPROXY_WRITE.test(x)).map((x) => `a system-proxy write: ${x}`)]
}

const harnesses = await loadHarnesses()
process.chdir(tmpDir('asight-pipes-')) // a win32 control endpoint is a pipe name, served as a socket path relative to the cwd (switch-contract.test.mjs)
// one case per harness per OS (its first generated form): the writes N15 forbids do not depend on a file's shape or a user edit, which the contract suite varies
const CASES = OSES.flatMap((os) => harnesses.map((h) => casesFor(os, harnesses).find((s) => s.h === h.name && s.form)).filter(Boolean))

describe('N15(b): on / off / uninstall write nothing of a VPN / proxy product and set no system proxy', { concurrency: 4 }, () => {
  for (const spec of CASES) {
    it(label(spec), async () => {
      const r = await run({ ...spec, world: placeProducts }, harnesses)
      assert.ok(Object.keys(r.s6.files).some((p) => p.endsWith('config.yaml')), 'the product folders are in the snapshot (the check can see them)')
      assert.deepEqual(n15b(r), [])
    })
  }
  it('counter-example: a write into a product folder at on, and a networksetup at off, are found (the check goes red)', async () => {
    const spec = CASES[0]
    const r = await run({ ...spec, world: placeProducts, bad: (phase, w) => {
      if (phase === 'on') fs.writeFileSync(path.join(productDirs(w)[0], 'Script.js'), '// asight was here\n')
      if (phase === 'off') w.exec.push('networksetup -setwebproxy Wi-Fi 127.0.0.1 1')
    } }, harnesses)
    const found = n15b(r)
    assert.ok(found.some((x) => /^step 2: .*Script\.js added$/.test(x)), found.join('\n'))
    assert.ok(found.includes('a system-proxy write: networksetup -setwebproxy Wi-Fi 127.0.0.1 1'), found.join('\n'))
    for (const x of ['reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /d 127.0.0.1:1', 'networksetup -setautoproxyurl Wi-Fi http://x']) assert.match(x, SYSPROXY_WRITE)
    for (const x of ['networksetup -getwebproxy Wi-Fi', 'scutil --proxy', 'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer']) assert.doesNotMatch(x, SYSPROXY_WRITE, 'a read is not a write')
  })
})
