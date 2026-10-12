// optin.mjs — the opt-in items of 4.9 §2.4 (D43⑥, 1.6 §1.7): the darwin twin of arch/win32/optin.mjs (plan Task 14's shared half, landed
// with the flip checklist ④). The changes whose reach goes beyond the agent itself are never the default: `on`'s plan lists what each form
// would need and what it implies (「要你点名的」, printed by formatPlan like every non-win32 plan); the user names the form
// (`asight on <harness> --opt-in <form>`); asight performs it, ledgers it with `scope`, backs the prior state up first, and `off` / the
// standalone undo take it out again (src/off/darwin-optin.mjs's registry — inline JavaScript, so it runs when the source tree is gone).
// The item catalog (what the darwin harness data declares, 4.9 §2.3's table):
//   user-path-shim   kimi-code.cli · opencode.cli — the launch shim (~/.asight/collector/bin/<command>, carrying the group's kernel
//                    listener and, for kimi, the CA file) + the sentinel PATH line in the zsh rc files: .zshrc, .zshenv, .zprofile and
//                    .zlogin — all four that exist, zsh reading a different subset per shell kind (4.9 §2.3's kimi row); in a file that
//                    holds the Kimi installer's own PATH line, asight's goes after it (the later `export PATH` wins). ONE user-level
//                    item, reference-counted as 4.8 §6.3 counts the Windows PATH entry: the lines and the shim directory go when the
//                    last shim in them is removed, so `off kimi-code` does not break opencode; `shim-not-on-path` is judged by the order
//                    of `which -a` (the status-side check, MA4's row — not this file).
//   keychain-login   claude-code.desktop — the login keychain's trust settings, `security add-trusted-cert` in the USER domain (never the
//                    `-r trustRoot` form, 1.6's forbidden row), the OS's own authorization dialog carrying the consent (1.6:107; a decline
//                    is the user's own no, the win32 cert twin's wording); found and removed by fingerprint (§6.4, V56's shape) — the read
//                    back and the undo both key on the certificate's SHA-256, never on the common name.
//   desktop-launcher claude-code.desktop — the proxy door the 2026-10-12 lab verdict measured (§6.4): env is dead to Desktop's Chromium
//                    network service, so the item writes a LAUNCHER, ~/.asight/collector/bin/claude-desktop-asight (0755), which execs the
//                    real bundle binary with Chromium's --proxy-server at the group's listener plus --proxy-bypass-list. The URL carries no
//                    password (Chromium ignores embedded credentials anyway; the group is auth:false, 4.8 §3.2), the app binary is
//                    /Applications/Claude.app's, ~/Applications' as the fallback, and neither being there is a refusal (Desktop is not
//                    installed). The item steers ONLY instances started through the launcher — a running Desktop is untouched (the impact,
//                    the summary and the plan hint all say so verbatim). Undo: the launcher file goes (src/off/darwin-optin.mjs).
// Pure data and injected-exec functions (the win32 twin's rule): no socket, no process, no keychain of its own; a test runs everything
// against a sandbox HOME and a recording runner. The planOptIns / optinFormsOf core is the win32 twin's same-logic copy (4.9's
// development boundary: the hoist into core/ is the merge-period coordination, OPEN 3) — if you change what it means, change both.
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { writeBackup } from '../../../off/backup.mjs'
import { insertLine, lineComment } from '../../../off/text-edit.mjs'
import { execTool } from '../../../off/exec.mjs'
import { certBlocks } from '../../../off/pem.mjs'
import { readIngressConfig } from './ingress-config.mjs'
import { proxyUrl } from './forms.mjs'
import { renderShTemplate } from './shims.mjs'

const nodeFs = fs

/** Every item 4.9 §2.4's table names, with the manifest kind it is ledgered as. `when` (a fact that must hold before the item is even
 *  offered) is the win32 twin's mechanism; no darwin item has one. Frozen data: adding a kind means a manifest/OFF_VERSION bump and an
 *  undo in src/off/darwin-optin.mjs. */
export const OPTIN_ITEMS = Object.freeze({
  'user-path-shim': { scope: 'user', parts: [{ kind: 'optin-rc-path' }] },
  'keychain-login': { scope: 'user', parts: [{ kind: 'optin-keychain-cert' }] },
  'desktop-launcher': { scope: 'user', parts: [{ kind: 'optin-desktop-launcher' }] },
})

/** Whether `kind` is one of this module's (the manifest's KNOWN_KINDS is the wider truth). */
export const isOptinKind = (kind) => Object.values(OPTIN_ITEMS).some((x) => x.parts.some((p) => p.kind === kind))

/** The opt-in rows of `groups` (route-plan's groupsOf shape): one row per (form, item), carrying what the plan prints and what
 *  `--opt-in` names — the win32 twin's planOptIns, same logic (see the header). An item the table has no entry for is a TypeError, never
 *  a silent skip: the harness data declares the catalog, and a name nobody knows is a bug, not a feature.
 *   groups   groupsOf(descriptors) — the items live on the group; every form of the group shares them
 *   optIns   the form ids the user named on this `on`
 *   manifest the install manifest as it is now (null: none) — an item with a ledger entry is `done`, never re-offered as needed
 *  → [{ form, harness, item, kinds, scope, admin, impact, command, chosen, applicable, state }] — `command` is the whole line the plan
 *  and `status` print; `state` is 'needed' | 'done'. */
export function planOptIns({ groups = [], optIns = [], manifest = null } = {}) {
  const named = new Set(optIns)
  const rows = []
  for (const x of groups) {
    const items = (x.group && Array.isArray(x.group.optIn)) ? x.group.optIn : []
    for (const it of items) {
      const def = OPTIN_ITEMS[it.item]
      if (!def) throw new TypeError(`unknown opt-in item ${JSON.stringify(it.item)} on group ${x.g} (4.9 §2.4 has no such item)`)
      const entries = optinEntriesOf(manifest, x.harness)
      for (const f of x.forms) {
        const mine = entries.filter((e) => e.form === f.id && e.item === it.item)
        const state = mine.some((e) => e.pending_admin) ? 'pending-admin' : mine.some((e) => e.confirmed !== false) ? 'done' : 'needed'
        rows.push({
          form: f.id, harness: x.harness, item: it.item, kinds: def.parts.map((p) => p.kind), scope: def.scope, admin: def.scope === 'machine',
          impact: it.impact, command: `asight on ${x.harness} --opt-in ${f.id}`, chosen: named.has(f.id), applicable: true, state,
        })
      }
    }
  }
  return rows
}

/** The manifest's opt-in entries of one harness (entries the opt-in apply wrote: kind optin-*, form recorded). */
const optinEntriesOf = (manifest, harness) => (manifest && Array.isArray(manifest.entries) ? manifest.entries.filter((e) => e && isOptinKind(e.kind) && e.harness === harness) : [])

/** → every form id that has opt-in items in `groups` (the `--opt-in` usage error lists them; naming anything else is a usage error). */
export const optinFormsOf = (groups) => [...new Set(planOptIns({ groups }).map((r) => r.form))]

// ── the doing of a named item ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// applyOptIn({ row, manifest, dir, home, env, fs, now, save, note, failure, state, deps }) → { state: 'done' | 'failed', reason? } — the
// win32 twin's contract, one driver (below): refuse / error → nothing written; the part is ledgered BEFORE its write (a crash past it is
// undoable, not a mystery) and confirmed only by the read-back after it. `state(rec)` writes the §12 state events (optin-applied),
// `note(rec)` an install-note of this run, `failure(rec)` a failure record. Everything the world gives is injected (`deps`: ingress).

const ledgerEntry = ({ kind, harness, form, item, scope, path: p, ...rest }) => ({ kind, harness, form, item, scope, path: p ?? `${form}:${item}`, undo_by_hand: `${form} 的点名项(${kind}):撤销是 asight off ${harness}`, installed_at: new Date().toISOString(), ...rest })

const groupOf = (groups, form) => (groups || []).find((x) => x.forms && x.forms.some((f) => f.id === form)) || null
const ingressOf = ({ dir, deps = {}, fs: f = nodeFs }) => deps.ingress || readIngressConfig({ dir, fs: f })
const kernelUrlOf = ({ group, ingress, what }) => {
  if (!ingress || ingress.missing || ingress.error) return { error: `the ingress config could not be read (${ingress && (ingress.missing ? 'there is none yet' : ingress.error)}), so ${what} has no kernel port to point at; run asight on first` }
  const port = ingress.groupPorts && ingress.groupPorts[group.g]
  if (!port) return { error: `the ingress config has no kernel port for the group ${group.g}` }
  return { url: proxyUrl(group.group, { port, listenerToken: ingress.listenerToken }) }
}

// the zsh rc files the PATH line goes in (4.9 §2.3's kimi row): zsh reads a different subset per shell kind — a line only in .zshrc is
// invisible to a non-interactive or login-only shell — so every one of the four that exists is lined
const RC_FILES = ['.zshrc', '.zshenv', '.zprofile', '.zlogin']
// the anchor: in a file that holds the Kimi installer's own PATH line, asight's goes after it (within a file the later export wins, so
// the shim comes first in every read order — the base's ordering rule, harness/kimi-code.mjs's)
const INSTALLER_LINE = '^[^#]*\\.kimi-code/bin'
// the real binary each command's shim forwards to: the native installs' own paths (the npm kimi build has no shim entry, as on Linux and
// Windows; OpenCode's npm install is itself unmeasured, MA4)
const REAL_BINARY = { kimi: (home) => path.join(home, '.kimi-code', 'bin', 'kimi'), opencode: (home) => path.join(home, '.opencode', 'bin', 'opencode') }

// the desktop-launcher item's own constants (4.9 §6.4, 2026-10-12): the launcher's name, the bypass list carried beside the switch (the two
// loopback names stay direct, and <-loopback> cancels Chromium's wider implicit link-local bypass so nothing else silently escapes), and the
// bundle binaries in the order the form's own patterns meet them (/Applications first, ~/Applications as the fallback)
const LAUNCHER_NAME = 'claude-desktop-asight'
const PROXY_BYPASS = '127.0.0.1,localhost,<-loopback>'
const DESKTOP_BINS = (home) => [path.join(path.sep, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'), path.join(home, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude')]

/** The sentinel PATH line — ONE text for every command (the line is the shared item the reference count is about, 4.9 §2.3's kimi row);
 *  src/off/darwin-optin.mjs carries its own copy and test/collector/arch/darwin/optin.test.mjs holds the two equal. */
export const rcLineOf = (binDir) => `export PATH="${binDir}:$PATH" ${lineComment('runs kimi / opencode through its asight launch shim')}`

/** Everything the rc-path item needs, read BEFORE anything is written (a refusal writes nothing at all) — the win32 twin's userValuesOf
 *  shape: `{ parts }` (one part: the ledger entry + its `do()`), `{ error }`, or `{ refuse: { reason } }` (the world says no: the command's
 *  binary is not there — nothing to forward to). */
function rcPathValues(a) {
  const { row, groups, dir = null, home, fs: f = nodeFs, now = () => new Date(), deps = {} } = a
  if (!dir) return { error: 'no collector directory is wired in (the rc-path item cannot be built)' }
  const g = groupOf(groups, row.form)
  if (!g) return { error: `the form ${row.form} is not in this on's groups` }
  const pe = g.group.proxyEntry
  const command = pe && pe.kind === 'shim' ? pe.command : null
  if (!command) return { error: `the form ${row.form} has no shim command, so there is no shim to install` }
  const realBinary = REAL_BINARY[command] ? REAL_BINARY[command](home) : null
  if (!realBinary) return { error: `the command ${command} has no known native binary on darwin, so there is nothing for a shim to forward to` }
  if (!f.existsSync(realBinary)) return { refuse: { reason: `${command} is not the native install (${realBinary} is not there), so asight installs no shim — the npm build has no shim entry, as on Linux and Windows` } }
  const ku = kernelUrlOf({ group: g, ingress: ingressOf({ dir, deps, fs: f }), what: `the ${command} shim` })
  if (ku.error) return { error: ku.error }
  const binDir = path.join(dir, 'bin')
  if (/["$`\\]/.test(binDir)) return { error: `${binDir} holds a character a shell would expand inside the PATH line's double quotes` }
  const rcs = RC_FILES.map((n) => path.join(home, n)).filter((file) => f.existsSync(file))
  if (!rcs.length) return { error: `none of ~/${RC_FILES.join(', ~/')} exists, so there is no shell rc file to put the PATH line in (zsh reads only these four kinds)` }
  const caFile = path.join(dir, 'ca', 'asight-ca.pem')
  if (!f.existsSync(caFile)) return { error: `the collector CA (${caFile}) is not there; run asight on first` }
  const shim = renderShTemplate(command === 'kimi' ? 'kimi.sh.tmpl' : 'opencode.sh.tmpl', { proxy: ku.url, ...(command === 'kimi' ? { caFile } : {}), realBinary })
  const line = rcLineOf(binDir)
  return { parts: [{
    kind: 'optin-rc-path',
    entry: ledgerEntry({ kind: 'optin-rc-path', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: path.join(binDir, command),
      values: { command, binDir, realBinary, proxy: ku.url, rcs: rcs.map((file) => ({ file })) } }),
    do: () => {
      f.mkdirSync(binDir, { recursive: true })
      f.writeFileSync(path.join(binDir, command), shim, { mode: 0o755 })
      const done = []
      for (const rc of rcs) {
        const text = f.readFileSync(rc, 'utf8')
        if (text.includes(line)) { done.push({ file: rc, lined: 'already' }); continue } // the other command's item, or an earlier run: the line is the shared item, written once
        const anchor = command === 'kimi' && new RegExp(INSTALLER_LINE, 'm').test(text) ? INSTALLER_LINE : null
        const r = insertLine(text, { line, after: anchor })
        const backup = writeBackup({ home, file: rc, data: Buffer.from(text, 'utf8'), now: now(), fs: f }) // R2: before the change
        f.writeFileSync(rc, r.text)
        done.push({ file: rc, backup, ops: r.ops, post: crypto.createHash('sha256').update(Buffer.from(r.text, 'utf8')).digest('hex') })
      }
      // the read-back: every rc file holds the line, the shim is executable in place
      for (const rc of rcs) if (!f.readFileSync(rc, 'utf8').includes(line)) return { ok: false, reason: `${rc} does not hold the PATH line after the write` }
      if (!(f.statSync(path.join(binDir, command)).mode & 0o111)) return { ok: false, reason: 'the shim file is not executable' }
      return { ok: true, rcs: done }
    },
  }], summary: `${command} in ${binDir}, the directory first on PATH through a marked line in ${rcs.length} zsh rc file(s)` }
}

/** One named item (turnOn calls this per chosen row, inside the op lock, after the install's own writes). The machine half does not exist
 *  on darwin in v1 (4.9 §2.4: no form needs it); every item is the user half. */
export async function applyOptIn(args) {
  const { row } = args
  const def = OPTIN_ITEMS[row.item]
  if (!def) return { state: 'failed', reason: `unknown opt-in item ${row.item}` }
  if (def.scope === 'machine') return { state: 'failed', reason: `the machine-level item ${row.item} has no darwin form in v1 (4.9 §2.4)` }
  if (row.item === 'user-path-shim') return applyUserOne(args, rcPathValues)
  if (row.item === 'keychain-login') return applyUserOne(args, keychainValues)
  if (row.item === 'desktop-launcher') return applyUserOne(args, desktopLauncherValues)
  return { state: 'failed', reason: `the user item ${row.item} is not built yet` }
}

// the login keychain the CC-Desktop item's certificate goes into (4.9 §2.4's keychain row): the USER domain — the machine-level anchor
// /Library/Keychains/System.keychain is the admin path darwin v1 has no form needing
const loginKeychainOf = (home) => path.join(home, 'Library', 'Keychains', 'login.keychain-db')
// the authorization dialog is the user typing their password into the OS's own prompt — 10 s would time it out mid-sentence, so the
// mutating security calls carry a human-scale timeout (the read-backs keep the default)
const DIALOG_MS = 120000

/** Everything the keychain item needs, read BEFORE anything is written — the win32 twin's certValuesOf shape: `{ parts }` (the ledger
 *  entry + its `do()`), `{ error }`. The CA's SHA-256 fingerprint (node's `AB:CD:…` form, pem.mjs's fp) is the identity the ledger, the
 *  read-back and the undo all key on — a second certificate of the same common name never matches it. `deps.run` is the injected runner
 *  of the security tool (execTool's); without it the sandbox refuses to run security for real. */
function keychainValues(a) {
  const { row, dir = null, home, env = process.env, fs: f = nodeFs, deps = {} } = a
  if (!dir) return { error: 'no collector directory is wired in (the keychain item cannot be built)' }
  const caFile = path.join(dir, 'ca', 'asight-ca.pem')
  if (!f.existsSync(caFile)) return { error: `the collector CA (${caFile}) is not there; run asight on first` }
  let fp256 = null
  try { fp256 = new crypto.X509Certificate(f.readFileSync(caFile, 'utf8')).fingerprint256 } catch (e) {
    return { error: `the collector CA could not be read as a certificate: ${String((e && e.message) || e)}` }
  }
  const keychain = loginKeychainOf(home)
  if (!f.existsSync(keychain)) return { error: `the login keychain (${keychain}) is not there` }
  return { parts: [{
    kind: 'optin-keychain-cert',
    entry: ledgerEntry({ kind: 'optin-keychain-cert', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: `login-keychain:${fp256}`,
      values: { keychain, fp256, certFile: caFile } }),
    do: () => {
      // the user-domain form: add-trusted-cert -k <login keychain> <CA>, NEVER `-r trustRoot` (1.6's forbidden row — the old MITM's form)
      const s = execTool('security', ['add-trusted-cert', '-k', keychain, caFile], { run: deps.run, env, timeoutMs: DIALOG_MS })
      if (s.code !== 0) return { ok: false, reason: `the macOS authorization dialog for the certificate was declined, or the import failed (exit ${s.code ?? 'none'}${s.err ? `: ${s.err.slice(0, 200)}` : ''}); this is your own no, not a step waiting for an administrator` }
      const back = execTool('security', ['find-certificate', '-a', '-p', keychain], { run: deps.run, env })
      if (back.code !== 0) return { ok: false, reason: 'the import ran, but the read-back could not read the login keychain' }
      if (!certBlocks(back.out).some((c) => c.fp === fp256)) return { ok: false, reason: 'the import ran, but the read-back did not find the certificate in the login keychain' }
      return { ok: true }
    },
  }], summary: `the collector CA trusted in the login keychain (${fp256.slice(0, 23)}…), found back by its SHA-256 fingerprint` }
}

/** Everything the desktop-launcher item needs, read BEFORE anything is written — the win32 twin's valuesOf shape: `{ parts }` (the ledger
 *  entry + its `do()`), `{ error }`, or `{ refuse: { reason } }` (the world says no: Claude Desktop is not installed — nothing to start).
 *  The launcher is the proxy door §6.4 measured (env is dead to Desktop's Chromium network service): a shell stub exec'ing the real bundle
 *  binary with Chromium's --proxy-server at the group's listener. The URL is deliberately WITHOUT credentials (proxyUrl's auth:false form —
 *  Chromium ignores embedded credentials anyway, so a credentialed group would be a door to nowhere: that mis-declaration is an `error`
 *  here, not a launcher that silently steers nothing). `deps.ingress` injects the ingress read as ever. */
function desktopLauncherValues(a) {
  const { row, groups, dir = null, home, fs: f = nodeFs, deps = {} } = a
  if (!dir) return { error: 'no collector directory is wired in (the desktop-launcher item cannot be built)' }
  const g = groupOf(groups, row.form)
  if (!g) return { error: `the form ${row.form} is not in this on's groups` }
  if (g.group.auth !== false) return { error: `the group ${g.g} takes credentials at its listener, but Chromium ignores credentials embedded in --proxy-server: the launcher door is only for a group whose listener carries none (4.9 §6.4)` }
  const desktopBins = deps.desktopBins || DESKTOP_BINS // the world's list, injectable like everything else (a test's sandbox HOME cannot unmake a real /Applications)
  const appBinary = desktopBins(home).find((p) => f.existsSync(p)) || null
  if (!appBinary) return { refuse: { reason: `Claude Desktop is not installed (neither /Applications/Claude.app nor ~/Applications/Claude.app holds the bundle binary), so asight writes no launcher — there is nothing for it to start` } }
  const ku = kernelUrlOf({ group: g, ingress: ingressOf({ dir, deps, fs: f }), what: 'the Claude Desktop launcher' })
  if (ku.error) return { error: ku.error }
  const binDir = path.join(dir, 'bin')
  const launcher = path.join(binDir, LAUNCHER_NAME)
  const stub = renderShTemplate('claude-desktop.sh.tmpl', { proxy: ku.url, proxyBypass: PROXY_BYPASS, realBinary: appBinary })
  return { parts: [{
    kind: 'optin-desktop-launcher',
    entry: ledgerEntry({ kind: 'optin-desktop-launcher', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: launcher,
      values: { launcher, appBinary, proxy: ku.url, bypass: PROXY_BYPASS } }),
    do: () => {
      f.mkdirSync(binDir, { recursive: true })
      f.writeFileSync(launcher, stub, { mode: 0o755 })
      // the read-back: the file on disk holds the switch, the bypass list and the app binary as written, and it is executable
      const back = f.readFileSync(launcher, 'utf8')
      if (!back.includes(`--proxy-server='${ku.url}'`) || !back.includes(`--proxy-bypass-list='${PROXY_BYPASS}'`) || !back.includes(`'${appBinary}'`)) return { ok: false, reason: 'the launcher was written, but the read-back does not hold the switch, the bypass list and the app binary as written' }
      if (!(f.statSync(launcher).mode & 0o111)) return { ok: false, reason: 'the launcher file is not executable' }
      return { ok: true }
    },
  }], summary: `${LAUNCHER_NAME} in ${binDir}, starting ${appBinary} with Chromium's --proxy-server at ${ku.url} (an address with no password: you named the item, the listener binds loopback only, and the engine still judges every process; the launcher steers ONLY Desktop instances started through it — a Desktop that is already running is untouched)` }
}

/** The user half's driver — the win32 twin's applyUserOne, same logic: refuse / error → nothing written; the part is ledgered BEFORE its
 *  write and confirmed only by the read-back; a part that fails leaves its entry in (what it did write stays undoable) and is failed. */
async function applyUserOne(args, valuesOf) {
  const { row, manifest, save = () => {}, note = () => {}, failure = () => {}, state = () => {} } = args
  const prep = valuesOf(args)
  if (prep.refuse) {
    note({ kind: 'optin-user', form: row.form, item: row.item, outcome: 'refused', reason: prep.refuse.reason })
    failure({ code: 'optin-failed', form: row.form, item: row.item, scope: 'user', reason: prep.refuse.reason })
    return { state: 'failed', reason: prep.refuse.reason }
  }
  if (prep.error) {
    failure({ code: 'optin-failed', form: row.form, item: row.item, scope: 'user', reason: prep.error })
    return { state: 'failed', reason: prep.error }
  }
  for (const part of prep.parts) {
    manifest.entries.push(part.entry)
    save() // the entry is in before anything runs: a crash past this point is undoable, not a mystery
    const r = await part.do()
    part.entry.confirmed = !!(r && r.ok)
    if (r && r.ok && r.rcs) part.entry.values.rcs = r.rcs // what was actually written (the already-lined files among them)
    save()
    if (!r || !r.ok) {
      note({ kind: 'optin-user', form: row.form, item: row.item, outcome: 'failed', reason: r ? r.reason : 'no result' })
      failure({ code: 'optin-failed', form: row.form, item: row.item, scope: 'user', reason: r ? r.reason : 'no result' })
      return { state: 'failed', reason: r ? r.reason : 'no result' }
    }
    state({ event: 'optin-applied', where: 'optin', form: row.form, item: row.item, scope: 'user' })
  }
  note({ kind: 'optin-user', form: row.form, item: row.item, outcome: 'ok', reason: `the item was done and read back (${prep.summary})` })
  return { state: 'done' }
}
