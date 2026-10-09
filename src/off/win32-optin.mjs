// win32-optin.mjs (src/off) — the registry of the user-level opt-in undos (RFC 4.8 §2.4, §4.2; plan Task 9(b) ships the REGISTRY and the
// LOOP, Task 14 adds one inline function per kind). Every user-level undo lives HERE, in JavaScript and execTool, with no script file: the
// standalone `asight-off` is made of src/off alone and must take the opt-in items out with the source tree gone (1.6 R3, 0.1 §2).
// A machine-level item is never touched here: its elevated command is printed for the operator (result `needs-admin`), and the caller
// exits 1 for it — asight never elevates on its own (R7, 4.8 §2.4, the user's 2026-10-07 decision: a confirmation, then the OS's own
// prompt, never a command as the normal path).
import { execTool } from './exec.mjs'

/** kind → ({ entry, exec, env, fs, home }) → { ok: boolean, result: 'undone' | 'absent' | 'left' | 'failed', reason? }. Task 14 fills one
 *  function per opt-in kind; a kind with no function here is an item a newer build wrote (the loop says so, never guesses). */
export const UNDO_BY_KIND = {}

/** The user-level opt-in items of `manifest`, undone by kind through the registry; the machine-level remainder named for the operator.
 *  → `{ results: [{ path, kind, scope, result, reason? }], needsAdmin: [{ path, kind, command? }], unknown: [{ path, kind }] }`; nothing
 *  throws — an item that could not be undone is a result, and the caller decides the exit. `ids` limits the harnesses, as everywhere. */
export async function undoOptIns({ manifest, ids = null, exec = null, env = process.env, fs = null, home = null } = {}) {
  const out = { results: [], needsAdmin: [], unknown: [] }
  const inScope = (h) => typeof h === 'string' && (ids == null || ids.includes(h))
  for (const e of (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])) {
    if (!e || !e.scope || !inScope(e.harness)) continue // an ordinary entry has no `scope`; the opt-in ones always do (Task 14)
    const row = (r) => out.results.push({ path: e.path, kind: e.kind, scope: e.scope, ...r })
    if (e.scope === 'machine') { out.needsAdmin.push({ path: e.path, kind: e.kind, ...(typeof e.elevated_command === 'string' ? { command: e.elevated_command } : {}) }); row({ result: 'needs-admin', reason: 'a machine-level item: run the elevated command above, asight does not elevate on its own (R7)' }); continue }
    const undo = UNDO_BY_KIND[e.kind]
    if (!undo) { out.unknown.push({ path: e.path, kind: e.kind }); row({ result: 'unknown-kind', reason: `${e.path} is an opt-in item of kind ${JSON.stringify(e.kind)}, which this build has no undo for; use the asight that wrote it` }); continue }
    try { row(await undo({ entry: e, exec, env, fs, home })) } catch (err) { row({ result: 'failed', reason: String((err && err.message) || err) }) }
  }
  return out
}
