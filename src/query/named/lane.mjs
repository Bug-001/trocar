// src/query/named/lane.mjs — `trocar query lane --id <id> --lane <key> [--from RID | --to RID | --ledger C]` (RFC 3.5 §会话读, 1.6 §4.1 / C.5).
//
// One lane's page of steps: each step's block-id list as ops against its parent step's list, its reply ids, the attributes its added
// positions carry and its detail; the definitions the page brings that the client does not hold yet; the lane's resources, seen
// paths and the events of the steps it covers. All from the session's state at the reduction frontier (src/query/named/session.mjs
// sessionState): the lane's rids and slots, user counts and compaction / summarize flags from the step-order columns
// (src/query/session-doc.mjs), the events and ledger deltas from its fold log's call lines read by offset, each list materialised
// from the context projection (src/view/reduce.mjs listOf), the definitions and row facts from the projection's lines. No record is
// read (3.5 §会话读: a lane answer is the projection's). The ledger (src/view/reduce.mjs laneLedger) is replayed from the lane's
// first step, or from the one a kept ledger of the lane reached when no row of the lane at or before it changed since (3.5 §内存有界:
// the kept ledgers, LEDGER_BYTES): an answer reads the lines of the steps it covers and of the steps the replay goes over. The ledger
// entries an answer owes go in key order into the room its page leaves; the rest are named by `ledger_next`, a cursor `--ledger`
// goes on from (3.5 `resources` 与 `seen`).
import { sessionState, version as sessionVersion } from './session.mjs';
import { listOf, laneLedger, ledgerWeight, LEDGER_BYTES } from '../../view/reduce.mjs';
import { lru } from '../projection.mjs';
import { inheritedRender } from '../../view/render-kind.mjs';
import { PAGE_BYTES, laneOf, placeIn } from '../session-doc.mjs';
import { compareStep } from '../../view/step-order.mjs';
import { QueryArgError } from './index.mjs';

export const params = Object.freeze(['id', 'lane', 'from', 'to', 'ledger']);

const one = (v) => (v == null || v === '' ? null : String(v));
const pick = (o, keys) => { const out = {}; if (o) for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };
// A definition on the wire (3.5 §会话读 定义 closed set): `fh` as 22 base64url characters (the first 128 bits of the stored digest).
const OPTIONAL = ['label', 'name', 'mcp', 'cc'];
const BODY = ['text', 'block', 'desc', 'schema'];
const fhWire = (hex) => (typeof hex === 'string' && /^[0-9a-f]{32}/.test(hex) ? Buffer.from(hex.slice(0, 32), 'hex').toString('base64url') : null);
// a position's attributes on the wire, and the key a copy is matched by (a block id with the attributes it carries there)
const attrOf = (a) => { const o = pick(a, ['query', 'volatile']); return Object.keys(o).length ? o : null; };
// The ledger's wire order (3.5 `resources` 与 `seen`): resources by `kind::label`, then seen by `path`, code-unit order. A cursor =
// base64url of JSON [list, the last key shipped] ('' before the first); `--ledger C` answers the entries after it, its key gone or not.
const LISTS = ['resources', 'seen'];
const keyOf = [(r) => `${r.kind}::${r.label}`, (f) => f.path];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function cursorOf(c) {
  let v = null;
  try { v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); } catch { /* malformed: below */ }
  if (!Array.isArray(v) || v.length !== 2 || !LISTS.includes(v[0]) || typeof v[1] !== 'string') {
    throw new QueryArgError('trocar query lane: --ledger takes the ledger_next of an earlier lane answer');
  }
  return [LISTS.indexOf(v[0]), v[1]];
}

/** opsOf(P, C) → ops rebuilding token list C from P: `[0, from, len]` copies P[from, from+len), `[1, …]` adds; greedy, the longest
 *  run at each place (the run that goes on from the last copy tried first). Tokens compare by ===. */
function opsOf(P, C) {
  const at = new Map();
  P.forEach((t, j) => { const a = at.get(t); if (a) { if (a.length < 8) a.push(j); } else at.set(t, [j]); });
  const ops = [];
  let add = null, next = -1;
  for (let i = 0; i < C.length;) {
    let best = -1, len = 0;
    const run = (j) => { let n = 0; while (i + n < C.length && j + n < P.length && P[j + n] === C[i + n]) n++; if (n > len) { len = n; best = j; } };
    if (next >= 0 && P[next] === C[i]) run(next);
    for (const j of at.get(C[i]) || []) run(j);
    if (len) { ops.push([0, best, len]); add = null; i += len; next = best + len; }
    else { if (!add) { add = [1]; ops.push(add); } add.push(i); i++; }
  }
  return ops;
}

// The kept lane ledgers of a session's fold log (its state's): lane key → {maps, step, rid, off} = laneLedger's maps at the lane's
// step `step` (rid `rid`), as the log stood at byte `off` (its frontier then). Weighed by ledgerWeight, LEDGER_BYTES in all.
const ledgers = new WeakMap();
// a kept ledger still good for the lane `lane` now: its step holds the same rid and no row of the lane at or before it changed since
// (one that moved in or out of the lane before it moves its step's rid)
function keptOf(cols, log, lane, e) {
  if (!e || lane.rids[e.step] !== e.rid) return null;
  const t = cols.ts[lane.slots[e.step]];
  for (const rid of log.changedSince(e.off).rids) {
    const k = cols.slotOf(rid);
    if (cols.ts[k] !== undefined && cols.ln[k] === lane.v && compareStep(cols.ts[k], rid, t, e.rid) <= 0) return null;
  }
  return e;
}

export async function run(ctx) {
  const { params: p, errors } = ctx;
  const id = one(p.id), key = one(p.lane), from = one(p.from), to = one(p.to), ledger = one(p.ledger);
  if (id == null) throw new QueryArgError('trocar query lane: --id is required (a session id; `trocar query sessions` lists them)');
  if (key == null) throw new QueryArgError('trocar query lane: --lane is required (a lane key; `trocar query session` lists the lanes)');
  if ([from, to, ledger].filter((x) => x != null).length > 1) throw new QueryArgError('trocar query lane: give at most one of --from, --to and --ledger');
  const after = ledger == null ? null : cursorOf(ledger);
  const st = await sessionState(ctx, id);
  const empty = (mark) => ({ lane: key, base: null, mark, steps: [], defs: [], resources: [], seen: [], events: [], prev: null, next: null, ledger_next: null });
  if (!st) {
    errors.push({ where: `session/${id}`, code: 'session-unknown', reason: 'no session with this id among the captured records' });
    return empty(null);
  }
  errors.push(...st.errors);
  // a lane the session does not have (it can vanish between polls: `lanes_gone`) is an empty lane
  const { cols, log } = st.V;
  if (!cols.lanes.has(key)) return empty(st.mark);
  const { store } = st, L = laneOf(cols, key), { rids, slots } = L, n = rids.length;
  const lines = new Map(), lineAt = (i) => { if (!lines.has(i)) lines.set(i, log.read(...log.latest(rids[i]))); return lines.get(i); };
  // the `user` events before step i (3.5: every `user` event's `k` is its place among the lane's, 1-based)
  const before = [0];
  for (const k of slots) before.push(before.at(-1) + cols.uc[k]);
  const CS = (e) => e.type === 'compaction' || e.type === 'summarize';
  const eventsAt = (i) => { let j = before[i]; return lineAt(i).e.map((e) => (e.type === 'user' ? { ...e, k: ++j } : e)); };
  const flagged = [];
  for (let i = 0; i < n; i++) if (cols.cs[slots[i]]) flagged.push(i);
  const lists = new Map(), defs = new Map(), wires = new Map();
  const rowOf = (i) => store.rows.get(rids[i]);
  const listAt = (i) => {
    if (!lists.has(i)) {
      const l = listOf(store, rids[i]) || { bids: [], attrs: {} };
      lists.set(i, { bids: l.bids, attrs: l.attrs, toks: l.bids.map((b, k) => { const a = attrOf(l.attrs[k]); return a ? `${b}\u001f${JSON.stringify(a)}` : b; }) });
    }
    return lists.get(i);
  };
  const replyAt = (i) => rowOf(i).reply || [];
  const defOf = (bid) => { if (!defs.has(bid)) defs.set(bid, store.readDef(bid) || null); return defs.get(bid); };
  // a tool_result whose own sniff is plain text takes its render from its tool_use's (render-kind.mjs inheritedRender): the tool_use
  // of the same id in the list it is first seen in
  function renderIn(d, list) {
    const own = d.r || { as: 'text' }, useId = d.f && d.f.tool_use_id;
    if (own.as !== 'text' || useId == null) return own;
    for (const b of list) { const u = defOf(b); if (u && u.f && u.f.type === 'tool_use' && u.f.id === useId) return inheritedRender(u.r) || own; }
    return own;
  }
  function wireDef(bid, list) {
    if (wires.has(bid)) return wires.get(bid);
    const d = defOf(bid);
    let w = null;
    if (d) {
      const ff = d.ff || {};
      w = { bid, fh: fhWire(d.fh), ref: d.ref ?? null, sec: d.sec, role: d.role, kind: d.kind, ...pick(d, OPTIONAL), ff, head: d.head,
        preview: d.preview, chars: d.chars, bytes: d.bytes, ...(d.resKey ? { resKey: d.resKey } : null), r: pick(renderIn(d, list), ['as', 'tone', 'title', 'f']) };
      if (ff.unaddressable) Object.assign(w, { ref: null, unaddressable: ff.unaddressable, inline: pick(d, BODY) });
    }
    wires.set(bid, w);
    return w;
  }
  // step i with ops against step i-1 (a keyframe when `key`): {step, bids it references}
  function stepAt(i, keyframe) {
    const C = listAt(i), row = rowOf(i), x = row.x || {};
    const ops = keyframe || i === 0 ? [[1, ...C.toks.map((_, k) => k)]] : opsOf(listAt(i - 1).toks, C.toks);
    const attrs = {};
    for (const op of ops) if (op[0] === 1) for (let k = 1; k < op.length; k++) { const a = attrOf(C.attrs[op[k]]); if (a) attrs[op[k]] = a; op[k] = C.bids[op[k]]; }
    const step = { rid: rids[i], parent: i > 0 ? rids[i - 1] : null, ops, reply: replyAt(i), attrs,
      detail: { norm: { stop_reason: x.stop_reason ?? null, usage: (x.facts ? x.facts.usage : x.nu) ?? null }, respRefs: x.respRefs || [],
        nonBlockKeys: x.nonBlockKeys || [], extraMessages: x.extraMessages || [], wire: x.wire ?? null } };
    return step;
  }
  const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v));
  const evBytes = (i, keep = () => true) => eventsAt(i).reduce((a, e) => a + (keep(e) ? bytesOf(e) : 0), 0);

  const at = (rid) => (rid == null ? -1 : placeIn(cols, L, rid)), k = at(from);
  let lo, hi, base = null; // the page is steps [lo, hi)
  const held = new Set(); // ids the client holds: those of the `from` step's list and reply (3.5 定义)
  const fresh = new Map(); // bid → the step whose list it is first met in (a tool_result's render joins its tool_use there)
  // the ids step i brings that neither the client nor the page holds yet, taken into the page, and their definitions' bytes
  function meet(i) {
    const added = [];
    for (const b of [...listAt(i).bids, ...replyAt(i)]) if (!held.has(b) && !fresh.has(b)) { fresh.set(b, i); added.push(b); }
    let bytes = 0;
    for (const b of added) { const w = wireDef(b, listAt(i).bids); if (w) bytes += bytesOf(w); }
    return { added, bytes };
  }
  const drop = (added) => { for (const b of added) fresh.delete(b); };
  if (after) lo = hi = 0; // a --ledger answer: no step
  else if (k >= 0) {
    base = from;
    for (const b of listAt(k).bids) held.add(b);
    for (const b of replyAt(k)) held.add(b);
    lo = k + 1; hi = lo;
    let bytes = 0;
    while (hi < n) {
      const m = meet(hi), add = bytesOf(stepAt(hi, false)) + m.bytes + evBytes(hi);
      if (hi > lo && bytes + add > PAGE_BYTES) { drop(m.added); break; }
      bytes += add; hi++;
    }
  } else {
    // the tail page, a reset (a `--from` not in the lane), or the page ending just before `--to`: grown backwards, its first step a
    // keyframe, the rest each against its parent; the lane's compaction and summarize events ride along whatever steps it covers
    const t = at(to);
    hi = t >= 0 ? t : n;
    lo = hi;
    let rel = 0, defBytes = 0, ev = flagged.reduce((a, i) => a + evBytes(i, CS), 0);
    while (lo > 0) {
      const s = lo - 1, m = meet(s), next = lo < hi ? bytesOf(stepAt(lo, false)) : 0, e = evBytes(s, (x) => !CS(x));
      if (lo < hi && rel + next + bytesOf(stepAt(s, true)) + defBytes + m.bytes + ev + e > PAGE_BYTES) { drop(m.added); break; }
      rel += next; defBytes += m.bytes; ev += e; lo = s;
    }
  }
  const steps = [];
  for (let i = lo; i < hi; i++) steps.push(stepAt(i, base == null && i === lo));
  if (base != null && steps.length) steps[0].parent = base;
  // the page's steps' events; at base:null also the compaction / summarize events of the lane's other steps; in step order
  const events = [], page = steps.map((_, j) => lo + j);
  for (const i of after ? [] : base == null ? [...flagged.filter((x) => x < lo), ...page, ...flagged.filter((x) => x >= hi)] : page) {
    events.push(...(i >= lo && i < hi ? eventsAt(i) : eventsAt(i).filter(CS)));
  }
  // the ledger: a kept one of this lane gone on from (at `base`, or anywhere for a base:null answer), else replayed from the first
  // step; each line read for it and let go; then kept at the last step
  const b = base == null ? -1 : k, cache = ledgers.get(log) || ledgers.set(log, lru(LEDGER_BYTES)).get(log);
  let e = keptOf(cols, log, L, cache.get(key));
  if (e && b >= 0 && e.step !== b) e = null;
  cache.delete(key); // gone on from in place below
  const { resources, seen, kept } = laneLedger(rids, (i) => (lines.has(i) ? lines.get(i) : log.peek(...log.latest(rids[i]))).d, b, e);
  if (kept) {
    const w = ledgerWeight(kept);
    if (w <= LEDGER_BYTES) cache.set(key, { ...kept, rid: rids[kept.step], off: log.frontier }, w);
  }
  const wireDefs = [...fresh.keys()].map((b) => wireDef(b, listAt(fresh.get(b)).bids)).filter(Boolean);
  // the entries owed (at --ledger: those after its cursor) in key order, into the room the page leaves (a --ledger answer takes one
  // at least); `ledger_next` names the last one shipped when some are left
  const owed = [resources, seen].flatMap((list, j) => list.map((e) => [j, keyOf[j](e), e]))
    .filter(([j, kk]) => !after || j > after[0] || (j === after[0] && kk > after[1]))
    .sort((a, b) => a[0] - b[0] || cmp(a[1], b[1]));
  const out = [[], []];
  let room = PAGE_BYTES - bytesOf(steps) - bytesOf(wireDefs) - bytesOf(events), i = 0;
  for (; i < owed.length; i++) {
    const w = bytesOf(owed[i][2]) + 1;
    if (w > room && !(after && i === 0)) break;
    room -= w; out[owed[i][0]].push(owed[i][2]);
  }
  const last = i > 0 ? owed[i - 1] : [0, ''];
  return {
    lane: key, base, mark: st.mark, steps, defs: wireDefs, resources: out[0], seen: out[1], events,
    prev: lo > 0 && steps.length ? rids[lo] : null, next: hi < n && steps.length ? rids[hi - 1] : null,
    ledger_next: i < owed.length ? Buffer.from(JSON.stringify([LISTS[last[0]], last[1]])).toString('base64url') : null,
  };
}

/** version(ctx) → the session's version (session.mjs: its member rows, frontier and cut) and the lane's parameters. */
export async function version(ctx) {
  const v = await sessionVersion(ctx);
  const p = ctx.params;
  return v && { key: JSON.stringify([v.key, one(p.lane), one(p.from), one(p.to), one(p.ledger)]), errors: v.errors };
}
