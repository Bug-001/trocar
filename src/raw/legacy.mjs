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
import { sealUnchecked, SealRefused, oldRootReason, cleanDeadLocks } from './seal.mjs';
import { verifyAgainst, copyRelation } from './verify.mjs';
import { sealedSources, isSealedPath, streamOfSealed } from './discover.mjs';
import { fsyncDir, closedMarkerPath } from './closed.mjs';
import { appendJournal, defaultJournalPath } from './journal.mjs';

export const DEFAULT_QUIET_MS = 10000;

// The legacy streams under `target`: the file itself, or every *.ndjson in the directory and in its
// immediate subdirectories. Symlinks are refused, never followed. Everything else found there is NOT
// passed over in silence (review 3 F5, D38): what the entry knows to be no record stream is counted by
// kind (`known`); anything else — a `*.premigrate`, a `.resplit-tmp/`, a directory deeper down, a stray
// name — is listed in `skipped` with its reason.
const KNOWN = [
  [(n) => n === 'meta.json' || n === '.shard-state.json' || n === '.split-v2', (n) => n],
  [(n) => isSealedPath(n), () => 'sealed segment'],
  [(n) => n.endsWith('.closed'), () => 'close marker'],
  [(n) => n.endsWith('.sealing'), () => 'seal lock'],        // dead ones: cleanDeadLocks reports them
];
function whySkipped(name, isDir, fs, p) {
  if (isDir) {
    let n = '?'; try { n = fs.readdirSync(p).length; } catch {}
    const what = name === '.resplit-tmp' ? 'a leftover of an interrupted `asight shard --resplit`' : 'a directory two levels down';
    return `${what} — not descended into, nothing in it is sealed (${n} entr${n === 1 ? 'y' : 'ies'})`;
  }
  if (name.endsWith('.premigrate')) return 'the pre-split original an interrupted `asight shard --resplit` kept — not a stream any reader reads, so it is not sealed; finish or undo the resplit first';
  if (/^\..+\.\d+-[0-9a-f]{8}\.tmp$/.test(name)) return 'a temp of an interrupted seal — removed when its stream is sealed again';
  return 'not a record stream this entry seals (only *.ndjson) — left as it is';
}
export function legacyTargets(target, { fs = nodeFs } = {}) {
  const files = [], refused = [], dirs = [], skipped = [], known = {};
  const consider = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) refused.push({ file: p, reason: 'symlink — seal the file it points at, by its own path (unlinking a link would not remove the original)' });
    else if (st.isFile()) files.push(p);
    else skipped.push({ file: p, reason: 'named like a stream but not a regular file — not sealed' });
  };
  const other = (e, p, deep) => {
    const k = !e.isDirectory() && KNOWN.find(([is]) => is(e.name));
    if (k) { const kind = k[1](e.name); known[kind] = (known[kind] || 0) + 1; return; }
    skipped.push({ file: p, reason: e.isSymbolicLink() ? 'a symlink — not followed' : whySkipped(e.name, e.isDirectory() && deep, fs, p) });
  };
  const st = fs.lstatSync(target);
  if (!st.isDirectory()) {
    if (!target.endsWith('.ndjson')) refused.push({ file: target, reason: 'not an NDJSON capture stream (*.ndjson)' });
    else consider(target);
    return { files, refused, dirs: [path.dirname(target)], skipped, known };
  }
  dirs.push(target);
  for (const e of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(target, e.name);
    if (e.name.endsWith('.ndjson') && !e.isDirectory()) consider(p);
    else if (e.isSymbolicLink()) refused.push({ file: p, reason: 'symlinked directory — not followed; seal what it points at by its own path' });
    else if (e.isDirectory()) {
      dirs.push(p);
      for (const s of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const q = path.join(p, s.name);
        if (s.name.endsWith('.ndjson') && !s.isDirectory()) consider(q);
        else other(s, q, true);
      }
    } else other(e, p, false);
  }
  return { files, refused, dirs, skipped, known };
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
  const { files: named, refused, dirs, skipped, known } = legacyTargets(target, { fs });
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
  // The plan, per file: 'seal' (keeps the original), or — with --delete-original — 'delete' after a
  // byte-for-byte check against the copy it already has. --delete-original never seals: a file
  // without a verified copy of its own is refused, "seal first", so every deletion follows a seal the
  // operator ran and checked (review 3 F6). The dry run lists which case each file is.
  const plan = [];
  for (const f of quiet) {
    const pids = holders.get(f);
    if (pids && pids.length) { refused.push({ file: f, reason: `held open by pid ${pids.join(', ')} — it may still be written` }); continue; }
    // A sealed copy of an EARLIER version of this file (it grew since; the copy's bytes are still its
    // first bytes): sealing again would leave two copies of those lines, and deleting would trust a
    // copy that is not all of this file. Refuse. A copy of ANOTHER file that stood at this path (the
    // fresh calls.ndjson `asight shard --watch` writes after a deletion) is no reason to: it is the
    // only copy of its records, left alone, and this file is sealed as the next segment (review 3 F3).
    const copies = sameStreamCopies(fs, f);
    const stale = copies.filter((c) => c.rel === 'earlier');
    if (stale.length) { refused.push({ file: f, reason: `its sealed copy ${stale.map((c) => path.basename(c.file)).join(', ')} holds only its first ${stale[0].length} bytes (${stale[0].why}) — so the original still holds every byte of that copy. Check with \`asight raw verify\`, delete that copy, then seal again` }); continue; }
    const same = copies.filter((c) => c.rel === 'same').map((c) => c.file);
    if (!deleteOriginal) { plan.push({ file: f, action: 'seal' }); continue; }
    if (same.length) { plan.push({ file: f, action: 'delete', copies: same }); continue; }
    const others = copies.filter((c) => c.rel === 'other');
    refused.push({ file: f, reason: others.length
      ? `no sealed copy holds its current bytes — ${others.map((c) => path.basename(c.file)).join(', ')} ${others.length > 1 ? 'are copies' : 'is a copy'} of another file (${others[0].why}) and stays as it is. Seal this file first (without --delete-original), check with \`asight raw verify\`, then delete`
      : 'no sealed copy yet — --delete-original only deletes a file that already has one. Seal first (run without --delete-original), check with `asight raw verify`, then delete' });
  }
  for (const r of refused) appendJournal({ op: 'seal-legacy', outcome: 'refused', file: r.file, reason: r.reason }, { journal });
  for (const r of skipped) appendJournal({ op: 'seal-legacy', outcome: 'skipped', file: r.file, reason: r.reason }, { journal });
  if (Object.keys(known).length) appendJournal({ op: 'seal-legacy', outcome: 'skipped', target, reason: 'not a record stream', counts: known }, { journal });
  // locks of seals that died here (review 3 F10); never inside the old root
  const locks = dirs.filter((d) => !oldRootReason(d, { fs })).flatMap((d) => cleanDeadLocks(d, { fs, journal, dryRun }));
  if (dryRun) return { target, dryRun: true, plan, wouldSeal: plan.filter((x) => x.action === 'seal').map((x) => x.file), refused, locks, skipped, known };

  const sealed = [], deletedOnly = [], failed = [];
  // A file that changed since the quiet window is being written after all: refuse it, whatever step
  // we are at. Asked before each file and again between its byte-for-byte check and the unlink.
  const moved = (f) => { let now = null; try { now = fs.statSync(f); } catch {} return now && sameStat(before.get(f), now) ? null : 'changed after the quiet window — something is still writing it; nothing deleted'; };
  for (const { file: f, action, copies } of plan) {
    onFile(f);
    const m = moved(f);
    if (m) { refused.push({ file: f, reason: m }); appendJournal({ op: 'seal-legacy', outcome: 'refused', file: f, reason: m }, { journal }); continue; }
    if (action === 'seal') {
      // the sealer journals its own outcome, and replaces earlier copies of this exact source
      try { sealed.push(await sealUnchecked(f, { fs, split: false, deleteOriginal: false, journal, frameBytes })); }
      catch (e) { failed.push({ file: f, reason: e.message, originalKept: fs.existsSync(f) }); }
      continue;
    }
    const r = deleteVerified(fs, f, copies, { moved, journal });
    if (r.deleted && !r.error) deletedOnly.push({ file: f, copies });
    else if (r.refused) refused.push({ file: f, reason: r.refused });
    else failed.push({ file: f, reason: r.error, originalKept: !r.deleted, ...(r.deleted ? { state: r.state } : {}) });
  }
  return { target, sealed, deletedOnly, refused, failed, locks, skipped, known };
}

// Delete `f` after proving `copies` (copies of all of it, by content) byte for byte, durably: the
// copies' directories are fsync'd before the unlink, the original's after it (E5 order). Every outcome
// is journalled, a failure with the true state of the original — before the unlink "kept", after it
// "deleted, <the step that failed>" (review 3 F7). → { deleted, refused?, error?, state? }
function deleteVerified(fs, f, copies, { moved, journal }) {
  const v = verifyAgainst(copies, f, { fs });
  if (!v.ok) {
    const reason = `its sealed copy does not match it byte for byte (${v.reason}) — nothing deleted; check with \`asight raw verify\``;
    appendJournal({ op: 'verify', outcome: 'failed', file: f, sealed: copies, reason }, { journal });
    return { deleted: false, refused: reason };
  }
  let step = 'fsync of the sealed copy\'s directory';
  try {
    for (const dir of new Set(copies.map((c) => path.dirname(c)))) fsyncDir(fs, dir);
    const late = moved(f);
    if (late) { appendJournal({ op: 'delete-original', outcome: 'refused', file: f, reason: late }, { journal }); return { deleted: false, refused: late }; }
    step = 'unlink';
    fs.unlinkSync(f);
    step = 'removing its close marker';
    try { fs.unlinkSync(closedMarkerPath(f)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    step = 'fsync of its directory';
    fsyncDir(fs, path.dirname(f));
  } catch (e) {
    const deleted = !fs.existsSync(f);
    const state = deleted ? `original deleted, ${step} failed${step.startsWith('fsync') ? ' — the deletion may not survive a power cut; the sealed copy is durable' : ''}` : 'original kept';
    appendJournal({ op: 'delete-original', outcome: 'failed', file: f, against: copies, reason: `${step} failed: ${e.message}`, originalKept: !deleted, state }, { journal });
    return { deleted, error: `${step} failed: ${e.message}`, state };
  }
  appendJournal({ op: 'delete-original', outcome: 'ok', file: f, verified: 'byte-for-byte', against: copies, records: v.records, bytes: v.bytes }, { journal });
  return { deleted: true };
}

// How the CLI states a failed file: what happened to its original, never assumed (review 3 F7).
export const failureState = (x) => (x.originalKept === false ? (x.state || 'original deleted') : 'original kept');

// Sealed segments of `f`'s stream beside it whose only source has `f`'s name, each with its relation to
// the file now at that path (verify.mjs copyRelation): { file, length, rel: same|earlier|other, why }.
function sameStreamCopies(fs, f) {
  const dir = path.dirname(f), name = path.basename(f);
  return fs.readdirSync(dir).filter((n) => isSealedPath(n) && streamOfSealed(n) === name).map((n) => path.join(dir, n))
    .map((p) => { const s = sealedSources(p, { fs }); return s && s.length === 1 && s[0].name === name ? { file: p, length: s[0].length, ...copyRelation(s[0], f, { fs }) } : null; })
    .filter(Boolean);
}
