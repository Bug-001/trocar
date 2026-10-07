// src/raw/export.mjs — `asight raw export`: give the operator plain NDJSON back (RFC 4.2 「导出」).
//
// Sealing must never hide the raw bytes from the user (invariant 4): any sealed file, or every
// sealed file of one session, can be turned back into ordinary NDJSON — the exact original lines, in
// order, one output file per segment. The output carries credentials like the capture itself: it is created exclusively ('wx') with
// mode 0600, and the default directory `~/.asight/export/` is 0700 (4.1 §凭据处置, E9).
import nodeFs from 'node:fs';
import path from 'node:path';
import { asightHome } from '../paths.mjs';
import { openSealed } from './reader.mjs';
import { isSealedPath, orderInputs } from './discover.mjs';
import { appendJournal, defaultJournalPath } from './journal.mjs';

export const exportDir = () => path.join(asightHome(), 'export');
// A segment's export name: its sealed name with `.sealed` → `.ndjson` (calls.ndjson.0001.ndjson).
const exportName = (sealed) => path.basename(sealed).replace(/\.sealed$/, '.ndjson');

// `asight raw export <session-id|file.sealed>`: resolve, export, and journal ANY failure — a missing
// session dir or an existing output included (review F15). A file goes to one NDJSON file; a session
// to a directory `~/.asight/export/<session>/` holding one file per segment, never one joined file: a
// stream whose last line has no "\n" would run into the next stream's first line (review 3 F8).
export function runExport({ target, sessionsRoot, out, fs = nodeFs, journal = defaultJournalPath() }) {
  const isFile = target.endsWith('.sealed');
  const dest = out || path.join(exportDir(), isFile ? exportName(target) : target);
  let files;
  try { files = isFile ? [path.resolve(target)] : sessionSealedFiles(sessionsRoot, target); }
  catch (e) {
    appendJournal({ op: 'export', outcome: 'failed', target, out: dest, reason: e.message }, { journal, fs });
    throw new Error(`export failed, nothing written: ${e.message}`);
  }
  return isFile ? exportSealed({ files, out: dest, fs, journal }) : exportSession({ files, out: dest, fs, journal });
}

// The sealed files of one session dir, in record order (discover.mjs orderInputs).
export function sessionSealedFiles(sessionsRoot, session) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(session)) throw new Error(`not a session id: ${session}`);
  const dir = path.join(sessionsRoot, session);
  return orderInputs(nodeFs.readdirSync(dir).filter((n) => isSealedPath(n)).map((n) => path.join(dir, n)), SESSION_STREAMS);
}
const SESSION_STREAMS = ['calls.ndjson', 'probes.ndjson', 'other.ndjson'];

// Every file under the export dir and one level down — a session's directory (for `asight doctor` ④b:
// they hold credentials too). A directory that is not there is no files; one that exists and cannot be
// listed is `onError(dir, err)` (doctor: 无法判定) — without an `onError` it is skipped as before.
export function exportFiles(dir = exportDir(), { fs = nodeFs, onError = null } = {}) {
  const out = [];
  const bad = (d, e) => { if (onError && !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) onError(d, e); };
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { bad(dir, e); return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isFile()) out.push(p);
    else if (e.isDirectory()) try { for (const s of fs.readdirSync(p, { withFileTypes: true })) if (s.isFile()) out.push(path.join(p, s.name)); } catch (err) { bad(p, err); }
  }
  return out;
}

// Our own default dir is owner-only even if it existed before with looser bits (E9); a directory the
// operator chose with --out stays as they made it.
function prepareDir(fs, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (path.resolve(dir) === path.resolve(exportDir())) fs.chmodSync(exportDir(), 0o700);
}

// Write one sealed file's lines to `out` ('wx', 0600). → { records, bytes }. Throws; `out` is removed.
function writeOne(fs, f, out) {
  const fd = fs.openSync(out, 'wx', 0o600);
  let records = 0, bytes = 0;
  try {
    const sf = openSealed(f, { fs });
    try { for (const { line } of sf.lines()) { fs.writeSync(fd, line); records++; bytes += line.length; } } finally { sf.close(); }
    fs.fsyncSync(fd);
  } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(out); } catch {} throw e; }
  fs.closeSync(fd);
  return { records, bytes };
}

export function exportSealed({ files, out, fs = nodeFs, journal = defaultJournalPath() }) {
  try {
    if (files.length !== 1) throw new Error(files.length ? 'one sealed file per output file — export a session to a directory' : 'nothing to export: no sealed files');
    prepareDir(fs, path.dirname(out));
    const { records, bytes } = writeOne(fs, files[0], out);
    appendJournal({ op: 'export', outcome: 'ok', sealed: files, out, records, bytes }, { journal });
    return { out, records, bytes, outputs: [{ file: out, sealed: files[0], records, bytes }] };
  } catch (e) {
    appendJournal({ op: 'export', outcome: 'failed', sealed: files, out, reason: e.message }, { journal, fs });
    throw new Error(`export failed, nothing written: ${e.message}`);
  }
}

// A session: `out` is a NEW directory (an existing one is never written into — no export overwrites
// another), one file per segment. On any failure everything this run wrote is removed.
export function exportSession({ files, out, fs = nodeFs, journal = defaultJournalPath() }) {
  const outputs = [];
  let made = false;
  try {
    if (!files.length) throw new Error('nothing to export: no sealed files');
    prepareDir(fs, path.dirname(out));
    fs.mkdirSync(out, { mode: 0o700 }); made = true;     // EEXIST: exported before
    for (const f of files) { const o = path.join(out, exportName(f)); outputs.push({ file: o, sealed: f, ...writeOne(fs, f, o) }); }
  } catch (e) {
    for (const o of outputs) try { fs.unlinkSync(o.file); } catch {}
    if (made) try { fs.rmdirSync(out); } catch {}
    appendJournal({ op: 'export', outcome: 'failed', sealed: files, out, reason: e.message }, { journal, fs });
    throw new Error(`export failed, nothing written: ${e.message}`);
  }
  const records = outputs.reduce((a, o) => a + o.records, 0), bytes = outputs.reduce((a, o) => a + o.bytes, 0);
  appendJournal({ op: 'export', outcome: 'ok', sealed: files, out, outputs: outputs.map((o) => o.file), records, bytes }, { journal });
  return { out, records, bytes, outputs };
}
