// src/raw/export.mjs — `asight raw export`: give the operator plain NDJSON back (RFC 4.2 「导出」).
//
// Sealing must never hide the raw bytes from the user (invariant 4): any sealed file, or every
// sealed file of one session, can be turned back into ordinary NDJSON — the exact original lines, in
// order. The output carries credentials like the capture itself: it is created exclusively ('wx') with
// mode 0600, and the default directory `~/.asight/export/` is 0700 (4.1 §凭据处置, E9).
import nodeFs from 'node:fs';
import path from 'node:path';
import { asightHome } from '../paths.mjs';
import { openSealed } from './reader.mjs';
import { isSealedPath } from './discover.mjs';
import { appendJournal, defaultJournalPath } from './journal.mjs';

export const exportDir = () => path.join(asightHome(), 'export');

// The sealed files of one session dir, in segment order.
export function sessionSealedFiles(sessionsRoot, session) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(session)) throw new Error(`not a session id: ${session}`);
  const dir = path.join(sessionsRoot, session);
  return nodeFs.readdirSync(dir).filter((n) => isSealedPath(n)).sort().map((n) => path.join(dir, n));
}

// Every file under the export dir (for `asight doctor` ④b: they hold credentials too).
export function exportFiles(dir = exportDir(), { fs = nodeFs } = {}) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name)); } catch { return []; }
}

export function exportSealed({ files, out, fs = nodeFs, journal = defaultJournalPath() }) {
  if (!files.length) throw new Error('nothing to export: no sealed files');
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(out, 'wx', 0o600);
  let records = 0, bytes = 0;
  try {
    for (const f of files) {
      const sf = openSealed(f, { fs });
      try { for (const { line } of sf.lines()) { fs.writeSync(fd, line); records++; bytes += line.length; } } finally { sf.close(); }
    }
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(out); } catch {}
    appendJournal({ op: 'export', outcome: 'failed', sealed: files, out, reason: e.message }, { journal });
    throw new Error(`export failed, nothing written: ${e.message}`);
  }
  fs.closeSync(fd);
  appendJournal({ op: 'export', outcome: 'ok', sealed: files, out, records, bytes }, { journal });
  return { out, records, bytes };
}
