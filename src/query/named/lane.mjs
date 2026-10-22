// src/query/named/lane.mjs — `trocar query lane --id <id> --lane <key> [--from RID | --to RID]` (RFC 3.5 §会话读, 1.6 §4.1 / C.5).
//
// One lane's page of steps: each step's block-id list as ops against its parent step's list, its reply ids, the attributes its added
// positions carry and its detail; the definitions the page brings that the client does not hold yet; the lane's resources, seen
// paths and the events of the steps it covers. All from the session's state at the reduction frontier (src/query/named/session.mjs
// sessionState): the lane's rids, user counts and compaction / summarize flags from the step-order columns (src/query/session-doc.mjs),
// the events and ledger deltas from its fold log's call lines read by offset (the ledger replayed per answer: src/view/reduce.mjs
// laneLedger), each list materialised from the context projection (src/view/reduce.mjs listOf), the definitions and row facts from
// the projection's lines. No record is read (3.5 §会话读: a lane answer is the projection's).
import { sessionState, version as sessionVersion } from './session.mjs';
import { listOf, laneLedger } from '../../view/reduce.mjs';
import { inheritedRender } from '../../view/render-kind.mjs';
import { PAGE_BYTES, laneOf } from '../session-doc.mjs';
import { QueryArgError } from './index.mjs';

export const params = Object.freeze(['id', 'lane', 'from', 'to']);

const one = (v) => (v == null || v === '' ? null : String(v));
const pick = (o, keys) => { const out = {}; if (o) for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };
// A definition on the wire (3.5 §会话读 定义 closed set): `fh` as 22 base64url characters (the first 128 bits of the stored digest).
const OPTIONAL = ['label', 'name', 'mcp', 'cc'];
const BODY = ['text', 'block', 'desc', 'schema'];
const fhWire = (hex) => (typeof hex === 'string' && /^[0-9a-f]{32}/.test(hex) ? Buffer.from(hex.slice(0, 32), 'hex').toString('base64url') : null);
// a position's attributes on the wire, and the key a copy is matched by (a block id with the attributes it carries there)
const attrOf = (a) => { const o = pick(a, ['query', 'volatile']); return Object.keys(o).length ? o : null; };

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

export async function run(ctx) {
  const { params: p, errors } = ctx;
  const id = one(p.id), key = one(p.lane), from = one(p.from), to = one(p.to);
  if (id == null) throw new QueryArgError('trocar query lane: --id is required (a session id; `trocar query sessions` lists them)');
  if (key == null) throw new QueryArgError('trocar query lane: --lane is required (a lane key; `trocar query session` lists the lanes)');
  if (from != null && to != null) throw new QueryArgError('trocar query lane: --from and --to cannot be given together');
  const st = await sessionState(ctx, id);
  const empty = (mark) => ({ lane: key, base: null, mark, steps: [], defs: [], resources: [], seen: [], events: [], prev: null, next: null });
  if (!st) {
    errors.push({ where: `session/${id}`, code: 'session-unknown', reason: 'no session with this id among the captured records' });
    return empty(null);
  }
  errors.push(...st.errors);
  // a lane the session does not have (it can vanish between polls: `lanes_gone`) is an empty lane
  const { cols, log } = st.V;
  if (!cols.lanes.has(key)) return empty(st.mark);
  const { store } = st, rids = laneOf(cols, key), n = rids.length, slots = rids.map(cols.slotOf);
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

  const index = new Map(rids.map((r, i) => [r, i]));
  let lo, hi, base = null; // the page is steps [lo, hi)
  const held = new Set(); // ids the client holds: those of every step up to `from`
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
  if (from != null && index.has(from)) {
    const k = index.get(from);
    base = from;
    for (let i = 0; i <= k; i++) { for (const b of listAt(i).bids) held.add(b); for (const b of replyAt(i)) held.add(b); }
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
    hi = to != null && index.has(to) ? index.get(to) : n;
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
  for (const i of base == null ? [...flagged.filter((x) => x < lo), ...page, ...flagged.filter((x) => x >= hi)] : page) {
    events.push(...(i >= lo && i < hi ? eventsAt(i) : eventsAt(i).filter(CS)));
  }
  // the ledger replayed from every step's delta, each line read for it and let go
  const { resources, seen } = laneLedger(rids.map((rid, i) => (lines.has(i) ? lines.get(i) : (({ c, d }) => ({ c, d }))(log.read(...log.latest(rid))))),
    base == null ? -1 : index.get(base));
  return {
    lane: key, base, mark: st.mark, steps, defs: [...fresh.keys()].map((b) => wireDef(b, listAt(fresh.get(b)).bids)).filter(Boolean),
    resources, seen, events,
    prev: lo > 0 && steps.length ? rids[lo] : null, next: hi < n && steps.length ? rids[hi - 1] : null,
  };
}

/** version(ctx) → the session's version (session.mjs: its member rows, frontier and cut) and the lane's parameters. */
export async function version(ctx) {
  const v = await sessionVersion(ctx);
  const p = ctx.params;
  return v && { key: JSON.stringify([v.key, one(p.lane), one(p.from), one(p.to)]), errors: v.errors };
}
