// src/query/named/calls.mjs — `asight query calls` (RFC 1.6 §4.1, 附录 C.5).
//
// Any class of call, not only inference (D40). Without `--class` it is the class table — counted from
// the segment index alone, no body read. With `--class` it is the calls themselves, in the detail
// panel's shape (src/view/control-wire.mjs, the one reshaping rule), newest few with their bodies.
import { stampSynthKeys } from '../../dissect/synth-key.mjs';
import { sessionIdOf } from '../../view/assemble.mjs';
import { controlRecordWire, CONTROL_DETAIL_RECORDS } from '../../view/control-wire.mjs';
import { allSegments, segmentIndex } from '../index-build.mjs';
import { allRecords } from '../records.mjs';
import { listOf, paginate, tsFilter } from './index.mjs';

export const params = Object.freeze(['class', 'harness', 'session', 'since', 'until', 'limit', 'cursor']);

export async function run({ home, fs, now, params: p, errors }) {
  const keep = tsFilter(p, now), cls = listOf(p.class), harness = listOf(p.harness), sess = listOf(p.session);

  if (!cls) {
    const counts = new Map();
    for (const s of await allSegments({ home, fs })) {
      for (const pr of s.problems) errors.push({ where: `segments/${s.segment}`, reason: `${pr.code}: ${pr.reason}` });
      const { records } = await segmentIndex({ home, segment: s.segment, fs });
      for (const r of records) {
        if (!keep(r.ts) || (harness && !harness.has(r.harness)) || (sess && !sess.has(r.session_key))) continue;
        counts.set(r.class, (counts.get(r.class) || 0) + 1);
      }
    }
    return { classes: [...counts].map(([c, count]) => ({ class: c, count })) };
  }

  // the session a record belongs to is read-side (3.4): a keyless inference call gets its synthesized key first
  const recs = stampSynthKeys(await allRecords({ home, fs, errors }));
  const list = recs.filter((r) => cls.has(r.traffic_class) && keep(r.ts_request ?? r.ts)
    && (!harness || harness.has((r.proc || {}).agent)) && (!sess || sess.has(sessionIdOf(r))));
  const { items, next, has_more } = paginate(list, p);
  const slimBefore = Math.max(0, items.length - CONTROL_DETAIL_RECORDS);
  return {
    class: p.class, total: list.length, detail_limit: CONTROL_DETAIL_RECORDS,
    records: items.map((r, i) => controlRecordWire(r, { detail: i >= slimBefore })),
    next, has_more,
  };
}
