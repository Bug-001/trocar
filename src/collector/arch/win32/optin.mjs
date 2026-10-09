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
