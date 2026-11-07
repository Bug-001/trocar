// src/query/titles.mjs — the TITLE TABLE: every session's title, beside the segment index (RFC 4.2 §标题表; 3.5 §访问模式; D78 ①).
//
// A title is the main lane's first prompt, `session`'s own `meta.title`; until a session has a main call, its first subagent lane's task.
// The project is the working directory the call that gives the title states (3.4 §工作目录, projectOf), kept beside it as `p`.
// The declared lineage (3.4 §血缘) is read off the session's first model call in the same pass, kept as `s` (that call), `l` `a` `k`.
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
import { projectOf, projectFields } from '../dissect/project.mjs';
import { HARNESSES, hintsOf, bodyOf } from '../dissect/harnesses.mjs';
import { reqIncompleteOf } from '../dissect/capture-labels.mjs';

export const TITLE_V = 6;
export const TITLE_BUDGET_MS = 100; // how long a `sessions` in the worker computes titles before it says ask again (3.5 §访问模式)
/** Thrown by titleOf past its `deadline`: the answer is a `102`, what was computed stays in the table. */
export class TitlesPending extends Error {}
const FIRST_READ = 4, GROWTH = 4; // model calls read at first, and how many times more each next read takes in (3.5 §访问模式: 4, 16, 64 …)
// in a session whose harness row has `chainLane`: how many calls the main system text must stay main for before its title is final (4.2 §标题表)
const LEAD_RUN = 32;

export const titlesFile = (home) => path.join(indexDir(home), 'titles.json');

const byStep = (a, b) => compareStep(a.ts, a.id, b.ts, b.id);

// The table as this process holds it, per home: session id → {t, r, c, p, s, l, a, k, w, m}. An entry's `m` moves in memory as new members are checked, so
// a warm answer looks at the new rows only; `dirty` says a kept key (KEYS) changed since the file was written, and a dirty table is not reloaded.
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
  const first = was.s != null && members.find((r) => r.id === was.s); // a call before it changes the lineage (3.4 §血缘)
  if (first && fresh.some((r) => byStep(r, first) < 0)) return { from: 0 };
  // no main call yet, or one whose system text may still lose main: at c*9/8 calls (4.2 §标题表)
  if (was.r == null || was.w) return fresh.length * 8 >= was.c ? { from: was.c } : { keep: true, waits: true };
  const at = members.find((r) => r.id === was.r);
  return at && !fresh.some((r) => byStep(r, at) < 0) ? { keep: true } : { from: 0 }; // `t` null with a main call found is final too
}

// The first main-lane call of the model calls (`calls` in write order, `steps` in step order), past the first `from` known to hold none.
// → {t, r, c, p} (`p`: the working directory the call giving `t` states), or {unread} when a record could not be read or the fold threw. Each read folds the calls from the first one on, in write order, as `session`
// does: a call may be told by the one it continues (4 16 64 … of them, so about a third more reads than calls); a later part folded alone
// would read a subagent's continuation as the main lane. Whatever sorts into the part read before is in the next read too. The records
// are read one at a time, so a long read holds one record and the fold. With every call read and no main one, `t` is the first subagent
// lane's task and `r` stays null: a main call found later replaces it.
function firstMain({ home, fs, calls, steps, from, progress }) {
  const first = steps[0] || null, row = first && HARNESSES.find((h) => h.id === first.harness_id);
  // the lineage of the first call: read off the record the fold reads anyway; a row that declares no keys reads nothing, a call with
  // no row is not known to declare nothing (3.4 §血缘)
  let lin = !first ? {} : !row ? { l: 'unread' } : row.parentKeys.length || row.forkKeys.length ? null : { l: 'no-keys' };
  const lineage = (rec) => {
    const h = hintsOf(rec), hidden = !bodyWhole(rec);
    // a kind with nothing found that a body key could have declared, in a body not wholly here: unknown, never "declares none"
    const unknown = (found, keys) => !found && hidden && keys.some((key) => key.from === 'body');
    lin = unknown(h.parent, row.parentKeys) || unknown(h.fork, row.forkKeys) ? { l: 'unread' }
      : { l: 'wire', a: h.parent ? h.parent.id : null, k: h.fork ? h.fork.id : null };
  };
  let end = row && row.chainLane ? LEAD_RUN + 1 : FIRST_READ; // a chain-split session's title takes LEAD_RUN calls after its main text's start
  while (end <= from) end *= GROWTH;
  for (let next; ; end = next) {
    next = end * GROWTH;
    const head = steps.slice(0, end), held = new Set(head), errs = [], proj = new Map();
    let lost = false;
    // the project of each call read, a short string: the heap still holds one record (recordsAt drops an unread one: no pairing then, the call is `unread`)
    const read = (rs) => {
      progress();
      const got = recordsAt({ home, fs, rows: rs, errors: errs, remember: false });
      if (got.length === rs.length) rs.forEach((r, i) => { proj.set(String(r.id), projectOf(got[i])); if (r === first && !lin) lineage(got[i]); });
      else lost = true;
      return got;
    };
    let facts;
    try { facts = new Map(foldFacts({ rows: calls.filter((r) => held.has(r)), read }).map((f) => [String(f.id), f])); }
    catch (e) { return { unread: String((e && e.message) || e).split('\n')[0] }; } // one session's fold, not the list's or its `session`'s (3.5 #41)
    if (lost || errs.some((e) => e.io)) return { unread: errs[0] ? errs[0].reason : 'a record is missing' };
    const main = head.find((r) => (facts.get(String(r.id)) || {}).lane === 'main');
    const p = head.map((r) => proj.get(String(r.id))).find((x) => x != null) ?? null; // a first call is often a small one with no environment (3.4 §工作目录)
    const s = first ? first.id : null;
    if (main) {
      const got = { t: facts.get(String(main.id)).ask ?? null, r: main.id, c: head.length, p, s, ...lin };
      if (!row || !row.chainLane) return got;
      // a keyed session split by chains: early on another agent's history can be the longest, so its call is "main" there (3.4)
      const at = leadAt(calls, held, facts);
      if (head.length - 1 - at >= LEAD_RUN) return got;
      if (end >= steps.length) return { ...got, w: true }; // every call read and the run still short: not final (`w`)
      next = Math.min(next, at + 1 + LEAD_RUN);
      continue;
    }
    if (end >= steps.length) {
      const sub = head.map((r) => facts.get(String(r.id))).find((f) => f && f.lane === 'subagent');
      return { t: sub ? sub.ask : null, r: null, c: steps.length, p, s, ...lin };
    }
  }
}

// The place, among the calls read in write order (the fold's), where the main system text last moved (3.4 带键会话里的消息链: the
// text of the call with the most messages, a tie to the first; a call the fold failed gives no fact and does not count).
function leadAt(calls, held, facts) {
  const max = new Map();
  let main = null, at = 0, i = -1;
  for (const r of calls) {
    if (!held.has(r)) continue;
    i++;
    const f = facts.get(String(r.id));
    if (!f || f.text == null) continue;
    const m = Math.max(max.get(f.text) ?? -1, f.msgs);
    max.set(f.text, m);
    if (main == null || (f.text !== main && m > max.get(main))) { main = f.text; at = i; }
  }
  return at;
}

// The request body as the model got it is all in the record: one stored at all, not cut or partly received, and not a WebSocket message
// kept as its size or undecoded bytes (4.6 §记录).
const bodyWhole = (rec) => { const b = bodyOf(rec); return !!b && !reqIncompleteOf(rec) && !('omitted_bytes' in b) && !('b64' in b); };

// Lineage, by construction never read as "none" when not known: the id keys exist only with `wire` (3.4 §血缘).
const lineageOf = (e) => (e && e.l === 'wire' ? { lineage_source: 'wire', parent_session_id: e.a, fork_of_session_id: e.k } : { lineage_source: (e && e.l) || 'unread' });
/** lineageFields(meta) → the lineage keys of a document's meta, the same closed shape (a head written before them: `unread`). */
export const lineageFields = (m) => lineageOf({ l: m.lineage_source, a: m.parent_session_id ?? null, k: m.fork_of_session_id ?? null });
/** lineageKnown({home, fs, id}) → whether the table holds a verdict on the session's lineage: its entry has an `l`, `unread` included
 *  (a body not wholly kept, no harness row: that record's verdict). No entry, or no `l`, is not computed, and moves no head. */
export const lineageKnown = ({ home = trocarHome(), fs = nodeFs, id }) => !!tableOf(home, fs).titles.get(String(id))?.l;
/** withLineage(meta, said) → `meta` with the lineage `said` says and no other lineage key left behind. */
export const withLineage = (meta, said) => { const { lineage_source, parent_session_id, fork_of_session_id, ...rest } = meta; return { ...rest, ...lineageFields(said) }; };
const said = (e) => ({ title: e.t, title_source: e.t != null ? 'wire' : null, ...projectFields(e.p ?? null), ...lineageOf(e) });
const KEYS = ['t', 'r', 'c', 'p', 's', 'l', 'a', 'k', 'w'];

/** titleOf({home, fs, id, members, errors, progress, deadline}) → {title, title_source, project_slug, project_path, lineage_source, parent_session_id?,
 *  fork_of_session_id?} (1.6 C.5). `title_source`: 'wire', null (no prompt in its
 *  calls), or 'unread': a record that could not be read back, or a fold that threw, and no title to stand in; either leaves one `errors` entry (D38)
 *  and the table as it was, an old title standing. `members`: the WHOLE session, in write order. `progress`: called at each read.
 *  `deadline`: a performance.now() time; past it, a title that needs a read throws TitlesPending. */
export function titleOf({ home = trocarHome(), fs = nodeFs, id, members, errors = [], progress = () => {}, deadline = null }) {
  const table = tableOf(home, fs), was = table.titles.get(id), state = check(was, members);
  if (state.keep) { if (!state.waits) was.m = members.length; return said(was); }
  if (deadline != null && performance.now() >= deadline) throw new TitlesPending();
  const calls = members.filter(isModelCall);
  const got = firstMain({ home, fs, calls, steps: [...calls].sort(byStep), from: state.from, progress });
  if (got.unread) {
    errors.push({ where: `session/${id}`, code: 'record-unreadable', reason: got.unread });
    return was && was.t != null ? said(was) : { title: null, title_source: 'unread', ...projectFields(was ? was.p ?? null : null), ...lineageOf(was) };
  }
  if (!was || KEYS.some((k) => was[k] !== got[k])) table.dirty = true;
  table.titles.set(id, { ...got, m: members.length });
  return said(got);
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
