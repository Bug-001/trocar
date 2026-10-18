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
 *  undoneByMarker   there was no usable manifest: the entry was found and undone by asight's own marker;
 *  rootNotRemoved   uninstall asked the OS to take asight's root out of the user's trust store and it is still there (the prompt was not
 *                   answered with yes, or the store could not be read back): the machine still trusts it, and the record says so;
 *  entryRefused     `on` could not change a harness's entry file (its bytes prove no encoding — `why`, 4.6「文件的编码」 — and the other refusals of
 *                   4.6「逐 harness 跳过」): not a byte of it was written, that harness is skipped. */
export const CODE_OFF = Object.freeze({ backupFailed: 'backup-failed', backupKept: 'backup-kept', undoneByMarker: 'undone-by-marker', rootNotRemoved: 'root-not-removed', entryRefused: 'entry-refused' })
