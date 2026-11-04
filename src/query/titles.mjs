// src/query/titles.mjs — the TITLE TABLE: every session's title, beside the segment index (RFC 4.2 §标题表; 3.5 §访问模式; D78 ①).
//
// A title is the main lane's first prompt, `session`'s own `meta.title`. It lives in a request body the segment index does not parse
// (D20), and only a session's first calls hold it, so `sessions` reads it from one small table: `index/titles.json`, a projection like
// the index (invariant 2). A session the table does not have is computed on the spot from its first model calls in step order, so the
// list is never left not knowing. Only the query worker writes the file (saveTitles, through `later`); the one-shot CLI computes the
// same answer in memory and writes nothing.
import nodeFs from 'node:fs';
import path from 'node:path';
import { compareStep } from '../view/step-order.mjs';
import { recordsAt } from './records.mjs';
import { isModelCall } from './rows.mjs';
import { usageFacts } from './usage.mjs';
import { indexDir } from './index-build.mjs';
import { fsTag, statKey } from './warm.mjs';
import { trocarHome } from '../paths.mjs';

export const TITLE_V = 1;
const FIRST_READ = 4, GROWTH = 4; // model calls read at first, and how much larger each next read is (3.5 §访问模式: 4, 16, 64 …)

export const titlesFile = (home) => path.join(indexDir(home), 'titles.json');

const byStep = (a, b) => compareStep(a.ts, a.id, b.ts, b.id);

// The table as this process holds it, per home: session id → {t, r, c, m}. An entry's `m` moves in memory as new members are checked, so
// a warm answer looks at the new rows only; `dirty` says t, r or c changed since the file was written, and a dirty table is not reloaded.
const tables = new Map();
const tableKey = (home, fs) => `${fsTag(fs)}\n${home}`;
function readTable(home, fs) {
  try {
    const doc = JSON.parse(fs.readFileSync(titlesFile(home), 'utf8'));
    if (doc.v === TITLE_V) return new Map(Object.entries(doc.titles));
  } catch { /* none yet, or unreadable: the same empty table (4.2 §标题表 失效) */ }
  return new Map();
}
function tableOf(home, fs) {
  const key = tableKey(home, fs), stamp = statKey(titlesFile(home), fs), held = tables.get(key);
  if (held && (held.dirty || held.stamp === stamp)) return held;
  const table = { titles: readTable(home, fs), stamp, dirty: false };
  tables.set(key, table);
  return table;
}

// What the table says after this session's new members are checked: `keep` (the entry stands), or the place in the calls to read on from.
function check(was, members) {
  if (!was || members.length < was.m) return { from: 0 };
  const fresh = members.slice(was.m).filter(isModelCall);
  if (!fresh.length) return { keep: true };
  if (was.r != null) {
    const at = members.find((r) => r.id === was.r);
    return at && !fresh.some((r) => byStep(r, at) < 0) ? { keep: true } : { from: 0 }; // `t` null with a main call found is final too
  }
  return { from: was.c, fresh: new Set(fresh) };
}

// Reads `steps` (the model calls in step order) from `from`, batch by batch, until a main-lane call. → {t, r, c}, or {unread} when a
// record could not be read. A batch goes back to write order for the fold, as a session's members are folded.
function firstMain({ home, fs, steps, from, order }) {
  let size = FIRST_READ;
  for (let at = from; at < steps.length; at += size, size *= GROWTH) {
    const batch = steps.slice(at, at + size), errs = [];
    const rows = [...batch].sort((a, b) => order.get(a) - order.get(b));
    const records = recordsAt({ home, fs, rows, errors: errs, remember: false });
    if (errs.some((e) => e.io) || records.length < rows.length) return { unread: errs[0] ? errs[0].reason : 'a record is missing' };
    const facts = new Map(usageFacts({ rows, records }).map((f) => [String(f.id), f]));
    const main = batch.find((r) => (facts.get(String(r.id)) || {}).lane === 'main');
    if (main) return { t: facts.get(String(main.id)).ask ?? null, r: main.id, c: Math.min(at + size, steps.length) };
  }
  return { t: null, r: null, c: steps.length };
}

/** titleOf({home, fs, id, members, errors}) → the session's title, or null: no main prompt in its calls, or (with one `errors` entry,
 *  D38, and nothing kept) a record that could not be read back. `members`: the WHOLE session, in write order. */
export function titleOf({ home = trocarHome(), fs = nodeFs, id, members, errors = [] }) {
  const table = tableOf(home, fs), was = table.titles.get(id), state = check(was, members);
  if (state.keep) { was.m = members.length; return was.t; }
  const calls = members.filter(isModelCall), order = new Map(calls.map((r, i) => [r, i])), steps = [...calls].sort(byStep);
  // a new call that sorts into the part already read would never be read: the part is read again
  const from = state.fresh && steps.slice(0, state.from).some((r) => state.fresh.has(r)) ? 0 : state.from;
  const got = firstMain({ home, fs, steps, from, order });
  if (got.unread) {
    if (table.titles.delete(id)) table.dirty = true;
    errors.push({ where: `session/${id}`, code: 'record-unreadable', reason: got.unread });
    return null;
  }
  if (!was || was.t !== got.t || was.r !== got.r || was.c !== got.c) table.dirty = true;
  table.titles.set(id, { ...got, m: members.length });
  return got.t;
}

/** saveTitles({home, fs}): the table as this process holds it, whole, when it changed; nothing otherwise. The query worker's alone. */
export async function saveTitles({ home = trocarHome(), fs = nodeFs } = {}) {
  const table = tables.get(tableKey(home, fs));
  if (!table || !table.dirty) return;
  // at run time: ctx-files.mjs reaches the named queries, whose `sessions` and stamps import this module
  const { putFile } = await import('./ctx-files.mjs');
  putFile(fs, titlesFile(home), Buffer.from(JSON.stringify({ v: TITLE_V, titles: Object.fromEntries(table.titles) }), 'utf8'));
  table.dirty = false;
  table.stamp = statKey(titlesFile(home), fs);
}
