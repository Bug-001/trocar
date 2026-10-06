// src/query/raw-compare.mjs — `asight raw compare <dir>`: before originals are deleted, do the readers
// show over the sealed copies alone what they show now? (review 3 F1 · RFC 4.2 「watermark」, 4.6 E8)
//
// The real-run check this replaces compared `curl -s` of two `asight serve` processes. They were not
// listening yet (the resolver indexes everything before `listen`), so both sides were the empty
// string, which hashes equal: a check that could not fail. This one cannot pass vacuously. It goes
// through the readers' own functions, in-process, and fails when it compared nothing.
//
// The candidates are the delete entry's own: the files `asight raw seal --legacy <dir>` walks
// (legacy.mjs legacyTargets — every regular *.ndjson in the dir and one level down, no symlink), and
// of those the ones --delete-original would delete, by the deleter's OWN test (legacy.mjs planFile: a
// sealed copy whose content is all of the file), not by the readers' stat rule. They differ after a
// `touch`, in a tree copied without its times, for a stream the board does not read by name, for a
// directory that is no session (review 3, second pass on F1 and its confirm, row 1). A deletion nobody
// compared is what this tool exists to prevent, so one that falls in no group fails the compare.
// For each group — a session dir (any directory one level down but `control/`), a control class, a
// stream flat in the root:
//   deletable = those of the group's candidates;
//   before = the board's input list for the dir (discover.dirInputs — one copy per line, in record
//            order; ETL reads the same files one by one) with those originals' copies set aside: the
//            readers over the originals;
//   after  = the same list with those originals set aside instead: the readers over their copies,
//            i.e. what they will read after the deletion.
// Both sides are read with ingest.forEachLine — readRecords' own line source, for NDJSON and sealed
// files alike — one record at a time, and compared record by record: stream, id, ts and the sha256 of
// the line. Then the resolver (source.buildResolver, built once over the root as it is and once with
// the same exclusions) is asked for every id and must answer the same (status, fidelity, sha256 of
// the body). Memory: a small tuple per record of one group; a body is never held.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dirInputs, isSealedPath, streamOfSealed } from '../raw/discover.mjs';
import { forEachLine } from '../etl/ingest.mjs';
import { buildResolver } from './source.mjs';
import { appendJournal, defaultJournalPath } from '../raw/journal.mjs';
import { legacyTargets, planFile } from '../raw/legacy.mjs';
import { oldRootReason, cleanEmptyClaims } from '../raw/seal.mjs';

const SESSION_STREAMS = ['calls.ndjson', 'probes.ndjson', 'other.ndjson'];   // src/server.mjs, the board's order
const CONTROL = 'control';
const streamOf = (f) => (isSealedPath(f) ? streamOfSealed(f) : path.basename(f));
const sha = (s) => createHash('sha256').update(s).digest('base64');

// The groups of `root`: { group, kind, dir, originals, order, stream? }, built from the delete entry's
// own walk: `originals` are the candidates in the group's dir, plus the names the board reads there.
function groupsOf(root, fs, candidates, dirs) {
  const out = [];
  const byDir = new Map(dirs.map((d) => [d, []]));
  for (const f of candidates) { const d = path.dirname(f); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(path.basename(f)); }
  for (const [dir, cands] of byDir) {
    let names; try { names = fs.readdirSync(dir); } catch (err) { out.push({ group: path.relative(root, dir) || '.', kind: 'unreadable', dir, error: err.message }); continue; }
    const sealed = names.filter((n) => isSealedPath(n));
    if (dir === root || path.basename(dir) === CONTROL) {
      const kind = dir === root ? 'stream' : 'control';
      for (const st of [...new Set([...cands, ...sealed].map(streamOf))].sort()) out.push({ group: kind === 'stream' ? st : `${CONTROL}/${st}`, kind, dir, originals: cands, order: [], stream: st });
    } else if (cands.length || sealed.length || names.some((n) => SESSION_STREAMS.includes(n))) {
      out.push({ group: path.basename(dir), kind: 'session', dir, originals: [...new Set([...SESSION_STREAMS, ...cands])], order: SESSION_STREAMS });
    }
  }
  return out;
}

function inputs(g, fs, exclude = null) {
  const r = dirInputs(g.dir, { originals: g.originals, order: g.order, fs, exclude });
  const mine = (f) => !g.stream || streamOf(f) === g.stream;
  return { files: r.files.filter(mine), superseded: r.superseded.filter((x) => mine(x.original)), mismatched: r.mismatched.filter((x) => mine(x.original)) };
}

// One side, streamed: a tuple per non-blank line, plus what could not be read.
async function readSide(files) {
  const recs = [], stats = { blank: 0, malformed: 0, problems: [] };
  for (const f of files) {
    let rep;
    try { rep = await forEachLine(f, (text, stream) => {
      const t = text.trim();
      if (!t) { stats.blank++; return true; }
      let id = null, ts = null, bad = false;
      try { const v = JSON.parse(t); if (v && typeof v === 'object') { id = v.id == null ? null : String(v.id); ts = v.ts_request ?? v.ts ?? null; } }
      catch { bad = true; stats.malformed++; }
      recs.push({ stream, id, ts, h: sha(text), bad });
      return true;
    }); } catch (e) { stats.problems.push(`${f} could not be read: ${e.code || e.message}`); continue; }
    if (rep.sealedError) stats.problems.push(`${path.basename(f)} could not be opened: ${rep.sealedError}`);
    if (rep.unreadableRecords) stats.problems.push(`${path.basename(f)}: ${rep.unreadableRecords} record(s) unreadable (${rep.unreadable[0].reason})`);
  }
  return { recs, stats };
}

const desc = (x) => (x ? `${x.stream}#${x.id ?? '(no id)'}${x.ts ? ' @' + x.ts : ''}` : '(none)');
function firstDifference(b, a) {
  if (a.stats.problems.length || b.stats.problems.length) return { what: `unreadable — ${[...b.stats.problems.map((p) => 'now: ' + p), ...a.stats.problems.map((p) => 'after deletion: ' + p)].join('; ')}` };
  for (let i = 0; i < Math.max(b.recs.length, a.recs.length); i++) {
    const x = b.recs[i], y = a.recs[i];
    if (x && y && x.stream === y.stream && x.id === y.id && x.ts === y.ts && x.h === y.h) continue;
    const what = !y ? `after deletion ${b.recs.length - a.recs.length} record(s) fewer` : !x ? `after deletion ${a.recs.length - b.recs.length} record(s) more`
      : x.id === y.id && x.stream === y.stream ? 'same record id, other bytes' : 'another record at this position (order or content)';
    return { at: i, what, before: desc(x), after: desc(y) };
  }
  if (b.stats.blank !== a.stats.blank) return { what: `${b.stats.blank} blank line(s) now, ${a.stats.blank} after deletion` };
  return null;
}

function outcome(resolve, ref) {
  try {
    const d = resolve.detail(ref);
    return `${d.status}|${d.fidelity || ''}|${d.status === 'ok' ? sha(d.text) : ''}`;
  } catch (e) { return /ambiguous/i.test(String(e && e.message)) ? 'ambiguous' : 'error'; }
}

// → { root, groups: [{ group, kind, status: same|diff|not-covered|sealed-only, records, uncovered,
//     deletable, diff?, resolver: { checked, diff? }, notes }], compared, ok }
export async function compareTree(root, { fs = nodeFs, onGroup = () => {}, resolverOf = buildResolver, groupsHook = (gs) => gs } = {}) {
  if (!fs.statSync(root).isDirectory()) throw new Error(`asight raw compare takes a directory (${root} is not one)`);
  const t = legacyTargets(root, { fs });
  const candidates = t.files.filter((f) => !oldRootReason(f, { fs }));
  // empty claims the delete run removes before it plans (row 7): no records, set aside on both sides
  const claims = candidates.flatMap((f) => cleanEmptyClaims(fs, path.dirname(f), path.basename(f), null, { dryRun: true }));
  const ignore = new Set(claims.map((c) => c.file));
  const plans = new Map(candidates.map((f) => [f, planFile(fs, f, { deleteOriginal: true, ignore })]));
  const willDelete = candidates.filter((f) => plans.get(f).action === 'delete');
  // a directory the walk could not read: its originals cannot be compared — a difference, by name (row 4)
  const unreadableDirs = t.refused.filter((r) => r.unreadable).map((r) => ({ group: path.relative(root, r.file) || '.', kind: 'unreadable', dir: r.file, error: r.reason }));
  const groups = groupsHook([...groupsOf(root, fs, candidates, t.dirs), ...unreadableDirs]).map((g) => {
    if (g.kind === 'unreadable') return { ...g, status: 'diff', diff: { what: `directory unreadable: ${g.dir} ${g.error}` } };
    const mine = g.originals.map((n) => path.join(g.dir, n)).filter((f) => plans.has(f) && (!g.stream || streamOf(f) === g.stream));
    const deletable = mine.filter((f) => plans.get(f).action === 'delete');
    // what the readers do NOW, for the notes: a pair they read twice (a touched original) is said
    const now = inputs(g, fs, ignore);
    const claimNotes = claims.filter((c) => path.dirname(c.file) === g.dir && (!g.stream || streamOf(c.file) === g.stream))
      .map((c) => `${path.basename(c.file)}: ${c.reason} — --delete-original removes it first; not read on either side`);
    // an original that cannot be read: what the readers show now cannot be known — a difference (row 4)
    const bad = mine.filter((f) => plans.get(f).unreadable);
    if (bad.length) return { ...g, deletable: [], uncovered: mine, why: Object.fromEntries(mine.map((f) => [f, plans.get(f).refused || 'not compared: another original of this group could not be read'])), status: 'diff', diff: { what: `unreadable — ${bad.map((f) => `${f} ${plans.get(f).refused}`).join('; ')}` } };
    return { ...g, deletable, copies: deletable.flatMap((f) => plans.get(f).copies), uncovered: mine.filter((f) => !deletable.includes(f)),
      why: Object.fromEntries(mine.filter((f) => !deletable.includes(f)).map((f) => [f, plans.get(f).refused])), notes: [...claimNotes, ...now.mismatched.map((m) => `now: ${path.basename(m.sealed)}: ${m.why}`)] };
  });
  // a file --delete-original would delete that no group compares: never passed over (row 1)
  const placed = new Set(groups.flatMap((g) => g.deletable || []));
  const orphans = willDelete.filter((f) => !placed.has(f));
  if (orphans.length) groups.push({ group: '(in no group)', kind: 'not-compared', notCompared: orphans, status: 'diff',
    diff: { what: `${orphans.length} original(s) --delete-original would delete are in no compared group: ${orphans.join(', ')}` } });
  const all = new Set(groups.flatMap((g) => g.deletable || [])), copies = new Set(groups.flatMap((g) => g.copies || []));
  let rb = null, ra = null;
  if (all.size) { rb = await resolverOf(root, { exclude: new Set([...copies, ...ignore]) }); ra = await resolverOf(root, { exclude: new Set([...all, ...ignore]) }); }
  const out = [];
  let compared = 0;
  try {
    for (const g of groups) {
      const r = { group: g.group, kind: g.kind, status: g.status, records: 0, deletable: g.deletable || [], uncovered: g.uncovered || [], why: g.why || {}, notes: g.notes || [], resolver: { checked: 0 },
        ...(g.notCompared ? { notCompared: g.notCompared } : {}), ...(g.diff ? { diff: g.diff } : {}) };
      if (!r.status) {
        if (!r.deletable.length) r.status = r.uncovered.length ? 'not-covered' : 'sealed-only';
        else {
          const b = await readSide(inputs(g, fs, new Set([...g.copies, ...ignore])).files);
          const a = await readSide(inputs(g, fs, new Set([...r.deletable, ...ignore])).files);
          r.records = b.recs.length;
          r.diff = firstDifference(b, a);
          if (!r.diff) {
            const sid = g.kind === 'session' ? g.group : CONTROL;
            for (const x of b.recs) {
              if (x.id == null || x.bad) continue;
              const ref = `${sid}/${x.stream}#${x.id}`, o1 = outcome(rb, ref), o2 = outcome(ra, ref);
              r.resolver.checked++;
              if (o1 !== o2) { r.resolver.diff = { ref, before: o1.split('|')[0], after: o2.split('|')[0] }; r.diff = { what: `the resolver answers ${ref} differently (now ${o1.split('|')[0]}, after deletion ${o2.split('|')[0]})` }; break; }
            }
          }
          r.status = r.diff ? 'diff' : 'same';
          compared += r.records;
        }
      }
      out.push(r);
      onGroup(r);
    }
  } finally { if (rb) rb.dispose(); if (ra) ra.dispose(); }
  return { root, groups: out, compared, ok: compared > 0 && !out.some((g) => g.status === 'diff') };
}

// The CLI's compare: every difference, and the run itself, leave a durable record (D38).
export async function runCompare({ root, fs = nodeFs, journal = defaultJournalPath(), onGroup }) {
  let res;
  try { res = await compareTree(root, { fs, onGroup }); } catch (e) {
    appendJournal({ op: 'compare', outcome: 'failed', root, reason: `${e.message} — nothing compared` }, { journal });
    throw e;
  }
  for (const g of res.groups) {
    if (g.uncovered.length) appendJournal({ op: 'compare', outcome: 'not-covered', root, group: g.group, files: g.uncovered, reasons: g.uncovered.map((f) => g.why[f]), reason: 'no sealed copy of these files passes the deleter\'s test — not compared; --delete-original refuses them' }, { journal });
    if (g.notCompared) appendJournal({ op: 'compare', outcome: 'not-compared', root, files: g.notCompared, reason: g.diff.what }, { journal });
    if (g.status === 'diff') appendJournal({ op: 'compare', outcome: 'diff', root, group: g.group, reason: g.diff.what, ...(g.diff.at != null ? { at: g.diff.at, before: g.diff.before, after: g.diff.after } : {}) }, { journal });
    for (const n of g.notes) appendJournal({ op: 'compare', outcome: 'note', root, group: g.group, reason: n }, { journal });
  }
  const count = (s) => res.groups.filter((g) => g.status === s).length;
  appendJournal({ op: 'compare', outcome: res.ok ? 'ok' : 'failed', root, compared: res.compared, groups: res.groups.length, same: count('same'), diff: count('diff'),
    notCovered: res.groups.reduce((n, g) => n + g.uncovered.length, 0), deletable: res.groups.reduce((n, g) => n + g.deletable.length + (g.notCompared || []).length, 0),
    ...(res.compared ? {} : { reason: 'nothing compared: no original here has a sealed copy' }) }, { journal });
  return res;
}
