// schema.mjs — the contract of what `trocar on | off | status | uninstall | doctor` print (RFC 1.6 R4 exit codes, R5 `--json`
// receipt keys). `src/cli/schema.mjs` re-exports it and adds `validateReceipt`; it lives here because `src/off/` (the undo side,
// node:* only, 0.1 §2) prints receipts too, and so does the standalone `~/.trocar/bin/trocar-off` generated from this directory. The error
// document lives here for the same reason: the copy answers a refusal with one too.
// Imports nothing.

/** Bumped when a key of the receipt changes meaning or goes; adding a key does not bump it (R5 lists the least a receipt has). */
export const SCHEMA_VERSION = 2

/** R4. `unknown` (3) is for `status` / `doctor` only: it must never be read as `ok`. `crash` is `trocar daemon`'s (src/collector/cli.mjs). */
export const EXIT = Object.freeze({ ok: 0, incomplete: 1, usage: 2, unknown: 3, crash: 70 })

/** R5: the top-level keys every receipt carries, in the order `newReceipt` writes them. */
export const RECEIPT_KEYS = Object.freeze(['schema', 'command', 'ok', 'changed', 'created', 'removed', 'skipped', 'restart', 'relayed', 'undo', 'log'])

/** C.1 `undo`: the ONE command line that undoes the command (a list of related commands is not an undo). `classes` writes its own inverse edit. */
export const UNDO_LINE = Object.freeze({ install: 'trocar uninstall', on: 'trocar off', off: 'trocar on', uninstall: 'trocar install' })

/** `{schema, command, ok: false, error: {code, message, detail?}}`. */
export const errorDoc = (command, code, message, detail) => ({
  schema: SCHEMA_VERSION, command, ok: false, error: { code, message, ...(detail ? { detail } : {}) },
})

/** C.1: a client reads `error.code` and nothing else, so a receipt that says `ok: false` always has one: `failed` with its first sentence, unless the command gave its own. A run that
 *  stopped before writing to wait for a person (`needs_yes`, `declined`, `dry_run`) did not fail, and a reading's `ok` (status, doctor, a query) is its own conclusion, not a failure. */
export function withError(doc) {
  if (doc.ok !== false || doc.error || doc.needs_yes || doc.declined || doc.dry_run || !RECEIPT_KEYS.every((k) => Object.hasOwn(doc, k))) return doc
  const said = [...(doc.problems || []), ...(doc.notes || [])].find((s) => typeof s === 'string' && s)
  return { ...doc, error: { code: 'failed', message: said || `trocar ${doc.command} did not finish; the rest of this document says what is left` } }
}

/** An empty receipt for `command`, ok until something says otherwise; a fresh object (its lists are the caller's to fill). `relayed`
 *  starts as `'unknown'` (R5 / R11: what was not read is not 0): a command that counted connections writes `{closing, waiting, cut}`
 *  over it — `on`, which has none to count, writes zeros on purpose — and one that forgot prints 「不知道」, not a confident 0. `linger`
 *  (`on` / `status` on Linux) and the command-specific keys (`daemon`, `kept_backups`, …) are added by the command. */
export function newReceipt(command) {
  return { schema: SCHEMA_VERSION, command, ok: true, changed: [], created: [], removed: [], skipped: [], restart: [], relayed: 'unknown', undo: null, log: null }
}
