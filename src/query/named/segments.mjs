// src/query/named/segments.mjs — `trocar query segments` (RFC 1.6 §4.1, 附录 C.5).
//
// The raw layer as it is on disk: one line per segment of ~/.trocar/raw/, with its state, how many
// records it holds, what it takes in plaintext and sealed, its time range and what could not be read.
// Only raw/ segments are listed: the older capture locations keep
// their own record refs and show up in `query classes`'s disk totals, not as segments here.
import { allSegments, problemEntry } from '../index-build.mjs';
import { parseTime } from './index.mjs';
import { WINDOW } from './about.mjs';

export const about = Object.freeze({
  summary: 'The segments of the raw capture: name, state, records, size before and after sealing, time range and sealing problems.',
  params: Object.freeze({
    ...WINDOW,
  }),
});
export const params = Object.freeze(Object.keys(about.params));

export async function run({ home, fs, now, params: p, errors, progress = null }) {
  const since = p.since == null ? null : parseTime(p.since, { name: 'since', now: now() });
  const until = p.until == null ? null : parseTime(p.until, { name: 'until', now: now() });
  const all = await allSegments({ home, fs, progress, errors });
  const segments = [];
  // 附录 C.5 as_of: the newest call time over ALL segments, whatever the time filter keeps
  const as_of = all.reduce((m, s) => (s.to && (m == null || s.to > m) ? s.to : m), null);
  for (const s of all) {
    const from = s.from ? Date.parse(s.from) : null, to = s.to ? Date.parse(s.to) : null;
    // A segment with no readable record has no time range: it is kept, so a problem is never hidden by a filter.
    if (from != null && to != null && ((since != null && to < since) || (until != null && from > until))) continue;
    for (const pr of s.problems) errors.push(problemEntry(`segments/${s.segment}`, pr));
    segments.push({ segment: s.segment, state: s.state, records: s.records, bytes: s.bytes, sealed_bytes: s.sealed_bytes,
      ratio: s.sealed_bytes != null && s.bytes > 0 ? s.sealed_bytes / s.bytes : null,
      from: s.from, to: s.to, problems: s.problems });
  }
  return { as_of, segments };
}
