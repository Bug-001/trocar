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
import { segmentFiles, warmSegmentIndex, problemEntry } from './index-build.mjs';
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
const lists = warmCache({ max: 4, cost: (v) => v.rows.length * ROW_HEAP });
const entryIds = new WeakMap();
let entrySeq = 0;
const entryId = (records) => { let n = entryIds.get(records); if (n == null) entryIds.set(records, (n = ++entrySeq)); return n; };
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
    segs.push({ segment, records, entry: entryId(records) });
  }
  const stamp = segs.map((s) => `${s.segment}#${s.entry}`).join('\n');
  return lists.get(`${fsTag(fs)}\n${home}`, stamp, (old) => rowList(segs, old)).rows;
}
function rowList(segs, old) {
  let i = 0;
  if (old) while (i < segs.length && i < old.segs.length && old.segs[i].segment === segs[i].segment && old.segs[i].entry === segs[i].entry) i++;
  const out = i ? old.rows.slice(0, old.segs[i - 1].end) : [];
  const open = i ? copyOpen(old.segs[i - 1].open) : new Map();
  const assign = createSynthAssigner({ open });
  const done = old ? old.segs.slice(0, i) : [];
  for (const { segment, records, entry } of segs.slice(i)) {
    for (const r of records) {
      const synth = r.synth_hash ? assign({ harness: r.harness_id, hash: r.synth_hash, ms: Date.parse(r.ts || '') }) : null;
      out.push({ ...r, segment, lineNo: Number(String(r.id).split(':').pop()), session_id: r.session_key ?? synth ?? null, synthesized: !!synth });
    }
    done.push({ segment, entry, end: out.length, open: copyOpen(open) });
  }
  return { rows: Object.freeze(out), segs: done };
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
  const g = new Map();
  for (const r of rows) {
    if (!r.session_id) continue;
    if (!g.has(r.session_id)) g.set(r.session_id, []);
    g.get(r.session_id).push(r);
  }
  groups.set(rows, g);
  return g;
}

const isProbe = (r) => /count_tokens/.test(r.path || '');

/** Which index rows are a MODEL CALL: the one rule every reader counts calls with (sessionFactsOf below,
 *  `overview`'s usage and the usage sidecar's fill), never a second copy of it. */
export const isModelCall = (r) => r.is_llm && !r.log_only;

/** One session's facts, the way src/view/board.mjs derives them from the records themselves (sessionMetaFor):
 *  the harness of the first row that had `proc`, else of the first that had headers; the entrypoint of the
 *  first row that had headers; calls / logged / probes / other complementary, so they sum to the session. */
export function sessionFactsOf(id, rows) {
  const first = rows.find((r) => r.has_proc) || rows.find((r) => r.has_headers);
  const harness = first ? first.harness_id : null;
  const withHeaders = rows.find((r) => r.has_headers);
  return {
    session_id: id,
    entrypoint: withHeaders ? withHeaders.entrypoint : null,
    harness,
    harness_inferred: !!(first && first.harness_inferred),
    // a harness that can be pointed at ANY backend has no provider unless the wire showed one (gate G10)
    provider: harness == null ? null : LEGACY_PROVIDER[harness] ?? rows.map((r) => wireProviderOfEndpoint(r.path)).find(Boolean) ?? null,
    calls: rows.filter(isModelCall).length,
    logged: rows.filter((r) => r.is_llm && r.log_only).length,
    probes: rows.filter(isProbe).length,
    other: rows.filter((r) => !r.is_llm && !isProbe(r)).length,
    has_subagent: rows.some((r) => r.subagent),
    last_ts: rows.reduce((m, r) => (String(r.ts || '') > m ? String(r.ts || '') : m), ''),
    session_synthesized: rows.some((r) => r.synthesized),
  };
}
