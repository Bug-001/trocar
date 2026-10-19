// src/query/named/traffic.mjs — `asight query traffic` (RFC 1.6 §4.1, 附录 C.5 `traffic`; 1.10 流量表).
//
// One pass over the SEGMENT INDEX rows, no record body opened (3.5 §访问模式 MUST NOT). A row is one request; it
// falls in the window by its own ts (sessions take no part: most traffic has none). `first_seen` per (harness, host)
// and `harness_since` per harness are over the WHOLE index — 1.10's 「新」 is decided on them, whatever the window.
// A byte sum over rows that recorded nothing is null, never 0 (invariant 4); `totals` cover the window, not the page.
import { asOf, indexRows } from '../rows.mjs';
import { paginate, tsFilter } from './index.mjs';

export const params = Object.freeze(['since', 'until', 'limit', 'after']);

const add = (sum, v) => (v == null ? sum : (sum ?? 0) + v);

export async function run({ home, fs, now, params: p, errors }) {
  const keep = tsFilter(p, now);
  const all = await indexRows({ home, fs, errors });
  const first = new Map(), since = {}, groups = new Map();
  const totals = { requests: 0, sent_bytes: null, received_bytes: null, is_floor: true };
  for (const r of all) {
    // the harness `sessions` decides (proc, else the UA), not the raw proc.agent (C.5 口径)
    const h = r.harness_id ?? null, key = JSON.stringify([h, r.host ?? null]), ts = r.ts ? String(r.ts) : null;
    if (ts && !(first.get(key) <= ts)) first.set(key, ts);
    if (ts && h != null && !(since[h] <= ts)) since[h] = ts;
    if (!keep(r.ts)) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { harness: h, harness_inferred: false, host: r.host ?? null, first_seen: null, last_seen: null,
      requests: 0, sent_bytes: null, received_bytes: null, received_unrecorded: 0, classes: {} });
    g.requests++;
    if (ts && !(g.last_seen >= ts)) g.last_seen = ts;
    g.sent_bytes = add(g.sent_bytes, r.sent_bytes);
    g.received_bytes = add(g.received_bytes, r.received_bytes);
    if (r.received_bytes == null) g.received_unrecorded++;
    g.classes[r.class] = (g.classes[r.class] || 0) + 1;
    if (r.harness_inferred) g.harness_inferred = true;
    totals.requests++;
    totals.sent_bytes = add(totals.sent_bytes, r.sent_bytes);
    totals.received_bytes = add(totals.received_bytes, r.received_bytes);
  }
  const cmp = (a, b) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);
  const list = [...groups].map(([k, g]) => ({ ...g, first_seen: first.get(k) ?? null }))
    .sort((a, b) => cmp(a.harness, b.harness) || cmp(a.host, b.host));
  const { items, next, has_more } = paginate(list, p);
  return { as_of: asOf(all), hosts: items, harness_since: since, totals, next, has_more };
}
