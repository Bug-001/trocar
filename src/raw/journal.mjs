// src/raw/journal.mjs — the durable record of every raw-layer outcome that is not plain success.
//
// User requirement 2026-10-06 (to become D38): no silent failures. A refused seal (active shard, fd
// held, `asight shard --watch` running), a failed verification, a sealed file that cannot be read —
// each MUST leave a record with its reason that the operator can find later, not only a line of CLI
// output that scrolled away. One append-only JSON line per event, 0600 (it names capture files),
// fsync'd. `.jsonl`, under `raw/`, so no capture reader ever mistakes it for an envelope stream.
import nodeFs from 'node:fs';
import path from 'node:path';
import { asightHome } from '../paths.mjs';

export const defaultJournalPath = () => path.join(asightHome(), 'raw', 'journal.jsonl');

// journal: a path, or null to disable (only for callers that report through another durable channel).
// Never throws: a journal that cannot be written must not mask the failure being journalled — the
// caller gets `false` and says so.
export function appendJournal(entry, { journal = defaultJournalPath(), fs = nodeFs } = {}) {
  if (journal == null) return false;
  try {
    fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(journal, 'a', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return true;
  } catch { return false; }
}

export function readJournal({ journal = defaultJournalPath(), fs = nodeFs } = {}) {
  let text;
  try { text = fs.readFileSync(journal, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparseable: l }; } });
}

// A read-side summary of what went wrong in one sealed file (from readRecords' scan), or null.
export function sealedReadProblem(scan) {
  if (!scan || !scan.sealed) return null;
  if (scan.sealedError) return { file: scan.file, reason: scan.sealedError, unreadableRecords: null };
  if (scan.unreadableRecords) return { file: scan.file, reason: scan.unreadable[0].reason, unreadableRecords: scan.unreadableRecords, examples: scan.unreadable };
  return null;
}
