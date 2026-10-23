// src/query/rows.mjs — the segment index as ONE list of rows, and which session each row belongs to.
//
// `sessions` and `session` must agree on membership, so it is computed here once (3.4: membership is a
// read-side decision) and both ask this module: `sessions` counts the rows, `session` reads back only the
// records of the one session it was asked for. Nothing here parses a record: a row is what the segment
// index already stored (src/query/index-build.mjs), which is why `sessions` can meet its ≤ 1 s budget on
// 1 GB (1.6 §4.1 速度目标) where reading every record back cost 4.5 s on Windows and 7 s on macOS.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createSynthAssigner } from '../dissect/synth-key.mjs';
import { LEGACY_PROVIDER, wireProviderOfEndpoint } from '../dissect/harnesses.mjs';
import { segmentFiles, warmSegmentIndex, problemEntry, recordsId, grownFrom } from './index-build.mjs';
import { trocarHome } from '../paths.mjs';
import { warmCache, fsTag } from './warm.mjs';

// WARM (D63 ①, 1.6 §4.1 附近的查询): the rows of one segment come from the ONE warm reading of its index
// (src/query/index-build.mjs `warmSegmentIndex`, which `allSegments` reads through as well), kept against that
// segment's own source file, so a line appended to the live segment is never missed. The segment list is the names in
// raw/ (`segmentFiles`), read each time, and every segment's problems are said by each read: a note about the read that indexed
// a segment (`index-cold`) reaches this read's `errors` and no later one.

export const namesStamp = (home, fs) => { try { return fs.readdirSync(path.join(home, 'raw')).sort().join('\n'); } catch { return ''; } };

// The row list itself is kept per home (3.5 §缓存按依赖失效): a poll of the board asks for it every 1.5 s, and building 27 k row
// objects costs 20-50 ms when nothing moved. It is rebuilt from the first segment whose warm index entry is not the one it was
// built from (the live segment is the last, so usually only its rows), with the synthesized-key rule resumed from the state it had
// after the segment before; nothing moved → the SAME (frozen) array, so sessionGroups' memo below holds too.
const ROW_HEAP = 400; // a row object here: the segment's ~320 B row (index-build.mjs segRows) plus segment / lineNo / session_id
const lists = warmCache({ max: 4, cost: (v) => v.rows.length * ROW_HEAP, steady: true });
const copyOpen = (open) => new Map([...open].map(([k, v]) => [k, { ...v }])); // the rule moves `lastMs` in place

/**
 * indexRows({home, fs, errors}) → [{…index row, segment, lineNo, session_id}], oldest segment first,
 * capture order inside a segment — the order the synthesized keys (3.4 合成键) are assigned in, the same
 * order the board stamps them in, so both name a session the same. Frozen: it is shared by every reader until a segment moves.
 * What a segment could not say goes into `errors` (D38), never silently missing — on every call.
 */
export async function indexRows({ home = trocarHome(), fs = nodeFs, errors = [] } = {}) {
  const segs = [];
  for (const [segment] of segmentFiles(home, fs)) {
    const { records, problems } = await warmSegmentIndex({ home, segment, fs });
    for (const pr of problems) errors.push(problemEntry(`segments/${segment}`, pr));
    segs.push({ segment, records, entry: recordsId(records) });
  }
  const stamp = segs.map((s) => `${s.segment}#${s.entry}`).join('\n');
  return lists.get(`${fsTag(fs)}\n${home}`, stamp, (old) => rowList(segs, old)).rows;
}
function rowList(segs, old) {
  let i = 0;
  if (old) while (i < segs.length && i < old.segs.length && old.segs[i].segment === segs[i].segment && old.segs[i].entry === segs[i].entry) i++;
  // only the newest segment grew, and its records begin with the ones its rows were built from (index-build.mjs grownFrom): its
  // rows so far stay, and its new records are added, the synthesized-key rule resumed from where those rows left it (3.5:45)
  const grown = !!old && i === segs.length - 1 && i === old.segs.length - 1 && old.segs[i].segment === segs[i].segment && grownFrom(segs[i].records) === old.segs[i].entry;
  const kept = grown ? i + 1 : i;
  const out = kept ? old.rows.slice(0, old.segs[kept - 1].end) : [];
  const open = kept ? copyOpen(old.segs[kept - 1].open) : new Map();
  const assign = createSynthAssigner({ open });
  const done = old ? old.segs.slice(0, i) : [];
  for (const { segment, records, entry } of segs.slice(i)) {
    for (let k = out.length - (done.length ? done[done.length - 1].end : 0); k < records.length; k++) {
      const r = records.at(k).toJSON(); // a row copy until the row list is columns too (S3)
      const synth = r.synth_hash ? assign({ harness: r.harness_id, hash: r.synth_hash, ms: Date.parse(r.ts || '') }) : null;
      out.push({ ...r, segment, lineNo: Number(String(r.id).split(':').pop()), session_id: r.session_key ?? synth ?? null, synthesized: !!synth });
    }
    done.push({ segment, entry, end: out.length, open: copyOpen(open) });
  }
  const rows = Object.freeze(out);
  // the groups of the rows before, when they were asked for, grow by the new rows: a new member array only for a session that got
  // rows, the others the same arrays (sessionGroups below)
  const was = grown && groups.get(old.rows);
  if (was) groups.set(rows, addGroups(new Map(was), rows, old.rows.length, true));
  return { rows, segs: done };
}

/** as_of (附录 C.5): the newest call time in the WHOLE index — what every number of an index-reading document is
 *  counted as of (invariant 4); null when the index has no row with a time. */
export const asOf = (rows) => rows.reduce((m, r) => (r.ts && (m == null || String(r.ts) > m) ? String(r.ts) : m), null);

// The groups of one row list: `session` asks for them right after `sessions` did, over the same array (D63 ①).
const groups = new WeakMap();
/** The rows of every session, in the order the sessions were first seen. A row with no session id is the
 *  session-less control plane (telemetry / config / account) and is in no group. */
export function sessionGroups(rows) {
  const was = groups.get(rows);
  if (was) return was;
  const g = addGroups(new Map(), rows, 0, false);
  groups.set(rows, g);
  return g;
}
// `g` with the rows from `from` on added; `shared` = its arrays are another list's groups', copied before the first push
function addGroups(g, rows, from, shared) {
  const own = shared ? new Set() : null;
  for (let k = from; k < rows.length; k++) {
    const r = rows[k];
    if (!r.session_id) continue;
    let m = g.get(r.session_id);
    if (!m) { g.set(r.session_id, (m = [])); if (own) own.add(m); }
    else if (own && !own.has(m)) { g.set(r.session_id, (m = m.slice())); own.add(m); }
    m.push(r);
  }
  return g;
}

const isProbe = (r) => /count_tokens/.test(r.path || '');

/** Which index rows are a MODEL CALL: the one rule every reader counts calls with (sessionFactsOf below,
 *  `overview`'s usage and the usage sidecar's fill), never a second copy of it. */
export const isModelCall = (r) => r.is_llm && !r.log_only;

/** sessionFacts(id) → {add(row), facts()}: one session's facts over the rows added so far, in member order, the way
 *  src/view/board.mjs derives them from the records themselves (sessionMetaFor): the harness of the first row that had `proc`, else
 *  of the first that had headers; the entrypoint of the first row that had headers; calls / logged / probes / other complementary,
 *  so they sum to the session. A growing session adds its new members only (src/query/named/session.mjs). */
export function sessionFacts(id) {
  let proc = null, headers = null, wire = null, calls = 0, logged = 0, probes = 0, other = 0, sub = false, last = '', synth = false;
  return {
    add(r) {
      if (!proc && r.has_proc) proc = r;
      if (!headers && r.has_headers) headers = r;
      if (!wire) wire = wireProviderOfEndpoint(r.path) || null;
      if (isModelCall(r)) calls++; else if (r.is_llm) logged++;
      if (isProbe(r)) probes++; else if (!r.is_llm) other++;
      if (r.subagent) sub = true;
      if (String(r.ts || '') > last) last = String(r.ts || '');
      if (r.synthesized) synth = true;
    },
    facts() {
      const first = proc || headers, harness = first ? first.harness_id : null;
      return {
        session_id: id,
        entrypoint: headers ? headers.entrypoint : null,
        harness,
        harness_inferred: !!(first && first.harness_inferred),
        // a harness that can be pointed at ANY backend has no provider unless the wire showed one (gate G10)
        provider: harness == null ? null : LEGACY_PROVIDER[harness] ?? wire ?? null,
        calls, logged, probes, other,
        has_subagent: sub,
        last_ts: last,
        session_synthesized: synth,
      };
    },
  };
}
/** One session's facts over its rows (sessionFacts). */
export function sessionFactsOf(id, rows) {
  const f = sessionFacts(id);
  for (const r of rows) f.add(r);
  return f.facts();
}
