// names.mjs — the names `asight off` (src/off/**) writes into the D38 records: `where`, `event`, `code`. They are the ones
// src/health/codes.mjs lists as OFF_WHERE / OFF_EVENTS / OFF_CODES; `src/off/` may import nothing outside itself (0.1 §2: the
// standalone `asight-off` is made of this directory alone), so the list is written here too, and test/health/codes.test.mjs fails
// when the two differ. Imports nothing.

/** `where` of every record `off` writes. */
export const WHERE_OFF = 'off'

/** The event line of one step or note of an `off` run (the last one has `kind: 'result'`, RFC 1.6 R1). A state change, not a failure. */
export const EVENT_OFF_NOTE = 'off-note'

/** `code` of an off-note or of a failure of an `off` run, RFC 1.6 R2 / R3:
 *  backupFailed     the backup could not be written, so the user's file was left as it was (a `failure` event);
 *  backupKept       the user changed the file after asight did: only asight's part was undone, the backup is kept and listed;
 *  undoneByMarker   there was no usable manifest: the entry was found and undone by asight's own marker. */
export const CODE_OFF = Object.freeze({ backupFailed: 'backup-failed', backupKept: 'backup-kept', undoneByMarker: 'undone-by-marker' })
