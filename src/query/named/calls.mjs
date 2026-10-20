// src/query/named/calls.mjs — `trocar query calls` (RFC 1.6 §4.1, 附录 C.5).
//
// Any class of call, not only inference (D40). Without `--class` / `--host` / `--ref` it is the class table. With
// one of them it is the calls themselves: filtered, counted and paged on the SEGMENT INDEX alone, and only the
// page's records are read back, one seek each (3.5 §访问模式, D62②) — in the detail panel's shape
// (src/view/control-wire.mjs, the one reshaping rule), the newest few with their bodies, under the index facts C.5 names.
import { parseRecordId } from '../../collector/core/record/segments.mjs';
import { controlRecordWire, CONTROL_DETAIL_RECORDS } from '../../view/control-wire.mjs';
import { recordsAt } from '../records.mjs';
import { asOf, indexRows } from '../rows.mjs';
import { QueryArgError, listOf, paginate, tsFilter } from './index.mjs';

export const params = Object.freeze(['class', 'harness', 'session', 'host', 'ref', 'since', 'until', 'limit', 'after', 'reveal']);

export async function run({ home, fs, now, params: p, errors }) {
  if (p.ref != null && !parseRecordId(String(p.ref))) throw new QueryArgError(`trocar query calls: --ref ${JSON.stringify(String(p.ref))} names no record — a record is \`<segment>:<line>\``);
  // `reveal` shows one credential-class header's value of one record (2.6 §保真边界 2): only with `ref`
  if (p.reveal != null && p.ref == null) throw new QueryArgError('trocar query calls: --reveal needs --ref — it shows one header of one record');
  const reveal = p.reveal != null ? String(p.reveal).trim().toLowerCase() : null;
  const keep = tsFilter(p, now), cls = listOf(p.class), harness = listOf(p.harness), sess = listOf(p.session),
    host = listOf(p.host), ref = listOf(p.ref);
  // Through the ONE warm, stat-revalidated reading of the index (src/query/rows.mjs, which `sessions` and `session` ask too).
  const all = await indexRows({ home, fs, errors });
  const as_of = asOf(all);
  // --harness is the harness `sessions` decided (proc, else the UA), and the session is the one `sessions` grouped by (C.5)
  const rows = all.filter((r) => keep(r.ts) && (!harness || harness.has(r.harness_id)) && (!sess || sess.has(r.session_id))
    && (!cls || cls.has(r.class)) && (!host || host.has(r.host)) && (!ref || ref.has(r.id)));

  if (!cls && !host && !ref) {
    const counts = new Map();
    for (const r of rows) counts.set(r.class, (counts.get(r.class) || 0) + 1);
    return { as_of, classes: [...counts].map(([c, count]) => ({ class: c, count })) };
  }

  if (ref && !rows.length) errors.push({ where: String(p.ref), reason: `no record ${p.ref} in this home's segment index` });
  const { items, next, has_more } = paginate(rows, p, { bytes: (r) => r.stored_bytes || 0 }); // the page's records are read back: bounded by bytes too
  const byId = new Map(items.map((r) => [r.id, r]));
  const recs = recordsAt({ home, fs, rows: items, errors });
  const slimBefore = Math.max(0, recs.length - CONTROL_DETAIL_RECORDS);
  return {
    as_of, ...(p.class != null ? { class: p.class } : {}), total: rows.length, detail_limit: CONTROL_DETAIL_RECORDS,
    records: recs.map((rec, i) => {
      const r = byId.get(rec.id);
      return { ...controlRecordWire(rec, { detail: i >= slimBefore, reveal }),
        id: r.id, ts: r.ts, harness: r.harness_id, class: r.class, host: r.host, endpoint: r.path, status: r.status,
        sent_bytes: r.sent_bytes, received_bytes: r.received_bytes, retention: r.log_only ? 'log' : 'full', ref: r.id };
    }),
    next, has_more,
  };
}
