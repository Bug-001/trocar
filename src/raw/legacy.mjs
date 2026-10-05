// src/raw/legacy.mjs — `asight raw seal --legacy`: the operator-triggered entry for pre-D35 files.
//
// Files written before D35 carry no close marker, so the marker-gated sealer refuses them forever.
// 4.2 OPEN (2), recommended default (coordinator 2026-10-06): the operator names a file or a whole
// `asight shard` tree (`sessions/<sid>/{calls,probes,other}.ndjson`, `control/*.ndjson`), and each
// file is sealed WHOLE, in place, only when nothing can still be writing it:
//   1. `asight shard --watch` is not running (it appends to these files) — else the whole run refuses;
//   2. size, mtime and inode stay unchanged over a quiet window;
//   3. no process holds an fd on it (pluggable: /proc on Linux, lsof on macOS; a probe that cannot
//      answer refuses — "cannot tell" is not "nobody").
// Every refusal is journalled with its reason (no silent failures). Originals are KEPT unless
// --delete-original: every deletion of existing data is explicitly confirmed. With it, a
// file that already has a sealed copy is checked byte for byte against that copy and only then
// deleted — no second encode. Legacy files are not split by session: `sessions/` files already are
// per session, and the old flat streams stay where readers already look for them.
// The old root `~/.atrace/asight/` is refused outright (oldRootReason in seal.mjs), even when named.
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sealUnchecked, SealRefused, oldRootReason } from './seal.mjs';
import { verifyAgainst } from './verify.mjs';
import { sealedSources, isSealedPath } from './discover.mjs';
import { fsyncDir, closedMarkerPath } from './closed.mjs';
import { appendJournal, defaultJournalPath } from './journal.mjs';

export const DEFAULT_QUIET_MS = 10000;

// The legacy streams under `target`: the file itself, or every *.ndjson in the directory and in its
// immediate subdirectories. Symlinks are refused, never followed.
export function legacyTargets(target, { fs = nodeFs } = {}) {
  const files = [], refused = [];
  const consider = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) refused.push({ file: p, reason: 'symlink — seal the file it points at, by its own path (unlinking a link would not remove the original)' });
    else if (st.isFile()) files.push(p);
  };
  const st = fs.lstatSync(target);
  if (!st.isDirectory()) {
    if (!target.endsWith('.ndjson')) refused.push({ file: target, reason: 'not an NDJSON capture stream (*.ndjson)' });
    else consider(target);
    return { files, refused };
  }
  for (const e of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(target, e.name);
    if (e.name.endsWith('.ndjson') && !e.isDirectory()) consider(p);
    else if (e.isSymbolicLink() && !e.name.endsWith('.ndjson')) refused.push({ file: p, reason: 'symlinked directory — not followed; seal what it points at by its own path' });
    else if (e.isDirectory()) {
      for (const s of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (s.name.endsWith('.ndjson') && !s.isDirectory()) consider(path.join(p, s.name));
      }
    }
  }
  return { files, refused };
}

// ── probes (injected in tests; the defaults only ever look at the files they are given) ───────────
export function parseLsof(out) {
  const holders = new Map();
  let pid = null;
  for (const line of String(out).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) { const f = line.slice(1); if (!holders.has(f)) holders.set(f, []); holders.get(f).push(pid); }
  }
  return holders;
}
export async function defaultFdHolders(files, { fs = nodeFs, platform = process.platform, run = spawnSync } = {}) {
  const real = new Map(files.map((f) => [fs.realpathSync(f), f]));
  const out = new Map();
  const add = (f, pid) => { if (!out.has(f)) out.set(f, []); out.get(f).push(pid); };
  if (platform === 'linux') {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let fds; try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }   // other users' processes
      for (const fd of fds) { let t; try { t = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; } if (real.has(t)) add(real.get(t), Number(pid)); }
    }
    return out;
  }
  if (platform === 'darwin') {
    // lsof exits 1 both when nobody holds the files and when it fails; only stderr tells them apart
    // (-w keeps warnings out of it). "Cannot tell" MUST NOT read as "nobody".
    const r = run('lsof', ['-w', '-F', 'pn', '--', ...real.keys()], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.error) throw new Error(`cannot check open file descriptors: lsof failed (${r.error.message})`);
    if (r.status !== 0 && String(r.stderr || '').trim()) throw new Error(`cannot check open file descriptors: ${String(r.stderr).trim().split('\n')[0]}`);
    for (const [f, pids] of parseLsof(r.stdout)) if (real.has(f)) for (const p of pids) add(real.get(f), p);
    return out;
  }
  throw new Error(`cannot check open file descriptors on ${platform}`);
}
export async function defaultProcessList({ fs = nodeFs } = {}) {
  if (process.platform === 'linux') {
    const out = [];
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try { out.push({ pid: Number(pid), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ') }); } catch {}
    }
    return out;
  }
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error(`cannot list processes: ps failed (${r.error ? r.error.message : r.stderr})`);
  return r.stdout.split('\n').filter(Boolean).map((l) => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return m ? { pid: Number(m[1]), cmd: m[2] } : null; }).filter(Boolean);
}
export const shardWatchers = (procs) => procs.filter((p) => p.pid !== process.pid && /\basight(?:\.mjs)?\s+shard\b.*\s--watch\b/.test(p.cmd));

const sameStat = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

export async function sealLegacy(target, { fs = nodeFs, deleteOriginal = false, quietMs = DEFAULT_QUIET_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fdHolders = defaultFdHolders, processList = defaultProcessList,
  journal = defaultJournalPath(), frameBytes, onFile = () => {}, dryRun = false } = {}) {
  if (dryRun) journal = null;                          // a dry run changes nothing, so it records nothing
  const refuseAll = (reason) => {
    appendJournal({ op: 'seal-legacy', outcome: 'refused', target, reason }, { journal });
    return new SealRefused(`refusing to seal ${target}: ${reason}`);
  };
  if (!(Number.isFinite(quietMs) && quietMs >= 0)) throw new SealRefused(`the quiet window must be a non-negative number of seconds (got ${quietMs / 1000})`);
  const old = oldRootReason(target, { fs });
  if (old) throw refuseAll(old);
  const { files: named, refused } = legacyTargets(target, { fs });
  // a parent of the old root names files inside it: each of those is refused too (none is ever
  // sealed or deleted there, D27①)
  const files = [];
  for (const f of named) { const why = oldRootReason(f, { fs }); if (why) refused.push({ file: f, reason: why }); else files.push(f); }
  // 1. the writer that appends to these files
  let procs;
  try { procs = await processList(); } catch (e) { throw refuseAll(`cannot tell whether \`asight shard --watch\` is running (${e.message})`); }
  const w = shardWatchers(procs);
  if (w.length) throw refuseAll(`\`asight shard --watch\` is running (pid ${w.map((p) => p.pid).join(', ')}) and appends to these files — stop it first`);
  // 2. quiet window
  const before = new Map(files.map((f) => [f, fs.statSync(f)]));
  await sleep(quietMs);
  const quiet = [];
  for (const f of files) {
    let now = null; try { now = fs.statSync(f); } catch {}
    if (now && sameStat(before.get(f), now)) quiet.push(f);
    else refused.push({ file: f, reason: `changed during the ${Math.round(quietMs / 1000)} s quiet window — something is still writing it` });
  }
  // 3. open file descriptors
  let holders;
  try { holders = await fdHolders(quiet, { fs }); } catch (e) { throw refuseAll(`cannot tell which processes hold these files open (${e.message})`); }
  const ok = [];
  for (const f of quiet) {
    const pids = holders.get(f);
    if (pids && pids.length) { refused.push({ file: f, reason: `held open by pid ${pids.join(', ')} — it may still be written` }); continue; }
    // A sealed copy of an EARLIER version of this file (it grew since): sealing again would leave two
    // copies of its first lines, and deleting would trust a copy that is not this file. Refuse.
    const size = fs.statSync(f).size;
    const stale = sameStreamCopies(fs, f).filter((c) => c.length !== size);
    if (stale.length) { refused.push({ file: f, reason: `stale sealed copy ${stale.map((c) => path.basename(c.file)).join(', ')} of an earlier version of this file (recorded ${stale[0].length} bytes, it now has ${size}) — check it with \`asight raw verify\`, remove it, then seal again` }); continue; }
    ok.push(f);
  }
  for (const r of refused) appendJournal({ op: 'seal-legacy', outcome: 'refused', file: r.file, reason: r.reason }, { journal });
  if (dryRun) return { target, dryRun: true, wouldSeal: ok, refused };

  const sealed = [], deletedOnly = [], failed = [];
  // A file that changed since the quiet window is being written after all: refuse it, whatever step
  // we are at. Asked before each file and again between its byte-for-byte check and the unlink.
  const moved = (f) => { let now = null; try { now = fs.statSync(f); } catch {} return now && sameStat(before.get(f), now) ? null : 'changed after the quiet window — something is still writing it; nothing deleted'; };
  for (const f of ok) {
    onFile(f);
    try {
      const m = moved(f);
      if (m) { refused.push({ file: f, reason: m }); appendJournal({ op: 'seal-legacy', outcome: 'refused', file: f, reason: m }, { journal }); continue; }
      if (deleteOriginal) {
        const copies = sameStreamCopies(fs, f).map((c) => c.file);
        if (copies.length) {
          // every copy is of this very length (stale ones were refused above): prove it byte for byte
          const v = verifyAgainst(copies, f, { fs });
          if (!v.ok) {
            const reason = `its sealed copy does not match it byte for byte (${v.reason}) — nothing deleted; check with \`asight raw verify\``;
            appendJournal({ op: 'verify', outcome: 'failed', file: f, sealed: copies, reason }, { journal });
            refused.push({ file: f, reason });
            continue;
          }
          // the copies' directory entries must be durable before the original's removal is (E5 order)
          for (const dir of new Set(copies.map((c) => path.dirname(c)))) fsyncDir(fs, dir);
          const late = moved(f);
          if (late) { refused.push({ file: f, reason: late }); appendJournal({ op: 'delete-original', outcome: 'refused', file: f, reason: late }, { journal }); continue; }
          fs.unlinkSync(f);
          try { fs.unlinkSync(closedMarkerPath(f)); } catch {}
          fsyncDir(fs, path.dirname(f));
          appendJournal({ op: 'delete-original', outcome: 'ok', file: f, verified: 'byte-for-byte', against: copies, records: v.records, bytes: v.bytes }, { journal });
          deletedOnly.push({ file: f, copies });
          continue;
        }
      }
      // the sealer journals its own outcome, and replaces earlier copies of this exact source
      sealed.push(await sealUnchecked(f, { fs, split: false, deleteOriginal, journal, frameBytes }));
    } catch (e) { failed.push({ file: f, reason: e.message }); }
  }
  return { target, sealed, deletedOnly, refused, failed };
}

// Sealed segments of `f`'s stream beside it whose only source has `f`'s name: { file, length }.
function sameStreamCopies(fs, f) {
  const dir = path.dirname(f), name = path.basename(f);
  return fs.readdirSync(dir).filter((n) => isSealedPath(n) && n.startsWith(name + '.')).map((n) => path.join(dir, n))
    .map((p) => { const s = sealedSources(p, { fs }); return s && s.length === 1 && s[0].name === name ? { file: p, length: s[0].length } : null; })
    .filter(Boolean);
}
