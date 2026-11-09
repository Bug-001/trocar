// src/dissect/synth-key.mjs — synthesized session keys (RFC 3.4 Plan 合成键; the default rule is gate G11,
// to be checked against a lab capture). For a harness whose table row says
// `synth: true` (Hermes on a custom endpoint; Kimi without a body key), a keyless inference call joins the open message
// chain it extends among the calls of the same harness and the same system-prompt hash (within SYNTH_TTL_MS; its other steps SYNTH_GAP_MS) (one chain =
// one session, so concurrent agents with one system text stay apart); a history its harness's compaction rewrote joins
// the chain the compaction was tied to; otherwise it opens a new one. pid and connection are NOT inputs (3.4 关键区分:
// one Hermes gateway serves many tasks). Callers feed records in file order; the board and the ETL both read the
// capture files in sorted order, so they assign the same keys. A keyless call that is its harness's compaction request is first
// matched to an open session of the same harness, keyed or synthesized, by an earlier reply it carries whole, else by the user text both carry
// (3.4 按内容认亲; pi's summary request).
import { createHash } from 'node:crypto';
import { harnessOf, sessionKeyOf, bodyOf, hintsOf } from './harnesses.mjs';
import { boardDissectorFor } from './registry.mjs';
import { normResp as anthropicResp } from '../view/analyze.mjs';

export const SYNTH_GAP_MS = 30 * 60 * 1000;
// step 2 (extension) has no window: a chain stays open for it SYNTH_TTL_MS after its last call, at most SYNTH_CAP chains per harness
// (3.4 有界): twice the most chains one harness kept open in any 24 h of a real capture (pi, 510), rounded up to a power of two
export const SYNTH_TTL_MS = 24 * 60 * 60 * 1000, SYNTH_CAP = 1024;

const partsOf = (c) => (typeof c === 'string' ? [c]
  : Array.isArray(c) ? c.map((p) => (p && typeof p === 'object' ? (typeof p.text === 'string' ? p.text : '') : String(p ?? ''))) : []);
const textOf = (c) => partsOf(c).join('');
// The task anchor: the first system text of whichever wire the call used (Anthropic `system`, Responses
// `instructions`, else the first system / developer item of its `input`; Chat's leading system / developer
// message; Gemini's `systemInstruction` parts), block by block ([] when there is none).
export function systemPartsOf(body) {
  const b = body || {};
  if (b.system != null) return partsOf(b.system);
  if (typeof b.instructions === 'string') return [b.instructions];
  const si = b.systemInstruction ?? b.system_instruction;
  if (si && Array.isArray(si.parts)) return partsOf(si.parts);
  const item = Array.isArray(b.input) ? b.input.find((x) => x && (x.role === 'system' || x.role === 'developer')) : null;
  if (item) return partsOf(item.content);
  const first = Array.isArray(b.messages) ? b.messages[0] : null;
  if (first && (first.role === 'system' || first.role === 'developer')) return partsOf(first.content);
  return [];
}
/** The anchor as one text: its blocks joined. '' when there is none: still an anchor. */
export const systemTextOf = (body) => systemPartsOf(body).join('');

// 2026-10-06T00:00:00.000Z → 20261006T000000Z: no '/', '#' or ':', so the key is safe inside a raw_ref.
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// The board re-stamps the whole corpus on every request (each poll): a record's facts are derived once.
const FACTS = new WeakMap();

// ── kinship (3.4 合成键 · 按内容认亲) ─────────────────────────────────────────────────────────────────────────────────────
// A keyless call that is its harness's compaction request is looked for in the open sessions of that harness first, by the
// user text both carry. Fingerprints: every WIN-character window of the whitespace-collapsed text, hashed, kept when the hash
// falls on the sample (h % SAMPLE === 0) — the same rule on both sides, so a long enough shared fragment yields shared fingerprints
// when it falls within what both sides keep (the caps below; else the call falls back to its synthesized key). Character windows, not words: CJK has no spaces. A fingerprint is stored as h / SAMPLE (a small integer).
const WIN = 32, SAMPLE = 8, FP_CAP = 64, PROBE_CAP = 1024, STATE_CAP = 4096, MIN_SHARED = 2;
// Replies (3.4 按内容认亲, 有界): a compaction request carries earlier replies whole, which the user-text fingerprints never see. An
// item is a text by its sampled windows only (the same WIN and SAMPLE, a 64-bit hash each): their count n, the first and last
// ENDS_W, and a 64-bit digest of the whole list; a call carries the windows of its user texts, in order, the last HEAD_CAP (a compaction request's latest replies are at its end). A reply of
// REPLY_MIN collapsed chars has about 28 windows; one with fewer than MIN_WIN is not kept. REPLY_CAP: twice the most replies one
// harness kept in any 24 h of a real capture, rounded up to a power of two; OWNERS: the sessions one reply text is kept under, the latest.
export const REPLY_MIN = 256, MIN_WIN = 6, ENDS_W = 3, HEAD_CAP = 8192, REPLY_CAP = 4096, OWNERS = 8;
export const userTextsOf = (body) => {
  const b = body || {};
  if (typeof b.input === 'string') return [b.input];
  const items = [...(Array.isArray(b.messages) ? b.messages : []), ...(Array.isArray(b.input) ? b.input : []), ...(Array.isArray(b.contents) ? b.contents : [])];
  return items.filter((x) => x && x.role === 'user').map((x) => textOf(x.content ?? x.parts));
};
/** The text of every system or developer item in `messages` / `input`, whatever else the body has: the anchor above takes the first place only. */
export const systemItemsOf = (body) => [...(Array.isArray(body?.messages) ? body.messages : []), ...(Array.isArray(body?.input) ? body.input : [])]
  .filter((x) => x && (x.role === 'system' || x.role === 'developer')).map((x) => textOf(x.content));
// polynomial rolling hash over UTF-16 units, mod 2^32
const BASE = 0x01000193, TOP = (() => { let p = 1; for (let i = 1; i < WIN; i++) p = Math.imul(p, BASE); return p; })();
function fingerprints(texts, cap) {
  const out = new Set();
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, ' ').trim();
    let h = 0;
    for (let i = 0; i < t.length && out.size < cap; i++) {
      if (i >= WIN) h = (h - Math.imul(t.charCodeAt(i - WIN), TOP)) | 0;
      h = (Math.imul(h, BASE) + t.charCodeAt(i)) | 0;
      if (i >= WIN - 1 && (h >>> 0) % SAMPLE === 0) out.add((h >>> 0) / SAMPLE);
    }
    if (out.size >= cap) break;
  }
  return [...out];
}
const BASE2 = 0x5bd1e995, TOP2 = (() => { let p = 1; for (let i = 1; i < WIN; i++) p = Math.imul(p, BASE2); return p; })();
const collapse = (t) => t.replace(/\s+/g, ' ').trim();
// the sampled windows of one collapsed text, in order, kept where the fingerprint rule keeps one: two 32-bit rolling hashes (h, g)
// each, flat in a Uint32Array (8 B a window, off the V8 heap)
function windowsOf(t) {
  let out = new Uint32Array(64), n = 0, h = 0, g = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (i >= WIN) { const o = t.charCodeAt(i - WIN); h = (h - Math.imul(o, TOP)) | 0; g = (g - Math.imul(o, TOP2)) | 0; }
    h = (Math.imul(h, BASE) + c) | 0; g = (Math.imul(g, BASE2) + c) | 0;
    if (i >= WIN - 1 && (h >>> 0) % SAMPLE === 0) {
      if (n === out.length) { const o = new Uint32Array(2 * n); o.set(out); out = o; }
      out[n++] = h; out[n++] = g;
    }
  }
  return out.subarray(0, n);
}
const bytesOf = (u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
const wordsOf = (s) => { const b = Buffer.from(s, 'base64'), u = new Uint32Array(b.length >> 2); bytesOf(u).set(b.subarray(0, 4 * u.length)); return u; };
const digestOf = (w) => createHash('sha256').update(bytesOf(w)).digest().subarray(0, 8);
const DIG = 1 + 4 * ENDS_W; // where an item's digest starts, in words: after n and its first and last ENDS_W windows
/** A text as an item: n, its first and last ENDS_W windows and the digest, as base64 (one string, so the index keeps it as a scalar),
 *  or null when it is too short to tell. */
function itemOf(text) {
  const t = collapse(text);
  if (t.length < REPLY_MIN) return null;
  const w = windowsOf(t), n = w.length / 2;
  if (n < MIN_WIN) return null;
  const u = new Uint32Array(DIG + 2);
  u[0] = n; u.set(w.subarray(0, 2 * ENDS_W), 1); u.set(w.subarray(-2 * ENDS_W), 1 + 2 * ENDS_W); bytesOf(u).set(digestOf(w), 4 * DIG);
  return bytesOf(u).toString('base64');
}
// A compaction request's last HEAD_CAP windows of its user texts (space-joined, collapsed), as base64. Walked over their end only, so
// the work is bounded by what is kept, not by the request's length: a suffix of the raw text collapses to a suffix of the collapsed
// text, and a window is its WIN chars alone, so the suffix's windows are the whole's last ones exactly. Two passes at most: the last
// HEAD_SPAN chars, and when they hold fewer than HEAD_CAP windows (a run the sample rarely keeps, or much whitespace) the last
// 4 × HEAD_SPAN, whose windows are kept however few: at most 5 × HEAD_SPAN chars (about 390 K) are read per request, whatever its length.
const HEAD_SPAN = HEAD_CAP * SAMPLE * 1.2;
function headsOf(texts) {
  for (const need of [HEAD_SPAN, 4 * HEAD_SPAN]) {
    const tail = [];
    let len = -1;
    for (let i = texts.length - 1; i >= 0 && len < need; i--) { tail.push(texts[i]); len += texts[i].length + 1; }
    const s = tail.reverse().join(' '), all = s.length <= need && tail.length === texts.length, w = windowsOf(collapse(all ? s : s.slice(-need)));
    if (all || need > HEAD_SPAN || w.length >= 2 * HEAD_CAP) return bytesOf(w.subarray(-2 * HEAD_CAP)).toString('base64');
  }
}
// where each window starts in a call's list, by its first hash (a multiple of SAMPLE, so h / SAMPLE is a small integer)
function startsOf(w) {
  const at = new Map();
  for (let i = 0; 2 * i < w.length; i++) { const k = w[2 * i] / SAMPLE, a = at.get(k); if (a) a.push(i); else at.set(k, [i]); }
  return at;
}
// whether the call's windows `w` hold the item `it` (wordsOf) whole: a run that starts with its first windows, ends n later with its
// last, and hashes to its digest. Ends that match with another digest come from a run that repeats (the same windows over and over):
// past MISSES of them the item is taken as not held, so one item costs at most MISSES digests of its n windows, however long the run
const MISSES = 8;
function holds(w, at, it) {
  const n = it[0], m = w.length / 2;
  let miss = 0;
  for (const p of at.get(it[1] / SAMPLE) || []) {
    if (p + n > m) break;
    let ok = true;
    for (let j = 0; ok && j < 2 * ENDS_W; j++) ok = w[2 * p + j] === it[1 + j] && w[2 * (p + n - ENDS_W) + j] === it[1 + 2 * ENDS_W + j];
    if (!ok) continue;
    if (digestOf(w.subarray(2 * p, 2 * (p + n))).equals(bytesOf(it).subarray(4 * DIG))) return true;
    if (++miss === MISSES) return false;
  }
  return false;
}
// the reply as the product reads it (the board's text), whatever the wire
const replyOf = (rec) => { const d = boardDissectorFor(rec), r = d ? d.normResp(rec) : anthropicResp(rec); return itemOf((r && r.text) || ''); };

// ── chains (3.4 合成键) ───────────────────────────────────────────────────────────────────────────────────────────────────────
// A call's history as cumulative hashes: c_1 = h(item_1), c_i = h(c_{i-1} + '\n' + item_i), h = the first 16 hex of SHA-256, each item
// JSON with every `cache_control` key dropped (it moves between calls on real wires). History items: `messages`, else an `input`
// array, else a string `input`, else Gemini's `contents`. A call extends a chain when the chain's tail (its last call's whole history) is among the hashes kept:
// the last TAIL positions, and before them the turn boundaries — where the model's output starts (an item with role `assistant` or `model`, or a
// Responses `reasoning` / `*_call` item, after one that is not): a previous call ends there however many items its turn returned
// (one assistant message and N parallel tool results), so a turn costs one hash. At most CHAIN_K, oldest first. `items`: the last RECENT
// items each by its own hash: a harness edits older items in place or drops turns, which breaks every cumulative hash after it; the items it
// did not touch stay as they were. It may be the tool results or the model's messages that change, so all count (step 3).
const CHAIN_K = 12, TAIL = 4, RECENT = 12, MIN_ITEMS = 2, ENDS = 2;
const h16 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const bare = (k, v) => (k === 'cache_control' ? undefined : v);
// the replacer's bytes, paid only when the key is there: a key always serializes as `"cache_control"`; a string holding it is a false hit, re-encoded
const enc = (it) => { const j = JSON.stringify(it) ?? 'null'; return j.includes('"cache_control"') ? JSON.stringify(it, bare) ?? 'null' : j; };
const fromModel = (it) => !!it && (it.role === 'assistant' || it.role === 'model' || it.type === 'reasoning' || /_call$/.test(it.type ?? ''));
// `prev` ({js, cs}: the group's previous call's item encodings and cumulative hashes, or null): while this call's items are byte-equal
// to its first ones, its cumulative hash there is the same and is taken, not recomputed (an agent resends its whole history each call).
// → also `memo`: this call's, for the next call of the group.
function chainOf(body, prev = null) {
  const b = body || {};
  const items = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : typeof b.input === 'string' ? [b.input] : Array.isArray(b.contents) ? b.contents : [];
  const out = [], js = new Array(items.length), cs = new Array(items.length);
  let c = null, same = !!prev;
  items.forEach((it, i) => {
    const j = (js[i] = enc(it));
    if (same && j === prev.js[i]) c = prev.cs[i];
    else {
      same = false;
      const h = createHash('sha256'); // streamed: the same digest as of `c + '\n' + j`, without the copy
      c = (c == null ? h : h.update(c).update('\n')).update(j, 'utf8').digest('hex').slice(0, 16);
    }
    cs[i] = c;
    if (i >= items.length - TAIL || (fromModel(items[i + 1]) && !fromModel(it))) out.push(c);
  });
  const recent = []; // own hashes of the last RECENT items only; system / developer items left out: every agent of the group has those
  for (let i = items.length - 1; i >= 0 && recent.length < RECENT; i--) if (items[i]?.role !== 'system' && items[i]?.role !== 'developer') recent.push(h16(js[i]).slice(0, 8));
  return { chain: out.slice(-CHAIN_K), items: recent.reverse(), memo: { js, cs } };
}

/** What a call brings to the rule, or null when it takes no part in it. Keyless → {harness, ms, hash, fp, probe, reply, heads, late, chain, items, mark}: `fp` is the
 *  fingerprints its session is recognized by, `probe` the ones it looks for its session with when it is the harness's
 *  compaction request, else null; `reply` its reply as an item (itemOf) or null, `heads` a compaction request's last user-text windows (headsOf); `chain` its history's last cumulative hashes and `items` its last items' own (chainOf); `mark` whether it carries its harness's
 *  compaction text marker without being the compaction request (Hermes's call after a compaction). Keyed (a `synth: true` harness only) → {harness, ms, key, fp, reply}: a keyed call never opens or moves a synthesized group;
 *  where its row has `chainLane` and it declares no lane, also {hash, chain, items}, for its chain inside its keyed session. A reader that cannot afford the body later (the
 *  segment index, 1.6 §4.1) stores these and asks the assigner below with them. `memo` (a Map, optional): the last keyless call of
 *  each group (harness, system-text hash) as chainOf left it, so a reader of many calls in order (one segment's build) hashes each
 *  history's shared prefix once; the caller drops it when done. The facts are the same with or without it. */
export function synthFactsOf(rec, memo = null) {
  if (!rec || typeof rec !== 'object') return null;
  if (FACTS.has(rec)) return FACTS.get(rec);
  const f = factsOf(rec, memo);
  FACTS.set(rec, f);
  return f;
}
function factsOf(rec, memo) {
  // a call kept as a log line only (D40) has no system text to anchor a task by: it stays keyless, and is shown as such
  if (rec.is_llm_call !== true || rec.body_retention === 'log') return null;
  const h = harnessOf(rec);
  if (!h.row || h.row.synth !== true) return null;
  const ms = Date.parse(rec.ts_request || rec.ts || '');
  if (!Number.isFinite(ms)) return null; // no time, no window: the call stays keyless (and is shown as such)
  const key = sessionKeyOf(rec).key;
  const body = bodyOf(rec), texts = userTextsOf(body), fp = fingerprints([...texts].reverse(), FP_CAP);
  const hint = hintsOf(rec);
  // a keyed call brings its chain only where its row splits a keyed session by chains (3.4 带键会话里的消息链) and it declares no lane
  const reply = replyOf(rec);
  if (key && (!h.row.chainLane || hint.lane != null)) return { harness: h.id, ms, key, fp, reply };
  const hash = createHash('sha256').update(systemTextOf(body), 'utf8').digest('hex'), group = h.id + '\0' + hash;
  const { chain, items, memo: mine } = chainOf(body, memo ? memo.get(group) : null);
  if (memo) memo.set(group, mine);
  if (key) return { harness: h.id, ms, key, fp, reply, hash, chain, items };
  const asks = compactionRequest(rec, h.row, hint), probe = asks ? fingerprints(texts, PROBE_CAP) : null;
  // `late`: how many of `fp` (a prefix: the texts are taken newest first) come from user texts after the first one
  return { harness: h.id, ms, hash, fp, probe, reply, heads: asks ? headsOf(texts) : null,
    late: fingerprints([...texts.slice(1)].reverse(), FP_CAP).length, chain, items, mark: !probe && hint.compactionMarker === true };
}

// The call that is the compaction request: a header / request-kind hint, or its harness's text marker in one block of its own system
// text (pi's summary request; on the Anthropic OAuth wire pi's prompt is the second block, after Claude Code's identity block), each
// block read as a JSON string so a marker anchored on a string's start holds. A marker in the history (Hermes
// keeps one in every later call) marks a turn of the session it is in, not a call looking for one (3.4 按内容认亲).
function compactionRequest(rec, row, hint) {
  if (hint.compaction === true) return true;
  if (!hint.compactionMarker) return false;
  const blocks = systemPartsOf(bodyOf(rec)).map((t) => JSON.stringify(t));
  return row.compaction.some((c) => c.marker && blocks.some((b) => c.marker.test(b)));
}

/** The rule itself (gate G11), over those facts in the order the calls were captured → {key, kin, lane?} | null. Every call adds its
 *  fingerprints to its session's entry; a keyed call gets nothing else (null), except one with a hash: steps 2-4 below, among the
 *  chains of its key and system-prompt hash, give its chain's name as `lane` ({key: null, kin: false, lane}; 3.4 带键会话里的消息链). A keyless call, among the open chains of its
 *  harness and system-prompt hash last seen within `gapMs` (step 2: within SYNTH_TTL_MS):
 *  1. with a probe, joins the session one of the replies its user texts hold whole names (byReplies; any call's reply is kept under its
 *     session, a probe's only when it found one), else the session of its harness — keyed, or a chain of another system-prompt group — that
 *     shares the most fingerprints with it (at least MIN_SHARED; a tie → the later last call) — kin: true; a chain so found is `pending`;
 *  2. else the chain whose tail sits latest in its own chain (a tie → the later last call), however long ago its last call;
 *  3. else, among the `pending` chains (and every chain when it carries its harness's marker), the one sharing the most
 *     fingerprints (at least MIN_SHARED; a tie → the later last call): its rewritten history replaces the chain's tail. Without the
 *     marker only the `late` fingerprints count: a new agent's first user text (one system text, a shared brief) is no rewrite;
 *  4. else a new chain, a new session (at most SYNTH_CAP chains per harness: the oldest goes). */
const REPLY = '\u0003';
export function createSynthAssigner({ gapMs = SYNTH_GAP_MS, open = new Map() } = {}) {
  // `${harness}\0${hash}\0${key}` → { key, lastMs, fp, tail, pending }; `\u0001${harness}\0${key}` → { key, lastMs, fp }; a keyed
  // session's chains `\u0002${harness}\0${session key}\0${hash}\0${chain}` as the first, without fp (fp: a
  // Set, replaced, never mutated, so a shallow copy of an entry is a snapshot). A caller that resumes the rule part-way
  // (src/query/rows.mjs) hands in the state it saved.
  // a reply kept for kinship `\u0003${harness}\0${item}` (itemOf) → { lastMs, owners }: the session keys it was kept under, the latest
  // last; the entries in the order they were last kept, so the first is the oldest. An entry is replaced, never mutated, so a copy
  // of `open` may share it (src/query/rows.mjs copyOpen)
  const mine = (g, harness) => g.startsWith(harness + '\0') || g.startsWith('\u0001' + harness + '\0') || g.startsWith('\u0002' + harness + '\0') || g.startsWith(REPLY + harness + '\0');
  let counts = null; // harness → how many replies it keeps, from `open` the first time it is asked
  const count = (harness, d = 0) => {
    if (!counts) { counts = new Map(); for (const g of open.keys()) if (g[0] === REPLY) { const x = g.slice(1, g.indexOf('\0')); counts.set(x, (counts.get(x) || 0) + 1); } }
    const n = (counts.get(harness) || 0) + d;
    counts.set(harness, n);
    return n;
  };
  const keep = (harness, item, key, ms) => {
    if (!item || key == null) return;
    const pre = REPLY + harness + '\0', g = pre + item, cur = open.get(g);
    if (cur) open.delete(g);
    else if (count(harness, 1) > REPLY_CAP) for (const x of open.keys()) if (x.startsWith(pre)) { open.delete(x); count(harness, -1); break; }
    const owners = !cur ? [key] : cur.owners[cur.owners.length - 1] === key ? cur.owners : [...cur.owners.filter((k) => k !== key), key].slice(-OWNERS);
    open.set(g, { lastMs: Math.max(cur ? cur.lastMs : ms, ms), owners });
  };
  // the session the replies a compaction request carries name (3.4 按内容认亲): the latest kept of them, when one session kept it;
  // kept under several, the one of those holding the most of the replies; else none
  const byReplies = (harness, heads, ms) => {
    const w = heads ? wordsOf(heads) : null;
    if (!w || w.length < 2 * MIN_WIN) return null;
    const at = startsOf(w), pre = REPLY + harness + '\0', hits = [];
    for (const [g, e] of open) if (g.startsWith(pre) && ms - e.lastMs <= SYNTH_TTL_MS && holds(w, at, wordsOf(g.slice(pre.length)))) hits.push(e);
    if (!hits.length) return null;
    const last = hits[hits.length - 1].owners;
    if (last.length === 1) return last[0];
    const n = new Map(last.map((k) => [k, 0]));
    for (const e of hits) for (const k of e.owners) if (n.has(k)) n.set(k, n.get(k) + 1);
    const top = Math.max(...n.values()), won = [...n].filter(([, c]) => c === top);
    return won.length === 1 ? won[0][0] : null;
  };
  // past 2 × gapMs a chain keeps only what step 2 reads (its tail), until SYNTH_TTL_MS; a keyed entry goes, and a chain with no tail;
  // a reply stays until SYNTH_TTL_MS after it was last kept
  const prune = (harness, ms) => {
    count(harness); // the counts from `open` before this deletes from it
    for (const [g, e] of open) {
      if (!mine(g, harness) || ms - e.lastMs <= 2 * gapMs) continue;
      if (g[0] === REPLY) { if (ms - e.lastMs > SYNTH_TTL_MS) { open.delete(g); count(harness, -1); } continue; }
      if (e.tail == null || ms - e.lastMs > SYNTH_TTL_MS) open.delete(g);
      else if (e.items || e.fp) open.set(g, { key: e.key, lastMs: e.lastMs, tail: e.tail });
    }
  };
  const grow = (fp, add) => {
    let next = fp || new Set();
    for (const x of add || []) if (!next.has(x)) { if (next === fp) next = new Set(fp); next.add(x); }
    return next.size > STATE_CAP ? new Set([...next].slice(next.size - STATE_CAP)) : next; // FIFO: the oldest go first
  };
  const shared = (e, fp) => { let n = 0; if (e.fp) for (const x of fp || []) if (e.fp.has(x)) n++; return n; };
  return (facts) => {
    if (!facts || !facts.harness || !Number.isFinite(facts.ms)) return null;
    const { harness, ms } = facts;
    if (facts.key != null) {
      const g = '\u0001' + harness + '\0' + facts.key;
      const cur = open.get(g);
      if (!cur) prune(harness, ms);
      open.set(g, { key: facts.key, lastMs: Math.max(cur ? cur.lastMs : ms, ms), fp: grow(cur && cur.fp, facts.fp) });
      keep(harness, facts.reply, facts.key, ms);
      if (facts.hash == null) return null;
      return { key: null, kin: false, lane: chainIn('\u0002' + harness + '\0' + facts.key + '\0' + facts.hash + '\0', { ...facts, fp: null, mark: false }).key };
    }
    if (facts.hash == null) return null;
    const got = keyless(facts);
    // the reply of a compaction request that found no session is kept under none
    if (got && !(facts.probe && !got.kin)) keep(harness, facts.reply, got.key, ms);
    return got;
  };
  function keyless(facts) {
    const { harness, ms } = facts, own = harness + '\0' + facts.hash + '\0';
    // a request with no fingerprints prunes nothing, as before replies: byReplies reads a reply's age itself, and step 3 counts a stale chain's items
    if (facts.probe && facts.probe.length) prune(harness, ms);
    const named = facts.probe ? byReplies(harness, facts.heads, ms) : null;
    if (named != null) {
      for (const [g, e] of open) if (g[0] !== REPLY && g[0] !== '\u0002' && e.key === named && mine(g, harness)) { e.lastMs = Math.max(e.lastMs, ms); if ('tail' in e) e.pending = true; break; }
      return { key: named, kin: true };
    }
    if (facts.probe && facts.probe.length) {
      let best = null, bestN = 0;
      for (const [g, e] of open) {
        if (g[0] === '\u0002' || g[0] === REPLY || g.startsWith(own) || !mine(g, harness) || Math.abs(ms - e.lastMs) > gapMs) continue;
        const n = shared(e, facts.probe);
        if (n >= MIN_SHARED && (n > bestN || (n === bestN && e.lastMs > best.lastMs))) { best = e; bestN = n; }
      }
      if (best) {
        best.lastMs = Math.max(best.lastMs, ms);
        if ('tail' in best) best.pending = true;
        return { key: best.key, kin: true };
      }
    }
    return chainIn(own, facts);
  }
  // steps 2-4 among the chains whose entry names start with `own`
  function chainIn(own, facts) {
    const { harness, ms } = facts, chain = facts.chain || [];
    const live = [], reach = [];
    for (const [g, e] of open) if (g.startsWith(own) && Math.abs(ms - e.lastMs) <= SYNTH_TTL_MS) { reach.push(e); if (Math.abs(ms - e.lastMs) <= gapMs) live.push(e); }
    const join = (e) => {
      e.tail = chain.length ? chain[chain.length - 1] : null; e.items = facts.items; e.lastMs = Math.max(e.lastMs, ms); e.fp = grow(e.fp, facts.fp); e.pending = false;
      return { key: e.key, kin: false };
    };
    let best = null, bestAt = -1;
    for (const e of reach) {
      const at = e.tail == null ? -1 : chain.lastIndexOf(e.tail);
      if (at >= 0 && (at > bestAt || (at === bestAt && e.lastMs > best.lastMs))) { best = e; bestAt = at; }
    }
    if (best) return join(best);
    if (!chain.length && live.length) { // no history to judge by (3.4 合成键 step 4): the group's latest chain, which keeps the tail it has
      const e = live.reduce((x, y) => (y.lastMs > x.lastMs ? y : x));
      e.lastMs = Math.max(e.lastMs, ms); e.fp = grow(e.fp, facts.fp);
      return { key: e.key, kin: false };
    }
    // older items edited, or the history rewritten with some kept (3.4 合成键 step 3). It must hold how the chain's last call ended, which a
    // fork does not; an item another chain of the group holds too ("Done.") says nothing, a chain past the gap counts as another.
    let bestN = MIN_ITEMS - 1;
    if (facts.items?.length) {
      const holders = new Map();
      for (const [g, e] of open) if (g.startsWith(own)) for (const x of new Set(e.items || [])) holders.set(x, (holders.get(x) || 0) + 1);
      for (const e of live) {
        const had = e.items || [];
        if (!had.slice(-ENDS).some((x) => facts.items.includes(x))) continue;
        const n = new Set(facts.items.filter((x) => had.includes(x) && holders.get(x) === 1)).size;
        if (n > bestN || (best && n === bestN && e.lastMs > best.lastMs)) { best = e; bestN = n; }
      }
    }
    if (best) return join(best);
    bestN = 0;
    const evidence = facts.mark ? facts.fp : (facts.fp || []).slice(0, facts.late || 0);
    for (const e of live) {
      if (!e.pending && !facts.mark) continue;
      const n = shared(e, evidence);
      if (n >= MIN_SHARED && (n > bestN || (n === bestN && e.lastMs > best.lastMs))) { best = e; bestN = n; }
    }
    if (best) return join(best);
    prune(harness, ms);
    const base = `synth-${harness}-${facts.hash.slice(0, 12)}-${stampOf(ms)}`;
    let key = base;
    for (let i = 2; open.has(own + key); i++) key = `${base}-${i}`;
    let oldest = null, count = 0;
    for (const [g, e] of open) if ('tail' in e && mine(g, harness)) { count++; if (!oldest || e.lastMs < oldest[1].lastMs) oldest = [g, e]; }
    if (count >= SYNTH_CAP) open.delete(oldest[0]);
    open.set(own + key, { key, lastMs: ms, fp: grow(null, facts.fp), tail: chain.length ? chain[chain.length - 1] : null, items: facts.items, pending: false });
    return { key, kin: false };
  }
}
