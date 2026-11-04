// src/query/named/calls.mjs — `trocar query calls` (RFC 1.6 §4.1, 附录 C.5).
//
// Any class of call, not only inference (D40). Without `--class` / `--host` / `--ref` it is the class table. With
// one of them it is the calls themselves: filtered, counted and paged on the SEGMENT INDEX alone, and only the
// page's records are read back, one seek each (3.5 §访问模式, D62②) — in the detail panel's shape
// (src/view/control-wire.mjs, the one reshaping rule), newest first by ts (C.5), a page's first few with their bodies, under the index
// facts C.5 names.
import { parseRecordId } from '../../collector/core/record/segments.mjs';
import { controlRecordWire, CONTROL_DETAIL_RECORDS } from '../../view/control-wire.mjs';
import { recordsAt } from '../records.mjs';
import { posCmp } from '../projection.mjs';
import { asOf, indexRows } from '../rows.mjs';
import { QueryArgError, listOf, paginate, tsFilter } from './index.mjs';
import { HARNESS, PAGE, WINDOW } from './about.mjs';

export const about = Object.freeze({
  summary: 'Calls of any class: time, agent, class, host, endpoint, status, bytes sent and received, how much was kept, record id. Without --class, --host or --ref it gives only how many calls each class has.',
  params: Object.freeze({
    class: 'Only these traffic classes: comma-separated names, as the classes query lists them.',
    harness: HARNESS,
    session: 'Only these sessions: comma-separated session ids, as the sessions query lists them.',
    host: 'Only these hosts: comma-separated names.',
    ref: 'Only this record: a record id (segment:line). The answer has the same shape as a list.',
    ...WINDOW,
    ...PAGE,
    reveal: 'The name of one credential header of the record --ref names: gives that one value, which every answer otherwise leaves empty. Needs --ref. It is for a person pressing Show at the board, not for scripts.',
  }),
});
export const params = Object.freeze(Object.keys(about.params));

export async function run({ home, fs, now, params: p, errors, progress = null }) {
  if (p.ref != null && !parseRecordId(String(p.ref))) throw new QueryArgError(`trocar query calls: --ref ${JSON.stringify(String(p.ref))} names no record — a record is \`<segment>:<line>\``);
  // `reveal` shows one credential-class header's value of one record (2.6 §保真边界 2): only with `ref`
  if (p.reveal != null && p.ref == null) throw new QueryArgError('trocar query calls: --reveal needs --ref — it shows one header of one record');
  const reveal = p.reveal != null ? String(p.reveal).trim().toLowerCase() : null;
  const keep = tsFilter(p, now), cls = listOf(p.class), harness = listOf(p.harness), sess = listOf(p.session),
    host = listOf(p.host), ref = listOf(p.ref);
  // Through the ONE warm, stat-revalidated reading of the index (src/query/rows.mjs, which `sessions` and `session` ask too).
  const all = await indexRows({ home, fs, errors, progress });
  const as_of = asOf(all);
  // --harness is the harness `sessions` decided (proc, else the UA), and the session is the one `sessions` grouped by (C.5)
  const rows = all.filter((r) => keep(r.ts) && (!harness || harness.has(r.harness_id)) && (!sess || sess.has(r.session_id))
    && (!cls || cls.has(r.class)) && (!host || host.has(r.host)) && (!ref || ref.has(r.id)));

  if (!cls && !host && !ref) {
    const counts = new Map();
    for (const r of rows) counts.set(r.class, (counts.get(r.class) || 0) + 1);
    return { as_of, classes: [...counts].map(([c, count]) => ({ class: c, count })) };
  }

  // newest first by ts; one ts: the later record first; no ts: last (C.5)
  const at = new Map(rows.map((r) => { const t = Date.parse(r.ts); return [r, Number.isNaN(t) ? -Infinity : t]; }));
  rows.sort((a, b) => (at.get(b) - at.get(a)) || posCmp(String(b.id), String(a.id)));
  if (ref && !rows.length) errors.push({ where: String(p.ref), reason: `no record ${p.ref} in this home's segment index` });
  const { items, next, has_more } = paginate(rows, p, { bytes: (r) => r.stored_bytes || 0 }); // the page's records are read back: bounded by bytes too
  const byId = new Map(items.map((r) => [r.id, r]));
  const recs = recordsAt({ home, fs, rows: items, errors });
  return {
    as_of, ...(p.class != null ? { class: p.class } : {}), total: rows.length, detail_limit: CONTROL_DETAIL_RECORDS,
    records: recs.map((rec, i) => {
      const r = byId.get(rec.id);
      return { ...controlRecordWire(rec, { detail: i < CONTROL_DETAIL_RECORDS, reveal }),
        id: r.id, ts: r.ts, harness: r.harness_id, class: r.class, host: r.host, endpoint: r.path, status: r.status,
        sent_bytes: r.sent_bytes, received_bytes: r.received_bytes, retention: r.log_only ? 'log' : 'full', ref: r.id };
    }),
    next, has_more,
  };
}
