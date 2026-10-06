// asight Linux capability-helper install / removal (spec 4.6 §身份与信任 §权限划分, D36 per-user model).
//
// D36 removes the dedicated engine account entirely. There are now exactly two halves:
//
//   setupHelper / uninstallHelper (ROOT, once per machine) — the ONLY privileged step. It installs
//     the capability helper `asight-redirector` to /usr/local/libexec/asight/ as root:root 0755
//     with file caps `cap_bpf,cap_net_admin,cap_perfmon+ep` (no setuid, no group, no inheritable),
//     verifies the caps and the checksum, and refuses a nosuid/noexec mount. Nothing else on the
//     machine is touched: no account, group, ACL, system unit, or /etc|/var|/run|/var/log/asight.
//
//   The per-user half (operator, no sudo: the collector CA, the agents' trust entries, the install manifest) is
//     `asight collector install|uninstall` in src/collector/install.mjs (RFC 4.6 §安装清单与卸载). It records
//     every change in ~/.asight/collector/install-manifest.json and undoes key by key; it never copies a user
//     file or rewrites whole JSON (D28). The earlier installUser / uninstallUser here did both and are gone
//     (Plan 3a).
//
// Node built-ins only (D18).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const DEFAULTS = {
  helperDir: '/usr/local/libexec/asight',
  helperBin: '/usr/local/libexec/asight/asight-redirector',
  caps: 'cap_bpf,cap_net_admin,cap_perfmon+ep',
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
function exists(p) { try { fs.statSync(p); return true } catch { return false } }
function sha(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return null } }
function uid() { return typeof process.getuid === 'function' ? process.getuid() : -1 }
function requireRoot() {
  if (process.platform !== 'linux') throw new Error('asight setup-helper: Linux only')
  if (uid() !== 0) throw new Error('asight setup-helper: must run as root (sudo)')
}

// Mount options for the filesystem that contains `p`, from /proc/self/mountinfo (longest match).
function mountOptions(p) {
  let data
  try { data = fs.readFileSync('/proc/self/mountinfo', 'utf8') } catch { return null }
  let best = null, bestLen = -1
  for (const line of data.split('\n')) {
    const parts = line.split(' ')
    if (parts.length < 6) continue
    const mountPoint = parts[4]
    if ((p === mountPoint || p.startsWith(mountPoint.endsWith('/') ? mountPoint : mountPoint + '/')) && mountPoint.length > bestLen) {
      best = parts[5]; bestLen = mountPoint.length // per-mount options (field 6), where nosuid/noexec live
    }
  }
  return best
}

// ---- root helper (once per machine) --------------------------------------------------------

// A setup-helper killed between its copy and its rename leaves the staged copy behind — possibly already capped.
// Only setup-helper ever writes these names, so the next setup-helper and setup-helper --remove delete them and say so.
const STAGED = /^\.asight-redirector\.new\.\d+$/
export function sweepStaged(dir, keep = null) {
  let names
  try { names = fs.readdirSync(dir) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  const gone = names.filter((n) => STAGED.test(n) && n !== keep)
  for (const n of gone) fs.rmSync(path.join(dir, n), { force: true })
  return gone
}
export function setupHelper(opts = {}) {
  requireRoot()
  const cfg = { ...DEFAULTS, ...opts }
  const src = opts.binarySrc
  if (!src || !exists(src)) throw new Error('asight setup-helper: built binarySrc not found: ' + src)

  // Refuse a nosuid/noexec mount: file caps are ineffective there (and exec may be blocked).
  const mopts = mountOptions(cfg.helperDir) || mountOptions(path.dirname(cfg.helperDir))
  if (mopts && /(^|,)(nosuid|noexec)(,|$)/.test(mopts)) {
    throw new Error(`asight setup-helper: ${cfg.helperDir} is on a ${mopts.includes('noexec') ? 'noexec' : 'nosuid'} mount`)
  }

  fs.mkdirSync(cfg.helperDir, { recursive: true, mode: 0o755 })
  fs.chmodSync(cfg.helperDir, 0o755)
  try { fs.chownSync(cfg.helperDir, 0, 0) } catch { /* already root-owned */ }

  // Install atomically: stage into a temp file in the SAME dir, cap it, verify, then rename over
  // the live path. rename(2) swaps the inode, so a loader currently executing the old helper keeps
  // running (no ETXTBSY) and the path is never visible without its caps (D36 review #6).
  const tmp = path.join(cfg.helperDir, `.asight-redirector.new.${process.pid}`)
  const swept = sweepStaged(cfg.helperDir, path.basename(tmp))
  const srcSha = sha(src)
  try {
    fs.copyFileSync(src, tmp)
    fs.chmodSync(tmp, 0o755)
    try { fs.chownSync(tmp, 0, 0) } catch {}
    // Copy-integrity check: the installed bytes equal the source bytes (NOT a build-provenance check).
    if (sha(tmp) !== srcSha) throw new Error('asight setup-helper: copy integrity check failed (installed bytes != source)')
    const setcap = run('setcap', [cfg.caps, tmp])
    if (setcap.code !== 0) throw new Error('asight setup-helper: setcap failed: ' + (setcap.err || setcap.out))
    // getcap prints the path then the caps in capability-NUMBER order (cap_net_admin=12,
    // cap_perfmon=38, cap_bpf=39) at a flag suffix. Require EXACTLY these three caps at =ep
    // (effective+permitted) and nothing else — no extra cap, and no inheritable ('i') bit.
    const capPart = (run('getcap', [tmp]).out.split(/\s+/).pop() || '')
    const m = capPart.match(/^([a-z0-9_,]+)=([a-z]+)$/)
    const gotCaps = m ? m[1].split(',').sort() : []
    const gotFlags = m ? m[2].split('').sort().join('') : ''
    const wantCaps = ['cap_bpf', 'cap_net_admin', 'cap_perfmon'].sort()
    if (JSON.stringify(gotCaps) !== JSON.stringify(wantCaps) || gotFlags !== 'ep') {
      throw new Error(`asight setup-helper: unexpected caps ${JSON.stringify(capPart)} (want exactly cap_bpf,cap_net_admin,cap_perfmon=ep)`)
    }
    fs.renameSync(tmp, cfg.helperBin) // atomic swap over any running loader
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw e
  }
  return { ok: true, bin: cfg.helperBin, caps: 'cap_net_admin,cap_perfmon,cap_bpf=ep', getcap: run('getcap', [cfg.helperBin]).out, swept }
}

export function uninstallHelper(opts = {}) {
  requireRoot()
  const cfg = { ...DEFAULTS, ...opts }
  // Warn (do not fail) if any loader is still running: it keeps working until it exits; later
  // starts fail open and `doctor` reports the missing helper.
  const running = run('pgrep', ['-f', cfg.helperBin])
  const warnings = []
  if (running.code === 0 && running.out) warnings.push('a redirector is still running; it will keep working until it exits')
  fs.rmSync(cfg.helperBin, { force: true })
  const swept = sweepStaged(cfg.helperDir)
  if (swept.length) warnings.push(`removed ${swept.length} copy(ies) an interrupted setup-helper had staged: ${swept.join(', ')}`)
  try { fs.rmdirSync(cfg.helperDir) } catch (e) { // gone already is fine; anything else is said, never swallowed
    if (e.code !== 'ENOENT') warnings.push(`${cfg.helperDir} was left in place (${e.code}): ${(() => { try { return fs.readdirSync(cfg.helperDir).join(', ') } catch { return '?' } })()}`)
  }
  return { ok: true, removed: true, warnings, swept }
}

// Minimal CLI for the lab driver (the product command is `asight setup-helper`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2]
  const j = (x) => console.log(JSON.stringify(x))
  try {
    if (cmd === 'setup-helper') j(setupHelper({ binarySrc: process.env.ASIGHT_HELPER_SRC }))
    else if (cmd === 'uninstall-helper') j(uninstallHelper())
    else { console.error('usage: install.mjs setup-helper|uninstall-helper'); process.exit(2) }
  } catch (e) { console.error(String(e.message || e)); process.exit(1) }
}
