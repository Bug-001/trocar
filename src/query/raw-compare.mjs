// src/query/raw-compare.mjs — `asight raw compare <dir>`: before originals are deleted, do the readers
// show over the sealed copies alone what they show now? (review 3 F1 · RFC 4.2 「watermark」, 4.6 E8)
//
// The real-run check this replaces compared `curl -s` of two `asight serve` processes. They were not
// listening yet (the resolver indexes everything before `listen`), so both sides were the empty
// string, which hashes equal: a check that could not fail. This one cannot pass vacuously. It goes
// through the readers' own functions, in-process, and fails when it compared nothing.
//
// For each group — a session dir, a control class, a stream flat in the root:
//   deletable = the originals `asight raw seal --legacy --delete-original` would delete — decided by
//            the deleter's OWN test (legacy.mjs sameStreamCopies: a sealed copy whose content is all
//            of the file), not by the readers' stat rule. They differ after a `touch` or in a tree
//            copied without its times, and a deletion nobody compared is what this tool exists to
//            prevent (review 3, second pass on F1);
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
import { sameStreamCopies } from '../raw/legacy.mjs';

const SESSION_STREAMS = ['calls.ndjson', 'probes.ndjson', 'other.ndjson'];   // src/server.mjs, the board's order
const CONTROL = 'control';
const streamOf = (f) => (isSealedPath(f) ? streamOfSealed(f) : path.basename(f));
const sha = (s) => createHash('sha256').update(s).digest('base64');

// The groups of `root`: { group, kind, dir, originals, order, stream? }.
function groupsOf(root, fs) {
  const out = [];
  const ents = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  const flat = ents.filter((e) => !e.isDirectory() && (e.name.endsWith('.ndjson') || isSealedPath(e.name))).map((e) => e.name);
  for (const st of [...new Set(flat.map(streamOf))].sort()) out.push({ group: st, kind: 'stream', dir: root, originals: flat.filter((n) => n.endsWith('.ndjson')), order: [], stream: st });
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let names; try { names = fs.readdirSync(dir); } catch (err) { out.push({ group: e.name, kind: 'unreadable', dir, error: err.message }); continue; }
    if (e.name === CONTROL) {
      const originals = names.filter((n) => n.endsWith('.ndjson'));
      for (const st of [...new Set(names.filter((n) => n.endsWith('.ndjson') || isSealedPath(n)).map(streamOf))].sort()) out.push({ group: `${CONTROL}/${st}`, kind: 'control', dir, originals, order: [], stream: st });
    } else if (names.some((n) => SESSION_STREAMS.includes(n) || isSealedPath(n))) {
      out.push({ group: e.name, kind: 'session', dir, originals: SESSION_STREAMS, order: SESSION_STREAMS });
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
    const rep = await forEachLine(f, (text, stream) => {
      const t = text.trim();
      if (!t) { stats.blank++; return true; }
      let id = null, ts = null, bad = false;
      try { const v = JSON.parse(t); if (v && typeof v === 'object') { id = v.id == null ? null : String(v.id); ts = v.ts_request ?? v.ts ?? null; } }
      catch { bad = true; stats.malformed++; }
      recs.push({ stream, id, ts, h: sha(text), bad });
      return true;
    });
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
export async function compareTree(root, { fs = nodeFs, onGroup = () => {}, resolverOf = buildResolver } = {}) {
  const groups = groupsOf(root, fs).map((g) => {
    if (g.kind === 'unreadable') return { ...g, status: 'diff', diff: { what: `directory unreadable: ${g.error}` } };
    const present = g.originals.map((n) => path.join(g.dir, n)).filter((f) => (!g.stream || streamOf(f) === g.stream) && fs.existsSync(f));
    const deletable = [], copies = [];
    for (const f of present) {
      const same = sameStreamCopies(fs, f).filter((c) => c.rel === 'same').map((c) => c.file);
      if (same.length) { deletable.push(f); copies.push(...same); }
    }
    // what the readers do NOW, for the notes: a pair they read twice (a touched original) is said
    const now = inputs(g, fs);
    return { ...g, deletable, copies, uncovered: present.filter((f) => !deletable.includes(f)), notes: now.mismatched.map((m) => `now: ${path.basename(m.sealed)}: ${m.why}`) };
  });
  const all = new Set(groups.flatMap((g) => g.deletable || [])), copies = new Set(groups.flatMap((g) => g.copies || []));
  let rb = null, ra = null;
  if (all.size) { rb = await resolverOf(root, { exclude: copies }); ra = await resolverOf(root, { exclude: all }); }
  const out = [];
  let compared = 0;
  try {
    for (const g of groups) {
      const r = { group: g.group, kind: g.kind, status: g.status, records: 0, deletable: g.deletable || [], uncovered: g.uncovered || [], notes: g.notes || [], resolver: { checked: 0 }, ...(g.diff ? { diff: g.diff } : {}) };
      if (!r.status) {
        if (!r.deletable.length) r.status = r.uncovered.length ? 'not-covered' : 'sealed-only';
        else {
          const b = await readSide(inputs(g, fs, new Set(g.copies)).files);
          const a = await readSide(inputs(g, fs, new Set(r.deletable)).files);
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
  const res = await compareTree(root, { fs, onGroup });
  for (const g of res.groups) {
    if (g.uncovered.length) appendJournal({ op: 'compare', outcome: 'not-covered', root, group: g.group, files: g.uncovered, reason: 'no sealed copy holds these files\' bytes — not compared; --delete-original refuses them' }, { journal });
    if (g.status === 'diff') appendJournal({ op: 'compare', outcome: 'diff', root, group: g.group, reason: g.diff.what, ...(g.diff.at != null ? { at: g.diff.at, before: g.diff.before, after: g.diff.after } : {}) }, { journal });
    for (const n of g.notes) appendJournal({ op: 'compare', outcome: 'note', root, group: g.group, reason: n }, { journal });
  }
  const count = (s) => res.groups.filter((g) => g.status === s).length;
  appendJournal({ op: 'compare', outcome: res.ok ? 'ok' : 'failed', root, compared: res.compared, groups: res.groups.length, same: count('same'), diff: count('diff'),
    notCovered: count('not-covered'), deletable: res.groups.reduce((n, g) => n + g.deletable.length, 0),
    ...(res.compared ? {} : { reason: 'nothing compared: no original here has a sealed copy' }) }, { journal });
  return res;
}
