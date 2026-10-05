// src/raw/closed.mjs — the explicit "this shard is closed" marker (RFC 4.6 §日志体积预算 「已关闭」).
//
// Closed MUST mean: the writer wrote an explicit close marker after fsync and after releasing its fd.
// It MUST NOT be inferred from a date in the file name or from mtime — an SSE response that began
// before midnight is still being appended after it. The 4.6 OPEN's recommended form is used: an empty
// `<shard>.closed` file beside the shard, so the shard's own bytes are never touched.
//
// `markClosed` is what the collector's writer calls (src/collector/core/record/store.mjs, not wired
// here) once it has fsync'd and closed a rotated shard. The sealer refuses anything without a marker.
import nodeFs from 'node:fs';
import path from 'node:path';

export const CLOSED_SUFFIX = '.closed';
export const closedMarkerPath = (shard) => shard + CLOSED_SUFFIX;

export function fsyncDir(fs, dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Call AFTER the shard's fd has been fsync'd and closed. Idempotent; never touches the shard's bytes.
export function markClosed(shard, { fs = nodeFs } = {}) {
  fs.statSync(shard);                                   // a marker for a missing shard would be a lie
  const marker = closedMarkerPath(shard);
  let fd;
  try { fd = fs.openSync(marker, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return marker; throw e; }
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDir(fs, path.dirname(shard));
  return marker;
}

export function closedState(shard, { fs = nodeFs } = {}) {
  let ms;
  try { ms = fs.statSync(closedMarkerPath(shard)); }
  catch { return { closed: false, reason: `no close marker (${path.basename(closedMarkerPath(shard))}) — the writer has not declared it closed` }; }
  const ss = fs.statSync(shard);
  // Belt and braces: bytes written after the marker mean the writer reopened it.
  if (ss.mtimeMs > ms.mtimeMs) return { closed: false, reason: 'the shard was modified after its close marker' };
  return { closed: true, reason: null };
}
