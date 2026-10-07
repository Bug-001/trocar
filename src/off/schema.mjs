// schema.mjs — the contract of what `asight on | off | status | uninstall | doctor` print (RFC 1.6 R4 exit codes, R5 `--json`
// receipt keys). `src/cli/schema.mjs` re-exports it and adds `validateReceipt`; it lives here because `src/off/` (the undo side,
// node:* only, 0.1 §2) prints receipts too, and so does the standalone `~/.asight/bin/asight-off` generated from this directory.
// Imports nothing.

/** Bumped when a key of the receipt changes meaning or goes; adding a key does not bump it (R5 lists the least a receipt has). */
export const SCHEMA_VERSION = 1

/** R4. `unknown` (3) is for `status` / `doctor` only: it must never be read as `ok`. `crash` is `asight daemon`'s (src/collector/cli.mjs). */
export const EXIT = Object.freeze({ ok: 0, incomplete: 1, usage: 2, unknown: 3, crash: 70 })

/** R5: the top-level keys every receipt carries, in the order `newReceipt` writes them. */
export const RECEIPT_KEYS = Object.freeze(['schema', 'command', 'ok', 'changed', 'created', 'removed', 'skipped', 'restart', 'relayed', 'undo', 'log'])

/** An empty receipt for `command`, ok until something says otherwise; a fresh object (its lists are the caller's to fill). `relayed`
 *  starts as `'unknown'` (R5 / R11: what was not read is not 0): a command that counted connections writes `{closing, waiting, cut}`
 *  over it — `on`, which has none to count, writes zeros on purpose — and one that forgot prints 「不知道」, not a confident 0. `linger`
 *  (`on` / `status` on Linux) and the command-specific keys (`daemon`, `kept_backups`, …) are added by the command. */
export function newReceipt(command) {
  return { schema: SCHEMA_VERSION, command, ok: true, changed: [], created: [], removed: [], skipped: [], restart: [], relayed: 'unknown', undo: [], log: null }
}
