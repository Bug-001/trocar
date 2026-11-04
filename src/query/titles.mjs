// src/query/titles.mjs — the TITLE TABLE: every session's title, beside the segment index (RFC 4.2 §标题表; 3.5 §访问模式; D78 ①).
//
// A title is the main lane's first prompt, `session`'s own `meta.title`; until a session has a main call, its first subagent lane's task.
// It lives in a request body the segment index does not parse (D20), and only a session's first calls hold it, so `sessions` reads it
// from one small table: `index/titles.json`, a projection like
// the index (invariant 2). A session the table does not have is computed on the spot from its first model calls in step order, so the
// list is never left not knowing. Only the query worker writes the file (saveTitles, through `later`); the one-shot CLI computes the
// same answer in memory and writes nothing.
import nodeFs from 'node:fs';
import path from 'node:path';
import { compareStep } from '../view/step-order.mjs';
import { recordsAt } from './records.mjs';
import { isModelCall } from './rows.mjs';
import { foldFacts } from './usage.mjs';
import { indexDir } from './index-build.mjs';
import { fsTag, statKey } from './warm.mjs';
import { trocarHome } from '../paths.mjs';

export const TITLE_V = 1;
export const TITLE_BUDGET_MS = 100; // how long a `sessions` in the worker computes titles before it says ask again (3.5 §访问模式)
/** Thrown by titleOf past its `deadline`: the answer is a `102`, what was computed stays in the table. */
export class TitlesPending extends Error {}
const FIRST_READ = 4, GROWTH = 4; // model calls read at first, and how many times more each next read takes in (3.5 §访问模式: 4, 16, 64 …)

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

// What the table says after this session's new members are checked: `keep` (the entry stands; `waits`: on model calls past `m` that are
// still too few to fold again, so `m` stays where the count starts), or how far the calls are known to hold no main one.
function check(was, members) {
  if (!was || members.length < was.m) return { from: 0 };
  const fresh = members.slice(was.m).filter(isModelCall);
  if (!fresh.length) return { keep: true };
  if (was.r == null) return fresh.length * 8 >= was.c ? { from: was.c } : { keep: true, waits: true }; // at c*9/8 calls (4.2 §标题表)
  const at = members.find((r) => r.id === was.r);
  return at && !fresh.some((r) => byStep(r, at) < 0) ? { keep: true } : { from: 0 }; // `t` null with a main call found is final too
}

// The first main-lane call of the model calls (`calls` in write order, `steps` in step order), past the first `from` known to hold none.
// → {t, r, c}, or {unread} when a record could not be read or the fold threw. Each read folds the calls from the first one on, in write order, as `session`
// does: a call may be told by the one it continues (4 16 64 … of them, so about a third more reads than calls); a later part folded alone
// would read a subagent's continuation as the main lane. Whatever sorts into the part read before is in the next read too. The records
// are read one at a time, so a long read holds one record and the fold. With every call read and no main one, `t` is the first subagent
// lane's task and `r` stays null: a main call found later replaces it.
function firstMain({ home, fs, calls, steps, from, progress }) {
  let end = FIRST_READ;
  while (end <= from) end *= GROWTH;
  for (;; end *= GROWTH) {
    const head = steps.slice(0, end), held = new Set(head), errs = [];
    let lost = false;
    const read = (rs) => { progress(); const got = recordsAt({ home, fs, rows: rs, errors: errs, remember: false }); lost ||= got.length < rs.length; return got; };
    let facts;
    try { facts = new Map(foldFacts({ rows: calls.filter((r) => held.has(r)), read }).map((f) => [String(f.id), f])); }
    catch (e) { return { unread: String((e && e.message) || e).split('\n')[0] }; } // one session's fold, not the list's or its `session`'s (3.5 #41)
    if (lost || errs.some((e) => e.io)) return { unread: errs[0] ? errs[0].reason : 'a record is missing' };
    const main = head.find((r) => (facts.get(String(r.id)) || {}).lane === 'main');
    if (main) return { t: facts.get(String(main.id)).ask ?? null, r: main.id, c: head.length };
    if (end >= steps.length) {
      const sub = head.map((r) => facts.get(String(r.id))).find((f) => f && f.lane === 'subagent');
      return { t: sub ? sub.ask : null, r: null, c: steps.length };
    }
  }
}

const said = (t) => ({ title: t, title_source: t != null ? 'wire' : null });

/** titleOf({home, fs, id, members, errors, progress, deadline}) → {title, title_source}. `title_source`: 'wire', null (no prompt in its
 *  calls), or 'unread': a record that could not be read back, or a fold that threw, and no title to stand in; either leaves one `errors` entry (D38)
 *  and the table as it was, an old title standing. `members`: the WHOLE session, in write order. `progress`: called at each read.
 *  `deadline`: a performance.now() time; past it, a title that needs a read throws TitlesPending. */
export function titleOf({ home = trocarHome(), fs = nodeFs, id, members, errors = [], progress = () => {}, deadline = null }) {
  const table = tableOf(home, fs), was = table.titles.get(id), state = check(was, members);
  if (state.keep) { if (!state.waits) was.m = members.length; return said(was.t); }
  if (deadline != null && performance.now() >= deadline) throw new TitlesPending();
  const calls = members.filter(isModelCall);
  const got = firstMain({ home, fs, calls, steps: [...calls].sort(byStep), from: state.from, progress });
  if (got.unread) {
    errors.push({ where: `session/${id}`, code: 'record-unreadable', reason: got.unread });
    return was && was.t != null ? said(was.t) : { title: null, title_source: 'unread' };
  }
  if (!was || was.t !== got.t || was.r !== got.r || was.c !== got.c) table.dirty = true;
  table.titles.set(id, { ...got, m: members.length });
  return said(got.t);
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
