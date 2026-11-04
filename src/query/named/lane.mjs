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
import { sessionState, markOn, files, version as sessionVersion } from './session.mjs';
import { listOf, laneLedger, ledgerWeight, LEDGER_BYTES } from '../../view/reduce.mjs';
import { lru } from '../projection.mjs';
import { inheritedRender } from '../../view/render-kind.mjs';
import { PAGE_BYTES, laneOf, placeIn } from '../session-doc.mjs';
import { compareStep } from '../../view/step-order.mjs';
import { QueryArgError } from './index.mjs';
import nodeFs from 'node:fs';
import { renderSpan, sealedOf, tailFile } from '../ctx-files.mjs';
import { trocarHome } from '../../paths.mjs';

export const about = Object.freeze({
  summary: "One page of one lane of a session: its steps, the blocks they bring in, its resources, the paths it read and its events. With --pack or --tail, the session's steps as NDJSON lines instead.",
  params: Object.freeze({
    id: 'The session: a session id, as the sessions query lists them. Required.',
    lane: 'The lane: a lane key from the session answer. Required unless --pack or --tail is given.',
    from: "A record id: gives the steps after it. Without --from, --to or --ledger the page is the lane's last. Give at most one of the three.",
    to: 'A record id: gives the page that ends just before it. Give at most one of --from, --to and --ledger.',
    ledger: 'The next part of a list that did not fit: the ledger_next field of the previous answer. Gives no steps. Give at most one of --from, --to and --ledger.',
    pack: 'One finished pack: its number, a dot, then main or rest, such as 0.main. Goes with --id only, and not with --tail.',
    tail: 'The steps after the last finished pack: main or rest. Goes with --id only, and not with --pack.',
  }),
});
export const params = Object.freeze(Object.keys(about.params));

const one = (v) => (v == null || v === '' ? null : String(v));
const pick = (o, keys) => { const out = {}; if (o) for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };
// A definition on the wire (3.5 §会话读 定义 closed set): `fh` as 22 base64url characters (the first 128 bits of the stored digest).
// `name`: a tool definition's, or a tool call's tool (the projection keeps a call's as `toolName`, the flat entry's own word).
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
// the definitions a lane stepper keeps read (bytes, about)
const DEF_BYTES = 8 << 20;
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

/** weigh(v) → what a kept step or definition holds in the heap, about: its JSON's bytes (every field) and the entry. */
export const weigh = (v) => 96 + (v ? 2 * JSON.stringify(v).length : 0);
/** laneStepper(st, key, uses) → the steps of the lane `key` of a session state (sessionState): {L, n, rids, lines, lineAt(i), eventsAt(i),
 *  listAt(i), replyAt(i), step(i, prev), defOf(bid, list), release(keep)}. step(i, prev) = step i with its ops against step `prev`'s list (−1: a
 *  keyframe, every position added), parent = step `prev`'s rid (null for −1); defOf = a definition on the wire, its render joined with
 *  the tool_use of the list `list` (a listAt(i); the first it is asked with: cached by bid). Lists, lines and definitions are read once each; `uses`
 *  (an lru by bid: a block's tool_use id and the render a tool_result inherits from it, 0 for a block that is no tool_use; a function
 *  of its bid) may be one kept across steppers (ctx-files.mjs, the writer's memo), so a list's blocks are not read again at every
 *  slice, and what it keeps is these few fields, never the definitions. */
export function laneStepper(st, key, uses = lru(DEF_BYTES)) {
  const { store } = st, { cols, log } = st.V, L = laneOf(cols, key), { rids, slots } = L;
  const lines = new Map(), lineAt = (i) => { if (!lines.has(i)) lines.set(i, log.read(...log.latest(rids[i]))); return lines.get(i); };
  // the `user` events before step i (3.5: every `user` event's `k` is its place among the lane's, 1-based), walked from the last place
  // asked: a stepper made for a slice's few steps does not sum the whole lane up front
  let bi = 0, bs = 0;
  const before = (i) => { for (; bi < i; bi++) bs += cols.uc[slots[bi]]; for (; bi > i; bi--) bs -= cols.uc[slots[bi - 1]]; return bs; };
  const eventsAt = (i) => { let j = before(i); return lineAt(i).e.map((e) => (e.type === 'user' ? { ...e, k: ++j } : e)); };
  // the definitions read, by bytes about (their strings: a tool's name can be tens of KB), the least recently used out
  const lists = new Map(), defs = lru(DEF_BYTES), wires = new Map();
  const rowOf = (i) => store.rows.get(rids[i]);
  const listAt = (i) => {
    if (!lists.has(i)) {
      const l = listOf(store, rids[i]) || { bids: [], attrs: {} };
      lists.set(i, { bids: l.bids, attrs: l.attrs, m0: l.mb && l.mb.length ? l.mb[0] : 0, toks: l.bids.map((b, k) => { const a = attrOf(l.attrs[k]); return a ? `${b}\u001f${JSON.stringify(a)}` : b; }) });
    }
    return lists.get(i);
  };
  const replyAt = (i) => rowOf(i).reply || [];
  const defOf = (bid) => {
    if (defs.has(bid)) return defs.get(bid);
    const d = store.readDef(bid) || null;
    defs.set(bid, d, 128 + (d ? 2 * ((d.preview || '').length + (d.toolName || '').length + (d.label || '').length + (d.ref || '').length) : 0));
    return d;
  };
  // a tool_result whose own sniff is plain text takes its render from its tool_use's (render-kind.mjs inheritedRender): the tool_use
  // of the same id in the list it is first seen in (`list` a listAt(i): a tool_use is a block of the messages, from its first start m0)
  function useOf(b) {
    if (uses.has(b)) return uses.get(b);
    const u = defOf(b), v = u && u.f && u.f.type === 'tool_use' ? [u.f.id, inheritedRender(u.r) || null] : 0;
    uses.set(b, v, weigh(v));
    return v;
  }
  function renderIn(d, list) {
    const own = d.r || { as: 'text' }, useId = d.f && d.f.tool_use_id;
    if (own.as !== 'text' || useId == null) return own;
    for (let j = list.m0; j < list.bids.length; j++) { const u = useOf(list.bids[j]); if (u && u[0] === useId) return u[1] || own; }
    return own;
  }
  function wireDef(bid, list) {
    if (wires.has(bid)) return wires.get(bid);
    const d = defOf(bid);
    let w = null;
    if (d) {
      // a tool definition an older capture kept only as metadata (the projection's `verbatim: false`, analyze.mjs) says so on the wire
      const ff = d.verbatim === false && !(d.ff && d.ff.faithfulness) ? { ...d.ff, faithfulness: 'metadata' } : d.ff || {};
      w = { bid, fh: fhWire(d.fh), ref: d.ref ?? null, sec: d.sec, role: d.role, kind: d.kind, ...pick(d, OPTIONAL), ...(d.toolName ? { name: d.toolName } : null), ff, head: d.head,
        preview: d.preview, chars: d.chars, bytes: d.bytes, ...(d.resKey ? { resKey: d.resKey } : null), r: pick(renderIn(d, list), ['as', 'tone', 'title', 'f']) };
      if (ff.unaddressable) Object.assign(w, { ref: null, unaddressable: ff.unaddressable, inline: pick(d, BODY) });
    }
    wires.set(bid, w);
    return w;
  }
  function step(i, prev) {
    const C = listAt(i), row = rowOf(i), x = row.x || {};
    const ops = prev < 0 ? [[1, ...C.toks.map((_, k) => k)]] : opsOf(listAt(prev).toks, C.toks);
    const attrs = {};
    for (const op of ops) if (op[0] === 1) for (let k = 1; k < op.length; k++) { const a = attrOf(C.attrs[op[k]]); if (a) attrs[op[k]] = a; op[k] = C.bids[op[k]]; }
    return { rid: rids[i], parent: prev < 0 ? null : rids[prev], ops, reply: replyAt(i), attrs,
      detail: { norm: { stop_reason: x.stop_reason ?? null, usage: (x.facts ? x.facts.usage : x.nu) ?? null }, respRefs: x.respRefs || [],
        nonBlockKeys: x.nonBlockKeys || [], extraMessages: x.extraMessages || [], wire: x.wire ?? null } };
  }
  // release(keep): let go of every list but step `keep`'s, of the lines read and of the wire definitions (a render walks a span)
  const release = (keep) => { for (const k of lists.keys()) if (k !== keep) lists.delete(k); lines.clear(); wires.clear(); };
  return { L, n: rids.length, rids, lines, lineAt, eventsAt, listAt, replyAt, step, defOf: wireDef, release };
}

export async function run(ctx) {
  const { params: p, errors } = ctx;
  const id = one(p.id), key = one(p.lane), from = one(p.from), to = one(p.to), ledger = one(p.ledger);
  if (id == null) throw new QueryArgError('trocar query lane: --id is required (a session id; `trocar query sessions` lists them)');
  if (p.pack != null || p.tail != null) return fileAnswer(ctx, id, key != null || from != null || to != null || ledger != null);
  if (key == null) throw new QueryArgError('trocar query lane: --lane is required (a lane key; `trocar query session` lists the lanes)');
  if ([from, to, ledger].filter((x) => x != null).length > 1) throw new QueryArgError('trocar query lane: give at most one of --from, --to and --ledger');
  const after = ledger == null ? null : cursorOf(ledger);
  const st = await sessionState(ctx, id);
  const reading = st && st.pending ? { pending: st.pending } : null; // 3.5 `pending?`: this answer stops at the frontier
  const empty = (mark) => ({ lane: key, base: null, mark, ...reading, steps: [], defs: [], resources: [], seen: [], events: [], prev: null, next: null, ledger_next: null });
  if (!st) {
    errors.push({ where: `session/${id}`, code: 'session-unknown', reason: 'no session with this id among the captured records' });
    return empty(null);
  }
  errors.push(...st.errors);
  // a lane the session does not have (it can vanish between polls: `lanes_gone`) is an empty lane
  const { cols, log } = st.V;
  if (!cols.lanes.has(key)) return empty(markOn(st.plan, st.mark));
  const S = laneStepper(st, key), { L, rids, lines, listAt, replyAt, eventsAt } = S, n = rids.length, wireDef = S.defOf;
  const CS = (e) => e.type === 'compaction' || e.type === 'summarize';
  const flagged = [];
  for (let i = 0; i < n; i++) if (cols.cs[L.slots[i]]) flagged.push(i);
  // step i with ops against step i-1 (a keyframe when `keyframe`); its parent is step i-1 either way (the page's base names it)
  const stepAt = (i, keyframe) => { const s = S.step(i, keyframe || i === 0 ? -1 : i - 1); s.parent = i > 0 ? rids[i - 1] : null; return s; };
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
    for (const b of added) { const w = wireDef(b, listAt(i)); if (w) bytes += bytesOf(w); }
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
  const wireDefs = [...fresh.keys()].map((b) => wireDef(b, listAt(fresh.get(b)))).filter(Boolean);
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
    lane: key, base, mark: markOn(st.plan, st.mark), ...reading, steps, defs: wireDefs, resources: out[0], seen: out[1], events,
    prev: lo > 0 && steps.length ? rids[lo] : null, next: hi < n && steps.length ? rids[hi - 1] : null,
    ledger_next: i < owed.length ? Buffer.from(JSON.stringify([LISTS[last[0]], last[1]])).toString('base64url') : null,
  };
}

// `--pack <n>.<part>` / `--tail <part>` (3.5 §会话读): the NDJSON text of a sealed pack or of the open tail, as `{$text}` (named/index.mjs
// runQuery hands it on as the answer's bytes). Both render from the state (ctx-files.mjs renderSpan); the worker's tail is its file.
async function fileAnswer(ctx, id, others) {
  const { pack, tail } = ctx.params;
  if (others || (pack != null && tail != null)) throw new QueryArgError('trocar query lane: --pack and --tail go with --id only, one of them at a time');
  const m = pack != null ? /^(0|[1-9]\d{0,8})\.(main|rest)$/.exec(String(pack)) : /^()(main|rest)$/.exec(String(tail));
  if (!m) throw new QueryArgError(pack != null ? 'trocar query lane: --pack takes <n>.<part>: a pack number, a dot, and main or rest' : 'trocar query lane: --tail takes main or rest');
  const st = await sessionState(ctx, id);
  if (!st) { ctx.errors.push({ where: `session/${id}`, code: 'session-unknown', reason: 'no session with this id among the captured records' }); return {}; }
  const sealed = sealedOf(st), part = m[2];
  files(ctx, st); // the worker's files at this state
  if (pack == null) {
    if (ctx.writer === true && st.files) try { return { $text: (ctx.fs || nodeFs).readFileSync(tailFile(ctx.home ?? trocarHome(), id, part), 'utf8') }; } catch { /* rendered */ }
    return { $text: renderSpan(st, sealed, part, true) };
  }
  if (Number(m[1]) >= sealed) throw new QueryArgError(`trocar query lane: pack ${m[1]} is not sealed yet; its calls are in the tail`);
  return { $text: renderSpan(st, Number(m[1]), part) };
}

/** version(ctx) → the session's version (session.mjs: its member rows, frontier and cut) and the lane's parameters. */
export async function version(ctx) {
  const v = await sessionVersion(ctx);
  const p = ctx.params;
  return v && { key: JSON.stringify([v.key, one(p.lane), one(p.from), one(p.to), one(p.ledger), one(p.pack), one(p.tail)]), errors: v.errors };
}
