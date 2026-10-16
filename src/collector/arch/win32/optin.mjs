// UNWIRED (D57: no named item and no admin step on macOS / Windows, 4.11 ⑱, CM25): what is left is deleted in a later commit.
// optin.mjs — what is left of the Windows opt-in items of 4.8 §2.4: the item catalog and the imports the deleted halves used.
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execTool } from '../../../off/exec.mjs'
import { writeBackup } from '../../../off/backup.mjs'
import { setKey, getPath } from '../../../off/json-text.mjs'
import { splitCommandLine } from './procinfo.mjs'
import { whoseWithHosts } from '../../core/host-agent.mjs'
import { renderCmdTemplate, markerScript } from './shims.mjs'
import { readIngressConfig } from '../../core/ingress-config.mjs'
import { readUserPath, prependUserPath, resolveCommand, sacOf, sacBlocksShims, readShortcutTarget, shortcutPlaces } from './userpath.mjs'
import { readMachinePath, MACHINE_BIN } from './elevate.mjs'

const nodeFs = fs

/** The opt-in's groups of the harness descriptors, flat: `[{ g, harness, group, forms, proxy }]` from each one's `win32` data (the overlay the loader
 *  attaches); a form with no group is in none. Moved here from the deleted arch/win32/route-plan.mjs: the opt-in half is its last reader. */
export function groupsOf(descriptors) {
  const out = []
  for (const d of descriptors || []) {
    const w = d && d.win32
    if (!w) continue
    for (const group of w.groups || []) out.push({ g: group.g, harness: d.name, group, forms: (w.forms || []).filter((f) => f.g === group.g), proxy: w.proxy })
  }
  return out
}

const PORT = (n) => Number.isInteger(n) && n >= 1 && n <= 65535
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/
/** The value a group's proxy entry holds: its id and the listener token as the Basic credentials of the group's loopback port (ingress.json);
 *  a group whose entry takes no credentials (`auth:false`) holds the address alone. Moved here from the deleted core/entry-forms.mjs half. */
function proxyUrl(group, { port, listenerToken } = {}) {
  if (!PORT(port)) throw new TypeError(`the kernel port of ${group.g} must be a TCP port, got ${typeof port === 'number' ? port : typeof port}`)
  if (!group.auth) return `http://127.0.0.1:${port}`
  if (typeof listenerToken !== 'string' || !TOKEN.test(listenerToken)) throw new TypeError('the listener token is 16..128 characters of letters, digits, - and _')
  return `http://${group.g}:${listenerToken}@127.0.0.1:${port}`
}
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
/** The 「点名也不做」category (1.6 §1.7): what a harness may DECLARE its form would additionally need, so the plan says WHY asight never does it
 *  instead of silently offering less. Never an item to run, never a write, never in `--opt-in`'s nameable forms; naming the form anyway is a usage
 *  error. The one entry today: a proxy variable in the login environment (D43: writing it there directly is not acceptable). */
export const OPTIN_NEVER = Object.freeze({
  'login-env-proxy': 'asight never writes HTTPS_PROXY (or any proxy variable) into the login environment - HKCU\\Environment, $PROFILE, environment.d - because a proxy for your whole login session reaches beyond the agent; the connections this form sends outside its own entries are not captured (1.6 §1.7「点名也不做」)',
})
