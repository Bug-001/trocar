// src/query/named/classes.mjs — `trocar query classes` (RFC 1.6 §4.1, §4.2, 附录 C.5; D60).
//
// The traffic-class table (src/classes/table.mjs — the ONE place the table is read), each class's calls
// and bytes over 24 h / 7 d / all time, and what ~/.trocar takes on disk. The counts come from the
// segment index and nothing else (1.6 §4.1 「`classes` 的条数与大小就是从这里算的」), read through the ONE warm reading of it
// (src/query/rows.mjs) that `calls`, `sessions` and `traffic` ask too.
import { asOf, indexRows } from '../rows.mjs';
import { readTable } from '../../classes/table.mjs';
import { diskUsage } from '../disk.mjs';

export const about = Object.freeze({
  summary: 'The traffic classes, each with its calls and size over 24 hours, 7 days and all time, what trocar takes on disk, and the latest changes.',
  params: Object.freeze({}),
});
export const params = Object.freeze(Object.keys(about.params));

const WINDOWS = Object.freeze([['h24', 24 * 3600e3], ['d7', 7 * 86400e3], ['all', null]]);
const zero = () => Object.fromEntries(WINDOWS.map(([k]) => [k, { calls: 0, bytes: 0 }]));

export async function run({ home, fs, now, errors, progress = null }) {
  const table = readTable({ home, fs });
  for (const pr of table.problems) errors.push({ where: 'classes.json', code: pr.code, reason: pr.reason, ...(pr.fatal ? { fatal: true } : {}) });

  const counts = new Map(table.classes.map((c) => [c.class, zero()]));
  const t = now();
  const rows = await indexRows({ home, fs, errors, progress }); // a segment's problems are its `segments/<seg>` errors
  const as_of = asOf(rows); // 附录 C.5: the newest call time in the whole index
  for (const r of rows) {
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
