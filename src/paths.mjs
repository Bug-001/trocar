// src/paths.mjs — the ONE place default capture/serve paths are decided.
//
// Why this module exists (first-run dead end): the capture writers and the board
// reader each computed their own default, inline, and they disagreed —
//   asight capture → ~/.atrace/capture.ndjson
//   asight mitm    → ~/.atrace/asight/claude-capture.ndjson
//   asight serve   → ~/.atrace/capture.ndjson
// So the documented happy path (arrange capture, then serve) showed "No sessions captured yet" while
// the user's capture sat on disk one directory away, with nothing in the UI to explain why. Every new
// user hit it. Inline defaults cannot be checked against each other; centralised ones can, and
// test/paths.test.mjs now pins the invariant: whatever a capture writer writes, the default board reads.
//
// The default source is a DIRECTORY, not a file: the server supports directory sources, and that is
// what lets Claude Code / Codex / OpenCode sessions appear side by side on one board. A single-file
// default silently hides every other harness the user captured.
//
// ── D27 (2026-07-20): the home is ~/.asight ─────────────────────────────────────────────────────
// The product is asight everywhere — CLI, ASIGHT_* env, com.asight.monitor, the README title — and
// only the filesystem still carried the v0 prototype's name. D60 ② (2026-10-18) closed the reading
// side too: older locations (`~/.atrace/asight/`, `~/.asight/sessions/`) are neither read nor touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const asightHome = () => path.join(os.homedir(), '.asight');

// reverse-proxy / relay tee (CC-CLI, Codex, OpenCode, DeepSeek-CLI)
export const captureOut = () => path.join(asightHome(), 'capture.ndjson');
// MITM (Claude Desktop — the only source that must decrypt TLS)
export const mitmOut = () => path.join(asightHome(), 'claude-capture.ndjson');
// The per-user process collector (RFC 4.6 §记录) writes its envelopes to <here>/capture-<date>.ndjson.
// Its subdirectories flows/ audit/ replays/ are NOT envelopes; the board never reads them because a
// root's scan only descends into <sub>/calls.ndjson (server.mjs scanRoots), and `asight etl <dir>`
// does not descend at all. It needs a root of its own: the home's one-level scan never reaches it.
export const collectorHome = (home = asightHome()) => path.join(home, 'collector');
// The raw layer (D60①, 1.6 §1.7): the daemon's segments `<here>/<segment>.ndjson`, their sealed form `<segment>.sealed`,
// and the seal journal. Only envelopes live here — the collector's own logs stay under collectorHome().
export const rawHome = (home = asightHome()) => path.join(home, 'raw');
// D60: what `asight query` builds from the segments to answer fast. Derived, never a source of truth — deleting it costs a rebuild, nothing more
// (src/query/index-build.mjs has the same path under its own name; uninstall reads it from here).
export const indexHome = (home = asightHome()) => path.join(home, 'index');
// D60③ (1.6 §4.2): the editable traffic class table — the user's copy of it (written whole on the first edit) and the
// log of every change (old value, new value, time). Read by the collector (the level of a call) and by `asight classes`.
export const classesFile = (home = asightHome()) => path.join(home, 'classes.json');
export const classesLog = (home = asightHome()) => path.join(home, 'logs', 'classes.ndjson');

// Capture CA. NOT symmetric with the others: for every other path "not found" means an empty board,
// but for the CA it means the code MINTS A SECOND ROOT and asks the user to trust it — while the
// first one stays installed in their keychain, and `off --remove-ca` (which now looks in the new
// place) can no longer remove it. The keychain identifies a root by its subject name, not its path,
// so an existing CA keeps working wherever it sits: if the legacy directory holds one, that IS the
// CA, and we use it in place. Only a machine with no CA at all gets one in the new home.
// (The subject name `CA_CN` is frozen for exactly this reason — see D27's explicit non-scope.)
export function caDir({ home = asightHome(), legacyCa = path.join(os.homedir(), '.atrace', 'ca') } = {}) {
  const fresh = path.join(home, 'ca');
  if (existsQuiet(fresh)) return fresh;
  if (existsQuiet(legacyCa)) return legacyCa;
  return fresh;
}

// what `asight serve` reads when the user gives no --source: the roots that EXIST. Listing an absent
// root would make the loader throw "capture source unreadable" on a clean machine, turning "nothing
// captured yet" into "something is broken", so absence is filtered here.
// 2026-10-06 (4.4:129): the collector directory is the second root, filtered the same way — a machine
// that has never run the collector lists no phantom root.
// 2026-10-18 (D60 ②): older locations (`~/.atrace/asight/`) are neither read nor touched.
export function serveSource({ home = asightHome(), collector = collectorHome(home) } = {}) {
  const roots = [];
  if (existsQuiet(home)) roots.push(home);
  if (existsQuiet(collector)) roots.push(collector);
  return roots;
}

// What counts as a capture file at the top of a source directory: a `*.ndjson` that is a regular
// file or a symlink to one (e.g. ~/.asight/codex-capture.ndjson -> ~/.atrace/codex-capture.ndjson). ONE rule
// for the board loader, the block resolver and `asight etl <dir>`: they used to disagree (isFile()
// in two of them dropped links silently), so the board listed what the resolver could not open.
// A link that points nowhere, or at a directory, is not a capture file.
export function isCaptureFile(dir, ent) {
  if (!ent.name.endsWith('.ndjson')) return false;
  if (ent.isFile()) return true;
  if (!ent.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(dir, ent.name)).isFile(); } catch { return false; }
}

// Why an entry that is NOT a capture file was not read (4.4:83: a skipped or unknown file is
// reported, never folded into empty). Same three readers. `attention` = it may hold capture bytes
// the reader did not show (a dangling link, a compressed capture, a *.ndjson that is not a file);
// the rest (a config file, the CA, a database, a subdirectory) is listed and counted but is not
// capture data.
const COMPRESSED = new Set(['.gz', '.zst', '.bz2', '.xz', '.zip', '.br', '.lz4']);
export function skipReason(dir, ent) {
  const name = ent.name, ndjson = name.endsWith('.ndjson');
  let target = ent;
  if (ent.isSymbolicLink()) {
    try { target = fs.statSync(path.join(dir, name)); } catch { return { reason: 'broken-symlink', attention: ndjson }; }
  }
  if (target.isDirectory()) return { reason: 'directory', attention: ndjson };
  if (COMPRESSED.has(path.extname(name).toLowerCase())) return { reason: 'compressed', attention: true };
  if (ndjson) return { reason: 'not-a-file', attention: true }; // a fifo, socket or device named *.ndjson
  return { reason: 'not-ndjson', attention: false };
}

function existsQuiet(p) { try { return fs.existsSync(p) } catch { return false } }
