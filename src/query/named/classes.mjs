// src/query/named/classes.mjs — `asight query classes` (RFC 1.6 §4.1, §4.2, 附录 C.5; D60).
//
// The traffic-class table (src/classes/table.mjs — the ONE place the table is read), each class's calls
// and bytes over 24 h / 7 d / all time, and what ~/.asight takes on disk. The counts come from the
// segment index and nothing else (1.6 §4.1 「`classes` 的条数与大小就是从这里算的」).
import { allSegments, segmentIndex } from '../index-build.mjs';
import { readTable } from '../../classes/table.mjs';
import { diskUsage } from '../disk.mjs';

export const params = Object.freeze([]);

const WINDOWS = Object.freeze([['h24', 24 * 3600e3], ['d7', 7 * 86400e3], ['all', null]]);
const zero = () => Object.fromEntries(WINDOWS.map(([k]) => [k, { calls: 0, bytes: 0 }]));

export async function run({ home, fs, now, errors }) {
  const table = readTable({ home, fs });
  for (const pr of table.problems) errors.push({ where: 'classes.json', reason: pr.reason });

  const counts = new Map(table.classes.map((c) => [c.class, zero()]));
  const t = now();
  const segs = await allSegments({ home, fs });
  for (const s of segs) {
    for (const pr of s.problems) errors.push({ where: `segments/${s.segment}`, reason: `${pr.code}: ${pr.reason}` });
    const { records } = await segmentIndex({ home, segment: s.segment, fs });
    for (const r of records) {
      // A class on disk that the table does not name (an edited table, a record from before an edit) is
      // counted under its own line rather than dropped (invariant 4), and said to be no longer in the table.
      let c = counts.get(r.class);
      if (!c) { c = zero(); counts.set(r.class, c); }
      const at = r.ts ? Date.parse(r.ts) : null;
      for (const [k, span] of WINDOWS) {
        if (span != null && !(at != null && t - at <= span)) continue;
        c[k].calls++; c[k].bytes += r.stored_bytes;
      }
    }
  }

  const byName = new Map(table.classes.map((c) => [c.class, c]));
  const classes = [...counts].map(([name, c]) => {
    const entry = byName.get(name);
    return { class: name, keep: entry ? entry.keep : null, builtin: entry ? !!entry.builtin : false,
      rules: entry ? entry.rules || [] : [], counts: c, ...(entry ? {} : { in_table: false }) };
  });

  const du = await diskUsage({ home, fs: fs.promises || undefined });
  for (const u of du.unreadable) errors.push({ where: u.path, reason: u.error });
  return {
    classes,
    disk: {
      asight_bytes: du.total_bytes,
      records_bytes: segs.reduce((n, s) => n + (s.state === 'sealed' ? 0 : s.bytes), 0),
      sealed_bytes: segs.reduce((n, s) => n + (s.sealed_bytes || 0), 0),
    },
    file: table.file,
    last_change: table.lastChange,
  };
}
