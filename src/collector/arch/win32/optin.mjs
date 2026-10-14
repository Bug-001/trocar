// optin.mjs — the opt-in items of 4.8 §2.4 (D43⑥, 1.6 §1.7): the changes whose reach goes beyond the agent itself are never the default. `on`'s plan
// lists what each form would need and what it implies; the user names the form (`asight on <harness> --opt-in <form>`); asight performs it, ledgers
// it (with `scope`), backs the prior state up first, and `off` / the standalone undo take it out again. This file is the item catalog and the two
// read halves (the plan and the check of what is still in effect); the doing lives here too (`applyOptIn`), one fixed PowerShell script per item
// kind (optin/*.ps1 — apply only: the undo is inline JavaScript in src/off/win32-optin.mjs, so it runs when the source tree is gone; the read-only
// helper does none of these writes, W1). Machine-level items never run a script of their own: they are ONE self-contained elevated command
// (elevate.mjs; the OS's own prompt — UAC — never a password of asight's, 1.6 §1.7, V63). Pure data and injected-exec functions: no socket, no
// process, no registry of its own; a test runs everything against a sandbox HOME and a recording runner.
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execTool } from '../../../off/exec.mjs'
import { writeBackup } from '../../../off/backup.mjs'
import { setKey, getPath } from '../../../off/json-text.mjs'
import { proxyUrl } from './forms.mjs'
import { splitCommandLine } from './procinfo.mjs'
import { whoseWithHosts } from '../../core/host-agent.mjs'
import { renderCmdTemplate, markerScript } from './shims.mjs'
import { readIngressConfig } from './ingress-config.mjs'
import { readUserPath, prependUserPath, resolveCommand, sacOf, sacBlocksShims, readShortcutTarget, shortcutPlaces } from './userpath.mjs'
import { readMachinePath, MACHINE_BIN } from './elevate.mjs'

const nodeFs = fs
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Where the fixed scripts live (arch/win32/optin/*.ps1); `applyOptIn` names them by file, never by a path a caller gives. */
export const SCRIPTS_DIR = path.join(HERE, 'optin')

/** Every item 4.8 §2.4's table names, with the manifest kinds it is ledgered as (one item can be more than one kind: Claude Desktop's item is the
 *  certificate AND the policy value). `script` is the fixed PowerShell file that applies it (machine-level items have none: they are one
 *  self-contained elevated command); `when` names the fact that must hold before the item is even offered. Frozen data: adding a kind means a
 *  manifest/OFF_VERSION bump and an undo in src/off/win32-optin.mjs. */
export const OPTIN_ITEMS = Object.freeze({
  'user-path-shim': { scope: 'user', parts: [{ kind: 'optin-user-path', script: 'user-path.ps1' }] },
  'machine-path-dispatcher': { scope: 'machine', when: 'real-binary-on-machine-path', parts: [{ kind: 'optin-machine-path' }] },
  'start-menu-launcher': { scope: 'user', parts: [{ kind: 'optin-shortcut', script: 'shortcut.ps1' }] },
  'all-users-launcher': { scope: 'machine', when: 'all-users-shortcuts', parts: [{ kind: 'optin-machine-shortcut' }] },
  'cert-store-current-user': { scope: 'user', parts: [{ kind: 'optin-cert-user', script: 'cert-user.ps1' }, { kind: 'optin-claude-policy', script: 'claude-policy.ps1' }] },
  'vscode-settings-and-launcher': { scope: 'user', parts: [{ kind: 'optin-vscode', script: 'vscode.ps1' }] },
  'zcode-app-settings': { scope: 'user', parts: [{ kind: 'optin-zcode', script: 'zcode-desktop.ps1' }] },
})
/** The machine-level manifest kinds (their undo is not inline: `off` gives back `{ needsAdmin: true, command }`, the one confirmation and the OS's
 *  own prompt carry it, 4.8 §2.4「机器级」). */
export const OPTIN_MACHINE_KINDS = Object.freeze(['optin-machine-path', 'optin-machine-shortcut', 'optin-cert-machine'])

/** The 「点名也不做」category (1.6 §1.7): what a harness may DECLARE its form would additionally need, so the plan says WHY asight never does it
 *  instead of silently offering less. Never an item to run, never a write, never in `--opt-in`'s nameable forms; naming the form anyway is a usage
 *  error. The one entry today: a proxy variable in the login environment (D43: writing it there directly is not acceptable). */
export const OPTIN_NEVER = Object.freeze({
  'login-env-proxy': 'asight never writes HTTPS_PROXY (or any proxy variable) into the login environment - HKCU\\Environment, $PROFILE, environment.d - because a proxy for your whole login session reaches beyond the agent; the connections this form sends outside its own entries are not captured (1.6 §1.7「点名也不做」)',
})

/** → the item ids of 4.8 §2.4's table, in the order of the spec's table (the plan's 「要你点名的」 section keeps this order). */
export const optinItemIds = () => Object.keys(OPTIN_ITEMS)

/** Whether `kind` is one of this module's (the manifest's KNOWN_KINDS is the wider truth: it also holds the non-opt-in kinds). */
export const isOptinKind = (kind) => Object.values(OPTIN_ITEMS).some((x) => x.parts.some((p) => p.kind === kind)) || OPTIN_MACHINE_KINDS.includes(kind)

/** The opt-in rows of `groups` (route-plan's `groupsOf` shape): one row per (form, item), carrying what the plan prints and what `--opt-in` names.
 *   groups   groupsOf(descriptors) — the items live on the group; every form of the group shares them (a form's items all go together, 1.6 §1.7)
 *   optIns   the form ids the user named on this `on` (`--opt-in`, repeatable and comma-separated)
 *   manifest the install manifest as it is now (null: none) — an item with a ledger entry is `done` (or `pending-admin`), never re-offered as needed
 *   resolve  (name) → 'machine' | 'user' | null — where `where.exe`-order lookup resolves a command today (userpath.mjs's resolveCommand); it decides
 *            a machine item's `when` (the real binary on the machine PATH is the only reason to offer the dispatcher item, §6.3)
 * → [{ form, harness, item, kinds, scope, admin, impact, when?, command, chosen, applicable, state, pending_admin? }]
 *    `command` is the whole line the plan and `status` print (`asight on <harness> --opt-in <form>`); `state` is what `status --json`'s opt_in says:
 *    'needed' (no ledger entry) · 'done' · 'pending-admin' (a machine item waiting for the user's administrator rights). */
export function planOptIns({ groups = [], optIns = [], manifest = null, resolve = null } = {}) {
  const named = new Set(optIns)
  const rows = []
  for (const x of groups) {
    const items = (x.group && Array.isArray(x.group.optIn)) ? x.group.optIn : []
    for (const it of items) {
      const def = OPTIN_ITEMS[it.item]
      if (!def && !OPTIN_NEVER[it.item]) throw new TypeError(`unknown opt-in item ${JSON.stringify(it.item)} on group ${x.g} (4.8 §2.4 has no such item)`)
      const entries = optinEntriesOf(manifest, x.harness, x.g)
      for (const f of x.forms) {
        if (OPTIN_NEVER[it.item]) { // a declaration, not an offer: the plan explains, nothing is ever run (1.6 §1.7「点名也不做」)
          rows.push({ form: f.id, harness: x.harness, item: it.item, kinds: [], scope: 'never', admin: false, impact: it.impact,
            note: OPTIN_NEVER[it.item], ...(it.when ? { when: it.when } : {}), command: null, chosen: named.has(f.id), applicable: false, state: 'never' })
          continue
        }
        const applicable = !def.when || (typeof resolve === 'function' ? applicableWhen(def.when, x, resolve) : true)
        // the ledger is by form and item: one row per form even when two forms share a group (they share the items too)
        const mine = entries.filter((e) => e.form === f.id && e.item === it.item)
        const state = mine.some((e) => e.pending_admin) ? 'pending-admin' : mine.length ? 'done' : 'needed'
        rows.push({
          form: f.id, harness: x.harness, item: it.item, kinds: def.parts.map((p) => p.kind), scope: def.scope, admin: def.scope === 'machine',
          impact: it.impact, ...(it.when ? { when: it.when } : {}), ...(def.when ? { when: def.when } : {}),
          command: `asight on ${x.harness} --opt-in ${f.id}`, chosen: named.has(f.id), applicable, state,
        })
      }
    }
  }
  return rows
}

/** The manifest's opt-in entries of one harness (entries the opt-in apply wrote: kind optin-*, form recorded). */
const optinEntriesOf = (manifest, harness) => (manifest && Array.isArray(manifest.entries) ? manifest.entries.filter((e) => e && isOptinKind(e.kind) && e.harness === harness) : [])

/** The `when` facts (§2.4's table has one: the real binary resolving on the machine PATH is the only reason to offer the dispatcher item — the
 *  user-PATH shim loses to it, §6.3「机器 PATH 在前」). `resolve` is injected (a test fakes it; the daemon binds userpath.mjs's resolveCommand). */
const applicableWhen = (when, group, resolve) => {
  if (when !== 'real-binary-on-machine-path') return true
  const command = commandOf(group)
  return command ? resolve(command) === 'machine' : false
}

/** The command name a group's shim entry stands for (`proxyEntry.command`, the shim's file stem); groups without a shim entry have no dispatcher item. */
const commandOf = (x) => (x.group && x.group.proxyEntry && x.group.proxyEntry.kind === 'shim' && x.group.proxyEntry.command) || null

/** → every form id that has opt-in items in `groups` (the `--opt-in` usage error lists them; naming anything else is a usage error, not a skip). A
 *  form whose only items are of the 「点名也不做」category is NOT nameable: there is nothing asight would do with the name. */
export const optinFormsOf = (groups) => [...new Set(planOptIns({ groups }).filter((r) => r.state !== 'never').map((r) => r.form))]

/** → [{ item, forms }] — the ITEM ids the plan's「要你点名的」section prints, each with every form that carries it. The CLI expands an item id
 *  named on `--opt-in` back to its form (1.6 §1.7: what the plan shows is what the user copies); one carrier expands, several are the user's to
 *  choose between (cli/on.mjs's rule). The rows are the same planOptIns truth as optinFormsOf's. */
export const optinItemForms = (groups) => {
  const byItem = new Map()
  for (const r of planOptIns({ groups })) {
    if (r.state === 'never') continue
    if (!byItem.has(r.item)) byItem.set(r.item, new Set())
    byItem.get(r.item).add(r.form)
  }
  return [...byItem.entries()].map(([item, forms]) => ({ item, forms: [...forms] }))
}

// ── the doing of a named item ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// applyOptIn({ row, manifest, dir, home, env, fs, now, save, note, failure, state, deps }) → { state: 'done' | 'pending-admin' | 'needs-admin' | 'failed', reason?,
// elevated_command? }. Everything it touches is injected: the runner of OS tools (`deps.run`, execTool's), the UAC launcher (`deps.launch`), whether a
// prompt can be shown (`deps.canPrompt`), the readers of the PATH (`deps.readMachinePath`, `deps.resolveCommand`) and the user-level script runner
// (`deps.exec`, commit B). The ledger entries it pushes through `manifest.entries` + `save()` carry `scope`, the prior state (`prior_value` / `backup`
// / `pre_sha256`) and `undo_by_hand`; a machine-level item is ledgered `pending_admin` FIRST and only cleared by the read-back after the OS's own
// prompt was consented to (4.8 §2.4: 先入账 pending-admin;核对到了才记成已做). `state(rec)` writes the §12 state events (optin-applied), `note(rec)`
// an install-note of this run, `failure(rec)` a failure record.

const ledgerEntry = ({ kind, harness, form, item, scope, path, ...rest }) => ({ kind, harness, form, item, scope, path: path ?? `${form}:${item}`, undo_by_hand: `${form} 的点名项(${kind}):撤销是 asight off ${harness}`, installed_at: new Date().toISOString(), ...rest })

/** The machine half: ONE self-contained elevated step (elevate.mjs; the OS's own prompt, never a password of asight's). Outcomes with their codes
 *  (each is recorded: the note carries the attempt, the ledger entry the state): ok + read-back → done; the consent box declined, or the step ran
 *  but the read-back did not confirm → pending-admin (NOT optin-failed); no prompt can be shown → needs-admin with the command (the fallback); a
 *  command that could not be built (the machine PATH unreadable) → failed, nothing attempted. */
async function applyMachineOne({ row, values, manifest, save, note, failure, state, deps }) {
  const { elevatedCommand, runElevated, MACHINE_BIN } = await import('./elevate.mjs')
  const entry = ledgerEntry({ kind: row.kinds[0], harness: row.harness, form: row.form, item: row.item, scope: 'machine', values, pending_admin: true })
  manifest.entries.push(entry)
  let command = null
  try { command = elevatedCommand({ item: row.item, op: 'apply', values }).command } catch (e) {
    entry.undo_by_hand += `;(这一步没做成:${String((e && e.message) || e)})`
    save()
    note({ kind: 'optin-elevated', form: row.form, item: row.item, outcome: 'not-built', reason: `the elevated step could not be built: ${String((e && e.message) || e)}` })
    failure({ code: 'optin-failed', form: row.form, item: row.item, scope: 'machine', reason: `the elevated step could not be built: ${String((e && e.message) || e)}` })
    return { state: 'failed', reason: String((e && e.message) || e) }
  }
  save()
  const ask = runElevated({ command, launch: deps.launch, canPrompt: deps.canPrompt })
  if (ask.noPrompt) {
    note({ kind: 'optin-elevated', form: row.form, item: row.item, outcome: 'no-prompt', reason: ask.reason })
    return { state: 'needs-admin', reason: ask.reason, elevated_command: command }
  }
  if (ask.refused) {
    note({ kind: 'optin-elevated', form: row.form, item: row.item, outcome: ask.outcome, reason: ask.reason })
    return { state: 'pending-admin', reason: ask.reason }
  }
  // the step ran with the user's consent: confirm it read-only before calling it done (a step nobody confirmed is not done)
  const confirmed = deps.machineCheck ? await deps.machineCheck({ item: row.item, values }) : true
  if (!confirmed) {
    note({ kind: 'optin-elevated', form: row.form, item: row.item, outcome: 'unconfirmed', reason: 'the elevated step ran, but the read-back did not confirm the change' })
    return { state: 'pending-admin', reason: 'the elevated step ran, but the read-back did not confirm the change' }
  }
  entry.pending_admin = false
  save()
  note({ kind: 'optin-elevated', form: row.form, item: row.item, outcome: 'ok', reason: `the machine-level item was done through the OS's own prompt (${MACHINE_BIN})` })
  state({ event: 'optin-applied', where: 'optin', form: row.form, item: row.item, scope: 'machine' })
  return { state: 'done' }
}

/** One named item (turnOn calls this per chosen row, inside the op lock, after the install's own writes). The machine half is one self-contained
 *  elevated step; the user half runs each part's fixed .ps1 through execTool and reads it back (below). */
export async function applyOptIn(args) {
  const { row } = args
  const def = OPTIN_ITEMS[row.item]
  if (!def && OPTIN_NEVER[row.item]) { // a 「点名也不做」 item: never a write, even if a future wiring hands it in — and loud, not silent (D38)
    const reason = OPTIN_NEVER[row.item]
    ;(args.failure || (() => {}))({ code: 'optin-failed', form: row.form, item: row.item, scope: 'user', reason })
    return { state: 'failed', reason }
  }
  if (!def) return { state: 'failed', reason: `unknown opt-in item ${row.item}` }
  if (def.scope === 'machine') {
    const values = await machineValuesOf(args)
    if (values.error) { (args.failure || (() => {}))({ code: 'optin-failed', form: row.form, item: row.item, scope: 'machine', reason: values.error }); return { state: 'failed', reason: values.error } }
    return applyMachineOne({ ...args, values })
  }
  return applyUserOne(args)
}

// ── the user-level half: each part's fixed .ps1 through execTool, then a read-back (4.8 §2.4「执行」, W64) ─────────────────────────────────────────────────────────────────────

/** The one PowerShell invocation of a fixed script: -File, the script by name (never a path a caller gives), then its parameters. The same
 *  invocation the helper uses (helper.mjs's `args`), so the lab measures one shape. */
export const scriptArgs = (script, params) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS_DIR, script), ...params]
const runScript = (script, params, { run = null, env = process.env } = {}) => execTool('powershell', scriptArgs(script, params), { run, env })

/** One HKCU value read through reg.exe (read-only; the apply has no helper). → `{ value }` · `{ absent: true }` · `{ error }`. */
const readRegValue = ({ hive, key, name, run = null, env = process.env }) => {
  const r = execTool('reg', ['query', `${hive}\\${key}`, '/v', name], { run, env })
  if (r.code === 1) return { absent: true }
  if (r.code !== 0) return { error: `reg query of ${hive}\\${key}\\${name} failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  const m = new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)$`, 'im').exec(r.out)
  return m ? { value: m[1].trim() } : { error: `reg query answered, but not with ${name}` }
}

const groupOf = (groups, form) => (groups || []).find((x) => x.forms && x.forms.some((f) => f.id === form)) || null
const ingressOf = ({ dir, deps = {}, fs = nodeFs }) => deps.ingress || readIngressConfig({ dir, fs })
const kernelUrlOf = ({ group, ingress, what }) => {
  if (!ingress || ingress.missing || ingress.error) return { error: `the ingress config could not be read (${ingress && (ingress.missing ? 'there is none yet' : ingress.error)}), so ${what} has no kernel port to point at; run asight on first` }
  const port = ingress.groupPorts && ingress.groupPorts[group.g]
  if (!port) return { error: `the ingress config has no kernel port for the group ${group.g}` }
  return { url: proxyUrl(group.group, { port, listenerToken: ingress.listenerToken }) }
}

/** The CA file a kimi-facing shim or launcher names (§6.3「取法同 4.6 的 extra-kimi.pem 规则」): the extra-kimi.pem the trust machinery builds when
 *  the user already gives Kimi a CA, else the collector's own CA — NODE_EXTRA_CA_CERTS is additive, so the collector CA alone carries the trust. */
const kimiCaFile = (caDir, fs = nodeFs) => {
  const extra = path.win32.join(caDir, 'extra-kimi.pem')
  return fs.existsSync(extra) ? extra : path.win32.join(caDir, 'asight-ca.pem')
}

/** Everything a user-level item needs, read BEFORE anything is written (a refusal here writes nothing at all): each item returns `{ parts }` —
 *  one part per manifest kind, each with its ledger entry (already carrying scope, the prior and the backup) and its `do()` (the script, then the
 *  read-back) — or `{ error }` (asight's own read failed; zero writes) or `{ refuse: { code, reason } }` (the world says no: Smart App Control,
 *  Kimi not the native install; zero writes, and NOT optin-failed's shame — but the plan's state set has no kinder word, so it is `failed` with
 *  the code in the reason). */
async function userValuesOf(a) {
  const { row, groups, deps = {}, dir = null, home = os.homedir(), env = process.env, fs = nodeFs, now = () => new Date() } = a
  const run = deps.run || null
  const ctx = deps.ctx || { env: new Map(Object.entries(env)), home }
  const collectorDir = dir || path.win32.join(home, '.asight', 'collector')
  const dirs = { collector: collectorDir, bin: path.win32.join(collectorDir, 'bin'), launchers: path.win32.join(collectorDir, 'launchers'), ca: path.win32.join(collectorDir, 'ca') }
  const g = groupOf(groups, row.form)
  if (!g) return { error: `the form ${row.form} is not in this on's groups` }
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
  const ingress = ingressOf({ dir: collectorDir, deps, fs })
  const exists = (p) => fs.existsSync(p)

  // the PATH item: one shim of asight's own bin directory, the directory first on the user PATH (§6.3). The registry half is userpath.mjs's
  // prependUserPath (reg add through execTool, the type kept, never setx, ONE WM_SETTINGCHANGE), so both halves answer to the same tests.
  if (row.item === 'user-path-shim') {
    const pe = g.group.proxyEntry
    const command = pe && pe.kind === 'shim' ? pe.command : null
    if (!command) return { error: `the form ${row.form} has no shim command, so there is no shim to install` }
    const ku = kernelUrlOf({ group: g, ingress, what: `the ${command} shim` })
    if (ku.error) return { error: ku.error }
    const sac = deps.sac ? deps.sac() : sacOf({ run, env })
    if (sacBlocksShims(sac)) return { refuse: { code: 'smart-app-control', reason: 'Smart App Control is on, so asight installs no shim: a blocked shim at the front of your PATH would stop the command from starting (fail-closed, 4.8 §6.3)' } }
    if (command === 'kimi' && !exists(path.win32.join(home, '.kimi-code', 'bin', 'kimi.exe'))) return { refuse: { reason: 'Kimi Code is not the native install (%USERPROFILE%\\.kimi-code\\bin\\kimi.exe is not there), so asight installs no kimi shim (4.8 §6.3)' } }
    const real = deps.resolveCommand ? deps.resolveCommand(command) : resolveCommand(command, { run, env, exists, skip: [dirs.bin] })
    if (!real || !real.path) return { error: `the real binary of ${command} did not resolve on the PATH (Windows reads the machine PATH first, then the user PATH), so there is nothing for a shim to forward to` }
    // kimi's trust is env-only (NODE_EXTRA_CA_CERTS) and a Windows process's environment is never readable from
    // outside (4.8 §10.1) — so the shim also gets the per-pid launch marker's writer (4.6 「标记」, the darwin shim's
    // door) and the marker dir the tracker reads (daemon.mjs's collectorPaths.markers spelling: <collector>\run\trust)
    const markerDir = command === 'kimi' ? path.win32.join(collectorDir, 'run', 'trust') : null
    const shim = renderCmdTemplate(command === 'kimi' ? 'kimi.cmd.tmpl' : 'opencode.cmd.tmpl', { proxy: ku.url, ...(command === 'kimi' ? { caFile: kimiCaFile(dirs.ca, fs), markerDir } : {}), realBinary: real.path })
    const markerName = command === 'kimi' ? 'kimi-marker.ps1' : null
    const prior = readUserPath({ run, env })
    if (prior.error) return { error: `the user PATH could not be read, so nothing was written: ${prior.error}` }
    const shimPath = path.win32.join(dirs.bin, `${command}.cmd`)
    return { parts: [{
      kind: 'optin-user-path',
      entry: ledgerEntry({ kind: 'optin-user-path', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: shimPath,
        values: { command, binDir: dirs.bin, realBinary: real.path, ...(markerName ? { markerScript: path.win32.join(dirs.bin, markerName) } : {}) }, prior_value: prior.absent ? null : { kind: prior.kind, value: prior.value } }),
      do: async () => {
        const s = runScript('user-path.ps1', ['-BinDir', dirs.bin, '-Command', command, '-ShimB64', b64(shim), ...(markerName ? ['-MarkerName', markerName, '-MarkerB64', b64(markerScript())] : [])], { run, env })
        if (s.code !== 0) return { ok: false, reason: `user-path.ps1 failed (exit ${s.code ?? 'none'}${s.err ? `: ${s.err.slice(0, 200)}` : ''})` }
        const p = prependUserPath({ dir: dirs.bin, run, env })
        if (!p.ok) return { ok: false, reason: `the shim was written, but the user PATH half failed: ${p.reason}` }
        const back = readUserPath({ run, env })
        if (!exists(shimPath) || back.error || back.absent || !isFirst(dirs.bin, back.value)) return { ok: false, reason: 'the script ran, but the read-back did not confirm (the shim file, or the PATH holding the directory first)' }
        return { ok: true }
      },
    }], summary: `${command}.cmd in ${dirs.bin}, the directory first on the user PATH${markerName ? `, and ${markerName} beside it (the launch marker's writer)` : ''}` }
  }

  // the Start-menu / desktop shortcuts: asight's launcher, each shortcut repointed at it (§2.4 opencode.desktop). The launcher carries this
  // form's proxy; the shortcut's own target today is the real binary the launcher forwards to.
  if (row.item === 'start-menu-launcher') {
    const pe = g.group.proxyEntry
    if (!pe || pe.kind !== 'launcher' || !pe.shortcut) return { error: `the form ${row.form} has no shortcut entry` }
    const ku = kernelUrlOf({ group: g, ingress, what: 'the launcher' })
    if (ku.error) return { error: ku.error }
    const places = shortcutPlaces({ name: pe.shortcut, home, env })
    const existing = places.filter(exists)
    if (!existing.length) return { error: `no ${pe.shortcut} found in your Start menu or on your desktop, so there is nothing to repoint` }
    const target = readShortcutTarget({ shortcut: existing[0], run, env })
    if (target.error || !target.target) return { error: `the shortcut ${existing[0]} could not be read: ${target.error || 'its target is empty'}` }
    const launcher = path.win32.join(dirs.launchers, `asight-${g.g.split('.')[0]}.cmd`)
    const text = renderCmdTemplate('opencode-launcher.cmd.tmpl', { proxy: ku.url, realBinary: target.target })
    const shortcuts = existing.map((p) => ({ path: p, backup: writeBackup({ home, file: p, data: fs.readFileSync(p), now: now(), fs }) })) // R2: before the change
    return { parts: [{
      kind: 'optin-shortcut',
      entry: ledgerEntry({ kind: 'optin-shortcut', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: launcher,
        values: { launcher, realBinary: target.target, shortcuts }, backup: shortcuts.map((s) => s.backup) }),
      do: async () => {
        const s = runScript('shortcut.ps1', ['-Launcher', launcher, '-LauncherB64', b64(text), '-Shortcut', ...existing], { run, env })
        if (s.code !== 0) return { ok: false, reason: `shortcut.ps1 failed (exit ${s.code ?? 'none'}${s.err ? `: ${s.err.slice(0, 200)}` : ''})` }
        for (const p of existing) {
          const t = readShortcutTarget({ shortcut: p, run, env })
          if (t.error || t.target !== launcher) return { ok: false, reason: `the read-back of ${path.win32.basename(p)} did not confirm the launcher` }
        }
        if (!exists(launcher)) return { ok: false, reason: 'the launcher file is not there' }
        return { ok: true }
      },
    }], summary: `${existing.length} shortcut(s) repointed at ${launcher}` }
  }

  // Claude Desktop: the collector CA into CurrentUser\Root (Windows' own confirmation box; a refusal is the user's own no, §2.4) AND the one
  // HKCU policy value. Two parts, two kinds, one item — the policy only after the certificate said yes.
  if (row.item === 'cert-store-current-user') {
    const pe = g.group.proxyEntry
    if (!pe || pe.kind !== 'policy') return { error: `the form ${row.form} has no policy entry` }
    const ku = kernelUrlOf({ group: g, ingress, what: 'the policy value' })
    if (ku.error) return { error: ku.error }
    const caFile = deps.caFile || path.win32.join(dirs.ca, 'asight-ca.pem')
    if (!exists(caFile)) return { error: `the collector CA (${path.win32.join(dirs.ca, 'asight-ca.pem')}) is not there; run asight on first` }
    let thumbprint = null
    try { thumbprint = crypto.createHash('sha1').update(new crypto.X509Certificate(fs.readFileSync(caFile, 'utf8')).raw).digest('hex').toUpperCase() } catch (e) {
      return { error: `the collector CA could not be read as a certificate: ${String((e && e.message) || e)}` }
    }
    const prior = readRegValue({ hive: pe.hive, key: pe.key, name: pe.name, run, env })
    if (prior.error) return { error: prior.error }
    return { parts: [
      { kind: 'optin-cert-user',
        entry: ledgerEntry({ kind: 'optin-cert-user', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: `CurrentUser\\Root\\${thumbprint}`,
          values: { thumbprint, certFile: caFile } }),
        do: async () => {
          const s = runScript('cert-user.ps1', ['-CertFile', caFile], { run, env })
          if (s.code !== 0) return { ok: false, reason: `the Windows confirmation box for the certificate was declined, or the import failed (exit ${s.code ?? 'none'}${s.err ? `: ${s.err.slice(0, 200)}` : ''}); this is your own no, not a step waiting for an administrator` }
          const back = execTool('certutil', ['-user', '-store', 'Root', thumbprint], { run, env })
          if (back.code !== 0) return { ok: false, reason: 'the import ran, but the read-back did not find the certificate in CurrentUser\\Root' }
          return { ok: true }
        } },
      { kind: 'optin-claude-policy',
        entry: ledgerEntry({ kind: 'optin-claude-policy', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: `${pe.hive}\\${pe.key}\\${pe.name}`,
          values: { hive: pe.hive, key: pe.key, name: pe.name, url: ku.url }, prior_value: prior.absent ? null : prior.value }),
        do: async () => {
          const s = runScript('claude-policy.ps1', ['-Url', ku.url], { run, env })
          if (s.code !== 0) return { ok: false, reason: `claude-policy.ps1 failed (exit ${s.code ?? 'none'}${s.err ? `: ${s.err.slice(0, 200)}` : ''})` }
          const back = readRegValue({ hive: pe.hive, key: pe.key, name: pe.name, run, env })
          if (back.error || back.absent || back.value !== ku.url) return { ok: false, reason: 'the policy value was written, but the read-back did not confirm it' }
          return { ok: true }
        } },
    ], summary: `the collector CA in CurrentUser\\Root (thumbprint ${thumbprint.slice(0, 8)}…) and the policy value ${pe.name}` }
  }

  // VS Code: the user settings' two keys (http.proxy at this form's kernel listener, http.systemCertificates false — every extension stops
  // reading the system roots) and the editor's shortcuts through asight's launcher (which sets the CA file Node reads), §2.4 kimi-code.vscode.
  if (row.item === 'vscode-settings-and-launcher') {
    const pe = g.group.proxyEntry
    if (!pe || pe.kind !== 'app-setting' || typeof pe.file !== 'function') return { error: `the form ${row.form} has no app-settings entry` }
    const ku = kernelUrlOf({ group: g, ingress, what: 'the VS Code settings' })
    if (ku.error) return { error: ku.error }
    const file = pe.file(ctx)
    const existed = exists(file)
    const text0 = existed ? fs.readFileSync(file, 'utf8') : null
    const keyPaths = pe.keys.map((k) => [k]) // VS Code spells its setting ids as ONE flat key ('http.proxy'), never a nested object
    let text = text0, ops = [], prior = {}
    try {
      for (const keys of keyPaths) {
        const value = keys[0] === 'http.proxy' ? ku.url : keys[0] === 'http.systemCertificates' ? false : null
        if (value === null) return { error: `${file}: the vscode item knows the two keys of the data, nothing else (${keys.join('.')})` }
        const r = setKey(text, keys, value)
        text = r.text; ops = ops.concat(r.ops); prior[keys.join('.')] = r.prior
      }
    } catch (e) { return { error: `${file} could not be edited as JSON: ${String((e && e.message) || e)}` } }
    const caFile = kimiCaFile(dirs.ca, fs)
    const shortcutName = g.group.launcher && g.group.launcher.shortcut ? g.group.launcher.shortcut : null
    const shortcuts = []
    let realBinary = null
    if (shortcutName) {
      for (const p of shortcutPlaces({ name: shortcutName, home, env }).filter(exists)) {
        if (realBinary == null) { const t = readShortcutTarget({ shortcut: p, run, env }); if (!t.error && t.target) realBinary = t.target }
        shortcuts.push({ path: p, backup: writeBackup({ home, file: p, data: fs.readFileSync(p), now: now(), fs }) })
      }
    }
    if (realBinary == null) realBinary = deps.codeBinary || null
    if (!realBinary) return { error: `no VS Code shortcut found in your Start menu or on your desktop, so the launcher has no Code.exe to forward to` }
    const launcher = path.win32.join(dirs.launchers, 'asight-code.cmd')
    const launcherText = renderCmdTemplate('code-launcher.cmd.tmpl', { caFile, realBinary })
    const backup = existed ? writeBackup({ home, file, data: Buffer.from(text0, 'utf8'), now: now(), fs }) : null
    return { parts: [{
      kind: 'optin-vscode',
      entry: ledgerEntry({ kind: 'optin-vscode', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: file,
        values: { launcher, caFile, realBinary, keys: keyPaths, prior, shortcuts },
        ops, existed_before: existed, pre_sha256: existed ? sha256Of(text0) : null, post_sha256: null, ...(backup ? { backup } : {}) }),
      do: async () => {
        const s = runScript('vscode.ps1', ['-Settings', file, '-SettingsB64', b64(text), '-Launcher', launcher, '-LauncherB64', b64(launcherText), ...(shortcuts.length ? ['-Shortcut', ...shortcuts.map((x) => x.path)] : [])], { run, env })
        if (s.code !== 0) return { ok: false, reason: `vscode.ps1 failed (exit ${s.code ?? 'none'}${s.err ? `: ${s.err.slice(0, 200)}` : ''})` }
        for (const x of shortcuts) {
          const t = readShortcutTarget({ shortcut: x.path, run, env })
          if (t.error || t.target !== launcher) return { ok: false, reason: `the read-back of ${path.win32.basename(x.path)} did not confirm the launcher` }
        }
        if (!exists(file) || !exists(launcher)) return { ok: false, reason: 'the script ran, but the read-back did not find the settings file or the launcher' }
        return { ok: true, after: sha256Of(fs.readFileSync(file, 'utf8')) }
      },
    }], summary: `http.proxy and http.systemCertificates in ${file}, the editor's shortcuts through ${launcher}` }
  }

  // Z-Code Desktop: the two keys of its own settings file (httpProxy at this form's kernel listener, httpProxyCaCertPath at the combined
  // bundle — replacement semantics, so the bundle, never the asight-only CA), §2.4 z-code.desktop.
  if (row.item === 'zcode-app-settings') {
    const pe = g.group.proxyEntry
    if (!pe || pe.kind !== 'app-setting' || typeof pe.file !== 'function') return { error: `the form ${row.form} has no app-settings entry` }
    const ku = kernelUrlOf({ group: g, ingress, what: 'the Z-Code Desktop settings' })
    if (ku.error) return { error: ku.error }
    const bundle = path.win32.join(dirs.ca, 'combined-z-code.pem')
    if (!exists(bundle)) return { error: `the combined bundle ${path.win32.basename(bundle)} is not there (the z-code CLI form's trust entry builds it at on); run asight on z-code first, then name this item` }
    const file = pe.file(ctx)
    const existed = exists(file)
    const text0 = existed ? fs.readFileSync(file, 'utf8') : null
    let text = text0, ops = [], prior = {}
    const keyPaths = pe.keys.map((k) => [k]) // flat keys of the app's own file, the data's names as they are
    try {
      for (const keys of keyPaths) {
        const r = setKey(text, keys, keys[0] === 'httpProxy' ? ku.url : bundle)
        text = r.text; ops = ops.concat(r.ops); prior[keys.join('.')] = r.prior
      }
    } catch (e) { return { error: `${file} could not be edited as JSON: ${String((e && e.message) || e)}` } }
    const backup = existed ? writeBackup({ home, file, data: Buffer.from(text0, 'utf8'), now: now(), fs }) : null
    return { parts: [{
      kind: 'optin-zcode',
      entry: ledgerEntry({ kind: 'optin-zcode', harness: row.harness, form: row.form, item: row.item, scope: 'user', path: file,
        values: { keys: keyPaths, prior, bundle }, ops, existed_before: existed, pre_sha256: existed ? sha256Of(text0) : null, post_sha256: null, ...(backup ? { backup } : {}) }),
      do: async () => {
        const s = runScript('zcode-desktop.ps1', ['-File', file, '-ContentB64', b64(text)], { run, env })
        if (s.code !== 0) return { ok: false, reason: `zcode-desktop.ps1 failed (exit ${s.code ?? 'none'}${s.err ? `: ${s.err.slice(0, 200)}` : ''})` }
        if (!exists(file)) return { ok: false, reason: 'the script ran, but the settings file is not there' }
        return { ok: true, after: sha256Of(fs.readFileSync(file, 'utf8')) }
      },
    }], summary: `${pe.keys.join(' and ')} in ${file}` }
  }

  return { error: `the user item ${row.item} is not built yet (Task 14's later commits)` }
}

/** The user half's driver: refuse / error → nothing written; else each part is ledgered BEFORE its script runs (a crash between the write and
 *  the read-back leaves an undoable entry, exactly like the machine half's pending-admin first) and confirmed only by the read-back after it.
 *  A part that fails leaves its entry in (what it did write stays undoable) and the item is `optin-failed` — except that a declined Windows
 *  confirmation box (the certificate) is the user's own no, which is ALSO `failed` here, never `pending-admin`: nobody was asked for
 *  administrator rights (the plan's own words). */
async function applyUserOne(args) {
  const { row, manifest, save = () => {}, note = () => {}, failure = () => {}, state = () => {} } = args
  const prep = await userValuesOf(args)
  if (prep.refuse) {
    note({ kind: 'optin-user', form: row.form, item: row.item, outcome: 'refused', reason: prep.refuse.reason })
    failure({ code: 'optin-failed', form: row.form, item: row.item, scope: 'user', reason: prep.refuse.reason })
    return { state: 'failed', reason: prep.refuse.reason }
  }
  if (prep.error) {
    failure({ code: 'optin-failed', form: row.form, item: row.item, scope: 'user', reason: prep.error })
    return { state: 'failed', reason: prep.error }
  }
  const done = []
  for (const part of prep.parts) {
    manifest.entries.push(part.entry)
    save() // the entry is in before anything runs: a crash past this point is undoable, not a mystery
    const r = await part.do()
    if (r && r.ok && r.after != null) part.entry.post_sha256 = r.after
    part.entry.confirmed = !!(r && r.ok)
    save()
    if (!r || !r.ok) {
      note({ kind: 'optin-user', form: row.form, item: row.item, outcome: 'failed', reason: r ? r.reason : 'no result' })
      failure({ code: 'optin-failed', form: row.form, item: row.item, scope: 'user', reason: r ? r.reason : 'no result' })
      return { state: 'failed', reason: r ? r.reason : 'no result' }
    }
    state({ event: 'optin-applied', where: 'optin', form: row.form, item: row.item, scope: 'user' })
    done.push(part.entry)
  }
  note({ kind: 'optin-user', form: row.form, item: row.item, outcome: 'ok', reason: `the item was done through its fixed script and read back (${prep.summary})` })
  return { state: 'done' }
}

const sha256Of = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
/** Is `dir` the FIRST item of the PATH `value`? (What prependUserPath wrote is the directory, a semicolon, then the rest verbatim; the compare
 *  is case-blind because a registry value keeps whatever case it was given, and Windows does not care.) */
const isFirst = (dir, value) => {
  const v = String(value || '')
  return v.length >= dir.length && v.slice(0, dir.length).toLowerCase() === dir.toLowerCase() && (v.length === dir.length || v[dir.length] === ';')
}

/** What a machine item's step needs: the command name (the group's shim entry), the real binary's path (the resolver's answer) and the machine
 *  PATH as read now. Deps injected when a caller has them, else the real resolvers — the daemon's own apply path hands no deps, and the missing
 *  fallback read every real machine item `optin-failed` on a Windows test machine (as the plan side 30 lines up already defaulted this
 *  way, which is why the plan offered the item the apply then could not build). */
async function machineValuesOf({ row, groups = [], deps = {}, env = process.env }) {
  if (row.item === 'machine-path-dispatcher') {
    const g = groups.find((x) => x.forms.some((f) => f.id === row.form)) || null
    const command = g && g.group && g.group.proxyEntry && g.group.proxyEntry.kind === 'shim' ? g.group.proxyEntry.command : null
    if (!command) return { error: `the form ${row.form} has no shim command, so there is no dispatcher to build` }
    const real = typeof deps.resolveCommand === 'function' ? deps.resolveCommand(command) : resolveCommand(command, { env })
    if (!real || real.at !== 'machine' || !real.path) return { error: `the real binary of ${command} did not resolve on the machine PATH (the user-level shim item is the right one here)` }
    const machinePath = typeof deps.readMachinePath === 'function' ? deps.readMachinePath() : readMachinePath({ env })
    if (machinePath == null) return { error: 'the machine PATH could not be read, so the elevated step cannot be built (nothing was changed)' }
    return { command, realBinary: real.path, machinePath }
  }
  return { error: `the machine item ${row.item} is not built yet (Task 14's later commits)` }
}

// ── the check of what is still in effect (W68; 4.8 §2.4「入口还有没有效」, 1.6 §1.7) ────────────────────────────────────────────────────────────────────────────────────────
// The ledger says an item was done; the world says whether it still holds. `status` runs this every time it is asked (1.6 §1.7) and the daemon's
// 5 s check runs it through the wiring (below, recordEntryFindings): the command still resolving to asight's shim first, the shortcuts still at
// asight's launcher, the settings keys still what asight wrote, the agents still started through the entry. Everything read-only (D30: only the
// operator's `on` writes an agent's setting), everything injected (no tool runs for real on a dev machine).

/** The manifest kinds checkEntries has an arm for: exactly the kinds the apply can produce — every user part of OPTIN_ITEMS plus the machine kind
 *  machineValuesOf builds (`optin-machine-path`; `optin-machine-shortcut` and `optin-cert-machine` have no producer yet, so no entry of theirs can
 *  be in a manifest this build reads). test/collector/arch/win32/optin-check.test.mjs pins this list against both producers (the W54 loop-guard
 *  pattern): a kind gained on either side without a check arm is red. */
export const CHECK_KINDS = Object.freeze(['optin-user-path', 'optin-machine-path', 'optin-shortcut', 'optin-cert-user', 'optin-claude-policy', 'optin-vscode', 'optin-zcode'])

/**
 * checkEntries({ manifest, procs, identify, groups, deps }) → [{ form, item, harness, code, detail }] — the read-only re-check that asight's opt-in
 * entries are still the ones used. `manifest` the install manifest as it is; `procs` the process table
 * (`[{ pid, ppid, exe, cmdline? , argv? }]` — listProcs' own rows or the redirector's full table); `identify` the name list's judge (registry.match,
 * D51: which harness a process is; a process a form's `hosts.processes` names — the editor carrying the extension — is that form's harness, as at its door);
 * `groups` groupsOf(descriptors) (which forms each harness has); `deps: { run, env, fs }` the injections (every OS read goes through them). A ledger entry that is in effect (not
 * `pending_admin`, not a `confirmed: false` apply) is checked by its kind:
 *   optin-user-path / optin-machine-path  the command still resolves, in Windows' own order (the machine PATH first, §6.3), to asight's shim
 *                                         or dispatcher — anything else first is `shim-not-on-path`, the detail naming the PATH entry that wins;
 *                                         the dispatcher's recorded real binary still there (gone → `entry-changed`);
 *   optin-shortcut / optin-vscode         every shortcut still points at asight's launcher, the launcher itself still there (anything
 *                                         else → `entry-changed`);
 *   optin-vscode / optin-zcode            the settings file still holds what asight wrote in its keys (→ `entry-changed`);
 *   optin-claude-policy                   the policy value is still asight's URL (→ `entry-changed`);
 *   optin-cert-user                       the certificate is still in CurrentUser\Root (→ `entry-changed`).
 * Then, for each harness whose entries are all still in effect and EVERY form of which (in `groups`) has an entry things are started through (a
 * shim, the dispatcher, a launcher) — otherwise a process of it cannot be put in a form, and nothing is said (D25) —, a running agent of that harness (by the name list — it says the harness, never the form, so any of the harness's start entries
 * will do) whose parent is neither one of those (by image, or by the parent's command line naming it — a .cmd is interpreted by cmd.exe, so the
 * parent of a shim-launched agent is the cmd.exe whose command line carries the path; the shapes are the lab's W68 run to measure) nor a process
 * of the same harness (an agent's own children are not the entry's question) is `not-via-entry`, on the harness's first PATH entry (else launcher).
 * Nothing broken → nothing reported (W68). A read that failed is never a verdict: it comes back as an `unknown` finding (`code: null` with a
 * `reason` of 1.6 §9.4's closed set), not a guess (R11, D38).
 */
export function checkEntries({ manifest = null, procs = [], identify = null, groups = null, deps = {} } = {}) {
  const run = deps.run || null, env = deps.env || process.env, fs = deps.fs || nodeFs
  const expand = (p) => String(p).replace(/%([^%]+)%/g, (m, k) => (env[k] != null ? String(env[k]) : m))
  const exists = (p) => { try { return fs.existsSync(p) || fs.existsSync(expand(p)) } catch { return false } } // where.exe expands %Environment% names of a REG_EXPAND_SZ PATH; fs.existsSync does not
  const samePath = (a, b) => String(a).toLowerCase().replace(/\//g, '\\') === String(b).toLowerCase().replace(/\//g, '\\')
  const findings = []
  const add = (e, code, detail) => findings.push({ form: e.form, item: e.item, harness: e.harness, code, detail })
  const unknown = (e, reason, detail) => findings.push({ form: e.form, item: e.item, harness: e.harness, code: null, reason, detail })
  const entries = (manifest && Array.isArray(manifest.entries) ? manifest.entries : []).filter((e) => e && isOptinKind(e.kind) && !e.pending_admin && e.confirmed !== false)
  const v = (e) => (e && typeof e.values === 'object' && e.values) || {}

  // the PATH half — what `where.exe <command>` answers first must be one of asight's own entries for that command (read only when there is
  // one to check: `status` runs this on every ask, and a manifest without a PATH entry owes no registry read)
  const pathEntries = entries.filter((e) => e.kind === 'optin-user-path' || e.kind === 'optin-machine-path')
  const userPath = pathEntries.length ? readUserPath({ run, env }) : null
  const machinePath = pathEntries.length ? readMachinePath({ run, env }) : null
  const targetsOf = new Map() // command → asight's own first-hit paths (the shim, the dispatcher)
  for (const e of entries) {
    if (e.kind !== 'optin-user-path' && e.kind !== 'optin-machine-path') continue
    const t = e.kind === 'optin-user-path' ? path.win32.join(v(e).binDir || '', `${v(e).command}.cmd`) : `${MACHINE_BIN}\\${v(e).command}.cmd`
    if (!v(e).command) continue
    ;(targetsOf.get(v(e).command) || targetsOf.set(v(e).command, []).get(v(e).command)).push(t)
  }
  const checkPathOf = (e) => {
    if ((userPath && userPath.error) || machinePath == null) {
      unknown(e, 'denied', `${e.values.command}'s entry could not be checked: the ${userPath && userPath.error ? `user PATH could not be read (${userPath.error})` : 'machine PATH could not be read'}`)
      return
    }
    const mine = targetsOf.get(e.values.command) || []
    const hit = resolveCommand(e.values.command, { run, env, exists })
    if (hit && mine.some((t) => samePath(t, hit.path))) { /* the command still goes through one of asight's own entries */ }
    else if (hit) add(e, 'shim-not-on-path', `${e.values.command} resolves first to ${hit.path} — the ${hit.at} PATH's ${path.win32.dirname(hit.path)} — not asight's ${e.kind === 'optin-user-path' ? `shim ${mine[0]}` : `dispatcher ${mine[0]}`}`)
    else {
      const file = e.kind === 'optin-user-path' ? path.win32.join(e.values.binDir, `${e.values.command}.cmd`) : `${MACHINE_BIN}\\${e.values.command}.cmd`
      add(e, 'shim-not-on-path', `${e.values.command} no longer resolves anywhere on the PATH (${exists(file) ? `asight's ${e.kind === 'optin-user-path' ? 'shim' : 'dispatcher'} ${file} is there, but the directory is not on the PATH anymore` : `asight's ${e.kind === 'optin-user-path' ? 'shim' : 'dispatcher'} ${file} is gone`})`)
    }
    if (e.kind === 'optin-machine-path' && !exists(e.values.realBinary)) add(e, 'entry-changed', `the real binary the dispatcher falls back to (${e.values.realBinary}) is gone`)
  }

  // the shortcuts / launcher half (the shortcut item and the VS Code item's shortcut half): every shortcut still at asight's launcher, the
  // launcher itself still there. (The app a launcher forwards to is NOT existence-checked: the plan has that check for the machine dispatcher's
  // recorded binary alone, where nothing else would notice; a launcher's target is the user's own install, whose absence is not asight's entry
  // having changed.)
  const checkShortcutsOf = (e) => {
    for (const s of Array.isArray(v(e).shortcuts) ? v(e).shortcuts : []) {
      if (!exists(s.path)) { add(e, 'entry-changed', `the shortcut ${path.win32.basename(s.path)} is gone`); continue }
      const t = readShortcutTarget({ shortcut: s.path, run, env })
      if (t.error) { unknown(e, 'denied', `the shortcut ${s.path} could not be read: ${t.error}`); continue }
      if (!samePath(t.target || '', v(e).launcher)) add(e, 'entry-changed', `the shortcut ${path.win32.basename(s.path)} now starts ${t.target || '(nothing)'}, not asight's launcher ${v(e).launcher}`)
    }
    if (v(e).launcher && !exists(v(e).launcher)) add(e, 'entry-changed', `asight's launcher ${v(e).launcher} is gone`)
  }

  // the settings keys half (VS Code's and Z-Code Desktop's own files): what asight wrote must still be what they hold. The expected value
  // comes from the entry's own ops — the replace branch's `inserted` is the value's JSON literal; the insert branch's is the member text
  // `"key": <literal>` (json-text's member()), so the literal is lifted out of it. A user edit OUTSIDE asight's keys is not a change of the
  // entry (the undo side's own rule: only asight's keys are asight's to answer for).
  const opValue = (op) => {
    if (!op || typeof op.inserted !== 'string') return null
    if (op.removed !== '') return op.inserted
    const m = /^[\s\S]*?"(?:[^"\\]|\\.)*":\s*([\s\S]*?)\s*,?\s*$/.exec(op.inserted)
    return m ? m[1] : null
  }
  const checkSettingsOf = (e) => {
    if (!exists(e.path)) { add(e, 'entry-changed', `the settings file ${e.path} is gone`); return }
    let doc = null
    try { doc = JSON.parse(fs.readFileSync(e.path, 'utf8')) } catch { add(e, 'entry-changed', `${e.path} is no longer JSON, so the entry cannot be in effect`); return }
    const keys = (Array.isArray(v(e).keys) ? v(e).keys : []).map((k) => (Array.isArray(k) ? k : [k]))
    const ops = Array.isArray(e.ops) ? e.ops : []
    keys.forEach((k, i) => {
      const literal = opValue(ops[i])
      if (literal == null) return // an entry without a readable op for a key cannot be value-checked; the apply records one op per key
      let expected
      try { expected = JSON.parse(literal) } catch { return }
      const now = getPath(doc, k)
      if (now !== expected) add(e, 'entry-changed', `${k.join('.')} in ${e.path} now holds ${now === undefined ? 'nothing' : JSON.stringify(now)}, not what asight wrote (${JSON.stringify(expected)})`)
    })
  }

  for (const e of entries) {
    if (!CHECK_KINDS.includes(e.kind)) { // unreachable from a manifest this build reads (KNOWN_KINDS gates at read time); never silent anyway (D38)
      unknown(e, 'unparseable', `no check is built for the opt-in kind ${e.kind}`)
      continue
    }
    if (e.kind === 'optin-user-path' || e.kind === 'optin-machine-path') checkPathOf(e)
    else if (e.kind === 'optin-shortcut' || e.kind === 'optin-vscode') checkShortcutsOf(e)
    else if (e.kind === 'optin-claude-policy') {
      const now = readRegValue({ hive: e.values.hive, key: e.values.key, name: e.values.name, run, env })
      if (now.error) unknown(e, 'denied', `the policy value ${e.values.hive}\\${e.values.key}\\${e.values.name} could not be read: ${now.error}`)
      else if (now.absent || now.value !== e.values.url) add(e, 'entry-changed', `the policy value ${e.values.name} now holds ${now.absent ? 'nothing' : now.value}, not asight's ${e.values.url}`)
    } else if (e.kind === 'optin-cert-user') {
      const back = execTool('certutil', ['-user', '-store', 'Root', v(e).thumbprint], { run, env })
      if (back.code === 1) add(e, 'entry-changed', `the certificate ${v(e).thumbprint} is no longer in CurrentUser\\Root`)
      else if (back.code !== 0) unknown(e, 'denied', `CurrentUser\\Root could not be read (certutil exited ${back.code ?? 'none'}${back.err ? `: ${back.err.slice(0, 200)}` : ''})`)
    }
    if (e.kind === 'optin-vscode' || e.kind === 'optin-zcode') checkSettingsOf(e)
  }

  // the agents half: for each harness with an entry things are started through, a running agent of it must have been started through one
  const startTargetsOf = new Map() // harness → the paths a parent is identified by (raw and %expanded%: the ledger and PATH hold the raw, a shell's command line the expanded)
  const launchEntryOf = new Map() // harness → the entry to attribute a not-via-entry finding to (the first PATH entry, else the first launcher one)
  const noteStart = (e, t) => { if (!t) return; const l = startTargetsOf.get(e.harness) || startTargetsOf.set(e.harness, []).get(e.harness); l.push(t, expand(t)); if (!launchEntryOf.has(e.harness)) launchEntryOf.set(e.harness, e) }
  const START_KINDS = new Set(['optin-user-path', 'optin-machine-path', 'optin-shortcut', 'optin-vscode'])
  for (const e of entries) {
    if (e.kind === 'optin-user-path') noteStart(e, path.win32.join(v(e).binDir || '', `${v(e).command}.cmd`))
    else if (e.kind === 'optin-machine-path') noteStart(e, `${MACHINE_BIN}\\${v(e).command}.cmd`)
    else if (e.kind === 'optin-shortcut' || e.kind === 'optin-vscode') noteStart(e, v(e).launcher)
    else continue
    if (e.kind === 'optin-user-path' || e.kind === 'optin-machine-path') launchEntryOf.set(e.harness, e) // a PATH entry outranks a launcher one for the attribution
  }
  // a harness is judged only when each of its forms has a start entry: the name list says the harness, never the form (D51), so a CLI process must not be
  // compared with the editor's launcher, nor the editor with the CLI's shim
  const startForms = new Set(entries.filter((e) => START_KINDS.has(e.kind)).map((e) => e.form))
  for (const h of [...startTargetsOf.keys()]) {
    const forms = (groups || []).filter((x) => x.harness === h).flatMap((x) => x.forms.map((f) => f.id))
    if (!forms.length || !forms.every((f) => startForms.has(f))) startTargetsOf.delete(h)
  }
  if (startTargetsOf.size && Array.isArray(procs) && procs.length && typeof identify === 'function') {
    const whose = whoseWithHosts(identify, groups) // the host-tree rule (a form's hosts.processes → its harness) first, then the name list: core/host-agent.mjs
    const rows = procs.map((p) => ({ pid: p && p.pid, ppid: p && p.ppid, exe: p && p.exe, argv: Array.isArray(p && p.argv) ? p.argv : p && p.cmdline != null ? splitCommandLine(String(p.cmdline)) : null, cmdline: p && p.cmdline != null ? String(p.cmdline) : Array.isArray(p && p.argv) ? p.argv.join(' ') : null }))
    const harnessOf = new Map()
    for (const p of rows) {
      if (p.exe == null) continue
      const facts = { os: 'win32', exe: p.exe, argv: p.argv, cmdlineState: p.argv ? 'ok' : 'empty' }
      const m = whose(facts)
      if (m && m.agent) harnessOf.set(p.pid, m.agent)
    }
    for (const [harness, targets] of startTargetsOf) {
      if (findings.some((f) => f.harness === harness && f.code)) continue // the entry itself is already the finding; which process went around it is noise next to that
      const bad = []
      for (const p of rows) {
        if (harnessOf.get(p.pid) !== harness || p.ppid == null) continue
        const parent = rows.find((r) => r.pid === p.ppid)
        if (parent && targets.some((t) => (parent.exe != null && samePath(parent.exe, t)) || (parent.cmdline != null && parent.cmdline.toLowerCase().includes(String(t).toLowerCase())))) continue
        if (parent && harnessOf.get(parent.pid) === harness) continue // a child of the agent itself (an editor's extension host): the entry question is the top process's
        bad.push(`pid ${p.pid} (parent ${parent && parent.exe ? parent.exe : 'no longer running'})`)
      }
      if (bad.length) {
        const e = launchEntryOf.get(harness)
        findings.push({ form: e.form, item: e.item, harness, code: 'not-via-entry', detail: `${bad.length} running ${harness} process(es) were not started through the entry (${targets[0]}): ${bad.join(', ')}` })
      }
    }
  }
  return findings
}

/** What the daemon's 5 s check does with the findings: one failure record per finding not already reported (driftCheck's `state.seen` shape —
 *  in memory, so a daemon restart says it again once), and only for the codes 1.6 §9.7 names as `where:'netenv'` failures (shim-not-on-path,
 *  not-via-entry); an `entry-changed` finding and an `unknown` one are no event (the same list: the rest reach `status` / `doctor` alone, whose
 *  opt_in rows carry them). → the findings recorded this time (a test's view). */
export function recordEntryFindings({ findings = [], state = null, appendEvent }) {
  const done = []
  for (const f of findings || []) {
    const key = `${f.form}|${f.item}|${f.code || 'unknown'}|${f.reason || ''}|${f.detail}`
    if (state && state.seen && state.seen.has(key)) continue
    if (state && state.seen) state.seen.add(key)
    if (f.code === 'shim-not-on-path' || f.code === 'not-via-entry') {
      appendEvent({ event: 'failure', where: 'netenv', harness: f.harness, code: f.code, form: f.form, item: f.item, reason: f.detail })
    }
    done.push(f)
  }
  return done
}
