// src/query/named/classes.mjs — `trocar query classes` (RFC 1.6 §4.1, §4.2, 附录 C.5; D60).
//
// The traffic-class table (src/classes/table.mjs — the ONE place the table is read), each class's calls
// and bytes over 24 h / 7 d / all time, and what ~/.trocar takes on disk. The counts come from the
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
  let as_of = null; // 附录 C.5: the newest call time in the whole index

  for (const s of segs) {
    for (const pr of s.problems) errors.push({ where: `segments/${s.segment}`, reason: `${pr.code}: ${pr.reason}` });
    const { records } = await segmentIndex({ home, segment: s.segment, fs });
    for (const r of records) {
      // A class on disk that the table does not name (an edited table, a record from before an edit) is
      // counted under its own line rather than dropped (invariant 4), and said to be no longer in the table.
      if (r.ts && (as_of == null || String(r.ts) > as_of)) as_of = String(r.ts);
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
  // Every `disk` number is what the file system says, out of the ONE walk (src/query/disk.mjs): the plaintext
  // records, their sealed copies, the whole home. A segment that still has its plaintext beside a sealed copy
  // counts in both — that is what it costs (tested 2026-10-18: both were 0 while 1 GB sat in raw/).
  return {
    as_of,
    classes,
    disk: {
      trocar_bytes: du.total_bytes,
      records_bytes: du.groups.records.bytes,
      sealed_bytes: du.groups.sealed.bytes,
    },
    file: table.file,
    last_change: table.lastChange,
  };
}
