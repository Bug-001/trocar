// asight Linux collector install / uninstall (spec 4.6 §身份与信任 §权限划分, D36 per-user model).
//
// D36 removes the dedicated engine account entirely. There are now exactly two halves:
//
//   setupHelper / uninstallHelper (ROOT, once per machine) — the ONLY privileged step. It installs
//     the capability helper `asight-redirector` to /usr/local/libexec/asight/ as root:root 0755
//     with file caps `cap_bpf,cap_net_admin,cap_perfmon+ep` (no setuid, no group, no inheritable),
//     verifies the caps and the checksum, and refuses a nosuid/noexec mount. Nothing else on the
//     machine is touched: no account, group, ACL, system unit, or /etc|/var|/run|/var/log/asight.
//
//   installUser / uninstallUser (OPERATOR, no sudo, refuses uid 0) — everything else lives under
//     the operator's own HOME. It mints a per-user collector CA into ~/.asight/collector/ca/
//     (ca.key 0600, asight-ca.pem), kept SEPARATE from the legacy ~/.asight/ca and NEVER put into
//     any trust store; injects a caller-supplied ADD-semantics trust env key into a JSON settings
//     file (per-harness agent-only injection is a later step) with byte-identical restore on
//     uninstall; optionally writes a systemd --user unit; and records originals in
//     ~/.asight/collector/install.json. Captured *.ndjson are user data — uninstall keeps them
//     unless --purge-data, and never `rm -rf ~/.asight` wholesale (legacy CA + v0 data live there).
//
// Note: this module is the arch/linux installer, but its installUser/uninstallUser logic is pure
// fs + node:crypto + optional systemd, so it runs (and is unit-tested) on non-Linux hosts too; the
// systemd unit is written only when asked and reloaded best-effort. Node built-ins only (D18),
// plus the engine's own zero-dep CA minting from core/tls, so the collector CA has exactly the
// shape the engine signs leaves with (arch -> core is the allowed direction; core never imports arch).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createCa } from '../../core/tls/ca.mjs'

export const DEFAULTS = {
  helperDir: '/usr/local/libexec/asight',
  helperBin: '/usr/local/libexec/asight/asight-redirector',
  caps: 'cap_bpf,cap_net_admin,cap_perfmon+ep',
  // relative to HOME
  collectorRel: '.asight/collector',
  caRel: '.asight/collector/ca',
  unitRel: '.config/systemd/user/asight-collector.service',
  unitName: 'asight-collector.service',
}

// Env vars that REPLACE the whole trust store (or the single CA file a client uses), rather than
// ADD to it. Pointing one of these at the asight-only CA would break every other TLS peer for the
// user, so installUser refuses them. Only the library-level ones live here (OpenSSL, Python
// requests, curl): arch/ stays harness-agnostic, so a caller that knows a harness-specific
// replace-semantics variable passes it in `opts.replaceKeys` and it is refused the same way.
// (Per-harness, agent-only trust injection is a later, harness-agnostic trust module — the user
// rejected global login-environment injection.)
const REPLACE_SEMANTICS = new Set(['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'])

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
function refuseRoot(who) {
  if (uid() === 0) throw new Error(`asight ${who}: refusing to run as root; run as the operator`)
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
  return { ok: true, bin: cfg.helperBin, caps: 'cap_net_admin,cap_perfmon,cap_bpf=ep', getcap: run('getcap', [cfg.helperBin]).out }
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
  try { fs.rmdirSync(cfg.helperDir) } catch { /* non-empty or already gone */ }
  return { ok: true, removed: true, warnings }
}

// ---- per-user (operator, no sudo) ----------------------------------------------------------
function paths(home) {
  const collectorDir = path.join(home, DEFAULTS.collectorRel)
  return {
    collectorDir,
    caDir: path.join(home, DEFAULTS.caRel),
    caKey: path.join(home, DEFAULTS.caRel, 'ca.key'),
    caPem: path.join(home, DEFAULTS.caRel, 'asight-ca.pem'),
    installJson: path.join(collectorDir, 'install.json'),
    stateJson: path.join(collectorDir, 'state.json'),
    lock: path.join(collectorDir, 'lock'),
    unit: path.join(home, DEFAULTS.unitRel),
  }
}

export function readInstall(home = os.homedir()) {
  try { return JSON.parse(fs.readFileSync(paths(home).installJson, 'utf8')) } catch { return null }
}

export function installUser(opts = {}) {
  refuseRoot('install')
  const home = opts.home || os.homedir()
  const envTargets = opts.envTargets || [] // [{file,key,value?}]
  // Built-in library-level replace-semantics keys + any harness-specific ones the caller names.
  const replaceKeys = new Set([...REPLACE_SEMANTICS, ...(opts.replaceKeys || [])])
  const withUnit = !!opts.withUnit
  const P = paths(home)

  const rec = {
    version: 1, created_at: new Date().toISOString(),
    ca: null, env_injections: [], unit: null, collector_dir: P.collectorDir,
  }

  // 1. Per-user collector CA (separate from ~/.asight/ca; NEVER into any trust store).
  fs.mkdirSync(P.caDir, { recursive: true })
  fs.chmodSync(P.caDir, 0o700)
  let caCreated = false
  if (!exists(P.caKey) || !exists(P.caPem)) {
    const { keyPem, certPem } = createCa({ commonName: opts.caCommonName || 'asight collector CA' })
    fs.writeFileSync(P.caKey, keyPem, { mode: 0o600 })
    fs.chmodSync(P.caKey, 0o600)
    fs.writeFileSync(P.caPem, certPem, { mode: 0o644 })
    caCreated = true
  }
  rec.ca = { dir: P.caDir, key: P.caKey, pem: P.caPem, created_by_asight: caCreated }

  // 2. Trust env injection into a JSON settings file, recording the ORIGINAL for a byte-identical
  //    restore. Correctness guards (D36 review #9):
  //    - A re-install keeps the FIRST-recorded original (never records the already-injected file).
  //    - A non-JSON (or non-object) target is refused, never silently rewritten as JSON.
  //    - Replace-semantics keys pointing at the asight-only CA are refused.
  //    - ATOMIC: every target is validated before ANY is written, so a refusal can never leave a
  //      half-injected set with no install.json to revert it.
  //    - A target edited by the user since OUR last install is flagged `diverged`, so uninstall
  //      drops only our key instead of a byte-restore that would discard the user's edit.
  const priorInj = (readInstall(home) || {}).env_injections || []

  // 2a. Validate every target up front; collect parsed state for the write pass. No writes yet.
  const staged = []
  for (const t of envTargets) {
    const value = t.value != null ? t.value : P.caPem
    if (replaceKeys.has(t.key)) {
      throw new Error(`asight install: refusing ${t.key} -> ${value}: it replaces the whole trust store, so an asight-only CA would break the user's other TLS peers`)
    }
    const existed = exists(t.file)
    let obj = {}
    let beforeBuf = null
    if (existed) {
      beforeBuf = fs.readFileSync(t.file)
      try { obj = JSON.parse(beforeBuf.toString('utf8')) } catch { throw new Error(`asight install: ${t.file} is not valid JSON; refusing to overwrite it`) }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`asight install: ${t.file} is not a JSON object; refusing to overwrite it`)
    }
    staged.push({ t, value, existed, obj, beforeBuf })
  }

  // 2b. Write every validated target.
  for (const { t, value, existed, obj, beforeBuf } of staged) {
    const was = priorInj.find((e) => e.file === t.file && e.key === t.key)
    const existedOrig = was ? was.existed : existed
    const original_b64 = was ? was.original_b64 : (beforeBuf ? beforeBuf.toString('base64') : null)
    // Divergence: the file as it is NOW differs from what we last wrote -> the user edited it
    // between installs, so a byte-restore of the first original would lose that edit.
    const beforeSha = existed ? sha(t.file) : null
    const diverged = was ? (!!was.diverged || beforeSha !== was.post_install_sha) : false
    obj.env = obj.env || {}
    obj.env[t.key] = value
    fs.mkdirSync(path.dirname(t.file), { recursive: true })
    fs.writeFileSync(t.file, JSON.stringify(obj, null, 2) + '\n')
    rec.env_injections.push({ file: t.file, key: t.key, existed: existedOrig, original_b64, diverged, post_install_sha: sha(t.file) })
  }

  // 2c. Carry forward any prior injection NOT re-touched this install, so a re-install with fewer
  //     targets does not orphan an earlier-injected key (it must still be reverted on uninstall).
  for (const p of priorInj) {
    if (!envTargets.some((t) => t.file === p.file && t.key === p.key)) rec.env_injections.push(p)
  }

  // 3. Optional systemd --user unit (MUST NOT set NoNewPrivileges / CapabilityBoundingSet — the
  //    helper already drops itself; a bounding set here would strip its file caps).
  if (withUnit) {
    // NOTE (D36 review #12): the `asight collector` CLI/daemon does not exist yet — wiring it is a
    // later step. This unit is a placeholder with an inert ExecStart so nothing mistakes it for a
    // working collector; the real ExecStart is set when the daemon/CLI lands. MUST NOT set
    // NoNewPrivileges / CapabilityBoundingSet (the helper drops itself; a bounding set would strip
    // its file caps).
    const unit = [
      '[Unit]', 'Description=asight transparent collector (per-user)', 'After=default.target', '',
      '[Service]', 'Type=simple',
      '# placeholder: replace with `asight collector start` once that CLI/daemon exists (not built yet)',
      'ExecStart=/usr/bin/false', 'Restart=no', '',
      '[Install]', 'WantedBy=default.target', '',
    ].join('\n')
    fs.mkdirSync(path.dirname(P.unit), { recursive: true })
    fs.writeFileSync(P.unit, unit, { mode: 0o644 })
    rec.unit = P.unit
    if (process.platform === 'linux') run('systemctl', ['--user', 'daemon-reload'])
  }

  fs.mkdirSync(P.collectorDir, { recursive: true })
  fs.writeFileSync(P.installJson, JSON.stringify(rec, null, 2) + '\n')
  return rec
}

export function uninstallUser(opts = {}) {
  refuseRoot('uninstall')
  const home = opts.home || os.homedir()
  const purgeData = !!opts.purgeData
  const P = paths(home)
  // Idempotent and safe on a partial install: a missing/incomplete install.json only means there
  // are no env keys to revert — the control-file cleanup and the optional data purge still run.
  const rec = readInstall(home) || {}

  // 1. Stop a running collector FIRST, before the CA/runtime state it depends on is removed
  //    (review #5). NOTE: the operator-facing `asight collector start` daemon is NOT built yet, so
  //    there is no asight-managed process to signal here today; once it lands this step will stop
  //    it (and the loader will then get EOF/PDEATHSIG and drop its links). For now we only disable
  //    the placeholder systemd --user unit (if systemd is running), remove any enable wants-symlink
  //    so none dangles once the unit file is gone, and clear the runtime dir the daemon will use.
  if (process.platform === 'linux' && (rec.unit || exists(P.unit))) {
    run('systemctl', ['--user', 'disable', '--now', DEFAULTS.unitName]) // disables the unit + its symlink, if systemd --user is up
  }
  // Remove any wants-symlink that still points at our unit (manual enable, or systemd not running).
  const userUnitDir = path.join(home, '.config', 'systemd', 'user')
  try {
    for (const d of fs.readdirSync(userUnitDir)) {
      if (!d.endsWith('.wants')) continue
      const link = path.join(userUnitDir, d, DEFAULTS.unitName)
      try { if (fs.readlinkSync(link).includes(DEFAULTS.unitName)) fs.rmSync(link, { force: true }) } catch { /* not a link / absent */ }
    }
  } catch { /* no user unit dir */ }
  // Clear the runtime dir (socket/lock the daemon will use) before removing the CA/state below.
  if (process.env.XDG_RUNTIME_DIR) fs.rmSync(path.join(process.env.XDG_RUNTIME_DIR, 'asight'), { recursive: true, force: true })

  // 2. Revert injected env keys BEFORE deleting the CA. Ordering matters only for a client that
  //    throws on a missing CA file -- some do, but only for replace-semantics bundle vars (which
  //    installUser already refuses to point at the asight CA); add-semantics clients degrade rather
  //    than hard-failing. Reverting the env first means no such client ever sees a dangling path.
  //    Three cases (review #9):
  //    - existed at install, untouched since, and never diverged -> byte-identical restore;
  //    - we created the file, it is untouched, and never diverged -> remove it;
  //    - the file was edited since install, or diverged between installs -> drop ONLY our key,
  //      keep the file (a byte-restore here would discard the user's edit).
  for (const e of (rec.env_injections || [])) {
    if (!exists(e.file)) continue
    const curSha = sha(e.file)
    if (e.existed && e.original_b64 != null && !e.diverged && curSha === e.post_install_sha) {
      fs.writeFileSync(e.file, Buffer.from(e.original_b64, 'base64'))
    } else if (!e.existed && !e.diverged && curSha === e.post_install_sha) {
      fs.rmSync(e.file, { force: true })
    } else {
      try {
        const obj = JSON.parse(fs.readFileSync(e.file, 'utf8'))
        if (obj && obj.env) { delete obj.env[e.key]; if (Object.keys(obj.env).length === 0) delete obj.env }
        fs.writeFileSync(e.file, JSON.stringify(obj, null, 2) + '\n')
      } catch { /* non-JSON now; leave as-is rather than corrupt */ }
    }
  }

  // 3. Remove the systemd --user unit file and reload (best-effort).
  if ((rec.unit || exists(P.unit))) {
    fs.rmSync(rec.unit || P.unit, { force: true })
    if (process.platform === 'linux') run('systemctl', ['--user', 'daemon-reload'])
  }

  // 4. Remove exactly our collector control files (CA, state, install record, lock). The runtime
  //    dir was already cleared in step 1. Captured *.ndjson are kept unless --purge-data. NEVER
  //    rm -rf ~/.asight (legacy CA + v0).
  fs.rmSync(P.caDir, { recursive: true, force: true })
  fs.rmSync(P.stateJson, { force: true })
  fs.rmSync(P.lock, { force: true })
  fs.rmSync(P.installJson, { force: true })
  let purged = 0
  if (purgeData && exists(P.collectorDir)) {
    for (const n of fs.readdirSync(P.collectorDir)) {
      if (n.endsWith('.ndjson')) { fs.rmSync(path.join(P.collectorDir, n), { force: true }); purged++ }
    }
  }
  return { ok: true, removed: true, kept_captures: !purgeData, purged }
}

// Minimal CLI for manual use / the lab test driver.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2]
  const j = (x) => console.log(JSON.stringify(x))
  // Extra config (home, envTargets, caCommonName) may be passed as JSON in ASIGHT_INSTALL_CFG so
  // the lab driver can run install-user/uninstall-user as the operator against a temp HOME.
  const extra = process.env.ASIGHT_INSTALL_CFG ? JSON.parse(process.env.ASIGHT_INSTALL_CFG) : {}
  try {
    if (cmd === 'setup-helper') j(setupHelper({ binarySrc: process.env.ASIGHT_HELPER_SRC }))
    else if (cmd === 'uninstall-helper') j(uninstallHelper())
    else if (cmd === 'install-user') j(installUser({ withUnit: process.argv.includes('--unit'), ...extra }))
    else if (cmd === 'uninstall-user') j(uninstallUser({ purgeData: process.argv.includes('--purge-data'), ...extra }))
    else { console.error('usage: install.mjs setup-helper|uninstall-helper|install-user|uninstall-user'); process.exit(2) }
  } catch (e) { console.error(String(e.message || e)); process.exit(1) }
}
