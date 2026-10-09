// optin.mjs — the opt-in items of 4.8 §2.4 (D43⑥, 1.6 §1.7): the changes whose reach goes beyond the agent itself are never the default. `on`'s plan
// lists what each form would need and what it implies; the user names the form (`asight on <harness> --opt-in <form>`); asight performs it, ledgers
// it (with `scope`), backs the prior state up first, and `off` / the standalone undo take it out again. This file is the item catalog and the two
// read halves (the plan and the check of what is still in effect); the doing lives here too (`applyOptIn`), one fixed PowerShell script per item
// kind (optin/*.ps1 — apply only: the undo is inline JavaScript in src/off/win32-optin.mjs, so it runs when the source tree is gone; the read-only
// helper does none of these writes, W1). Machine-level items never run a script of their own: they are ONE self-contained elevated command
// (elevate.mjs; the OS's own prompt — UAC — never a password of asight's, 1.6 §1.7, V63). Pure data and injected-exec functions: no socket, no
// process, no registry of its own; a test runs everything against a sandbox HOME and a recording runner.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
      if (!def) throw new TypeError(`unknown opt-in item ${JSON.stringify(it.item)} on group ${x.g} (4.8 §2.4 has no such item)`)
      const entries = optinEntriesOf(manifest, x.harness, x.g)
      for (const f of x.forms) {
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

/** → every form id that has opt-in items in `groups` (the `--opt-in` usage error lists them; naming anything else is a usage error, not a skip). */
export const optinFormsOf = (groups) => [...new Set(planOptIns({ groups }).map((r) => r.form))]

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

/** One named item (turnOn calls this per chosen row, inside the op lock, after the install's own writes). The user-level half (the fixed scripts)
 *  lands with its own commit; until then a user-level row is an honest failure, never a silent skip. */
export async function applyOptIn(args) {
  const { row } = args
  const def = OPTIN_ITEMS[row.item]
  if (!def) return { state: 'failed', reason: `unknown opt-in item ${row.item}` }
  if (def.scope !== 'machine') return { state: 'failed', reason: `the user-level apply of ${row.item} is not built yet (Task 14's script commit)` }
  const values = await machineValuesOf(args)
  if (values.error) { (args.failure || (() => {}))({ code: 'optin-failed', form: row.form, item: row.item, scope: 'machine', reason: values.error }); return { state: 'failed', reason: values.error } }
  return applyMachineOne({ ...args, values })
}

/** What a machine item's step needs: the command name (the group's shim entry), the real binary's path (the resolver's answer) and the machine
 *  PATH as read now. Every piece injected, so a test answers and nothing here runs a tool for real. */
async function machineValuesOf({ row, groups = [], deps = {} }) {
  if (row.item === 'machine-path-dispatcher') {
    const g = groups.find((x) => x.forms.some((f) => f.id === row.form)) || null
    const command = g && g.group && g.group.proxyEntry && g.group.proxyEntry.kind === 'shim' ? g.group.proxyEntry.command : null
    if (!command) return { error: `the form ${row.form} has no shim command, so there is no dispatcher to build` }
    if (typeof deps.resolveCommand !== 'function') return { error: 'no command resolver is wired in (the machine PATH item cannot be built)' }
    const real = deps.resolveCommand(command)
    if (!real || real.where !== 'machine' || !real.path) return { error: `the real binary of ${command} did not resolve on the machine PATH (the user-level shim item is the right one here)` }
    if (typeof deps.readMachinePath !== 'function') return { error: 'the machine PATH could not be read (no reader wired in)' }
    const machinePath = deps.readMachinePath()
    if (machinePath == null) return { error: 'the machine PATH could not be read, so the elevated step cannot be built (nothing was changed)' }
    return { command, realBinary: real.path, machinePath }
  }
  return { error: `the machine item ${row.item} is not built yet (Task 14's later commits)` }
}
