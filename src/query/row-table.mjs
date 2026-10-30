// src/query/row-table.mjs — one segment's index rows, held ONCE, as columns (3.5 §内存有界 `steady`).
//
// The rows a reader keeps for every query (src/query/index-build.mjs `warmSegmentIndex`) were ~728 B of V8 heap each as
// parsed objects. Here each column is a code array plus, when a value needs one, a Float64 payload; both are typed arrays
// whose backing stores live outside the V8 heap (resident memory only). What stays on the heap is each column's dictionary,
// the rows kept whole (exceptions) and the stores themselves.
//
// Each value is tagged by WHAT IT IS, never by which field it is in, so there is no field list here: a finite number (its
// payload), null, an ISO instant that round-trips through `new Date(ms).toISOString()` (payload ms), this segment's own
// record id `<segment>:<n>` (payload n), else a dictionary code (any other JSON scalar). The columns are the first entry's
// keys in their order; an entry with another key set (or order), or with a value that is no scalar, is kept whole.
//
// A view = (store, n), immutable. `concat` appends in place when the view is the store's tip, only widens when the store
// already holds the same rows past it (records are immutable, invariant 2: the reader's in-memory scan of a segment's tail
// and the keeper's later index lines are the same rows), and copies otherwise — so a live segment's poll costs its new rows.
const NULL = 0, NUM = 1, ISO = 2, OWN = 3, DICT = 4;
const START = 128; // rows: past V8's 64-byte on-heap threshold even for a Uint8 column, so every backing store is external
const MAX = (a) => (a instanceof Uint8Array ? 0xff : a instanceof Uint16Array ? 0xffff : 0xffffffff);
const resize = (a, cap) => { const b = new a.constructor(cap); b.set(a); return b; };

const isoMs = (v) => {
  if (v.charCodeAt(v.length - 1) !== 90) return null; // 'Z': toISOString always ends so
  const ms = Date.parse(v);
  return Number.isFinite(ms) && isoText(ms) === v ? ms : null;
};
const ownNo = (pre, v) => {
  if (pre === null || !v.startsWith(pre)) return null;
  const rest = v.slice(pre.length), n = Number(rest);
  return Number.isSafeInteger(n) && n >= 0 && String(n) === rest ? n : null;
};
// the entry's keys are the store's, in order, and every value is a scalar
const fits = (keys, e) => {
  let k = 0;
  for (const key in e) { if (key !== keys[k++] || (typeof e[key] === 'object' && e[key] !== null)) return false; }
  return k === keys.length;
};
const EXC = { toJSON() { return { ...this }; } };

// What a store holds in the V8 heap (3.5 §内存有界 `steady`), each constant measured with liveHeap() (forced GC before and after,
// divided by the count; 2026-10-23, node 22) × 1.25: the store with its view and Row class 1,560 B; a column 800 B (its object, the
// two typed-array objects — their backing stores are outside the heap, resident memory only, not charged —, its dictionary's array
// and Map, its getter); a dictionary entry 68 B (its slot, its Map entry, the string's header) plus the string's characters, 2 B
// each (a two-byte string's; one-byte measured 0.96 B); a row kept whole 1,700 B (an index row's 21 keys and their strings) plus its
// JSON text's characters at the same 2 B.
const TABLE_HEAP = 1_950, COLUMN_HEAP = 1_000, DICT_HEAP = 85, EXC_HEAP = 2_150;
const CHAR_HEAP = 2.5;
const sized = (v) => Math.ceil(CHAR_HEAP * (typeof v === 'string' ? v.length : 0));

function store(own) { return { own, pre: own == null ? null : `${own}:`, keys: null, cols: null, n: 0, cap: 0, exc: new Map(), Row: null, heap: TABLE_HEAP }; }

// an ISO cell back to its text: the same string as `new Date(ms).toISOString()` (which costs ~0.7 µs, and a scan reads every row's
// time), from the day's 'YYYY-MM-DDT' (rows run in time order, so one slot holds it) and the time of day; years outside 0000–9999
// (a sign and six digits) go through toISOString
const DAY = 864e5, MAX_MS = 253402300800000, p2 = (n) => (n < 10 ? '0' : '') + n;
let day = NaN, dayText = '';
export function isoText(ms) {
  if (!(ms >= 0 && ms < MAX_MS)) return new Date(ms).toISOString();
  const d = Math.floor(ms / DAY);
  if (d !== day) { day = d; dayText = new Date(d * DAY).toISOString().slice(0, 11); }
  const t = ms - d * DAY, h = Math.floor(t / 36e5), m = Math.floor(t / 6e4) % 60, sec = Math.floor(t / 1e3) % 60, f = t % 1e3;
  return `${dayText}${p2(h)}:${p2(m)}:${p2(sec)}.${f < 100 ? (f < 10 ? '00' : '0') : ''}${f}Z`;
}

function get(s, col, i) {
  const c = col.codes[i];
  return c >= DICT ? col.dict[c - DICT] : c === NULL ? null : c === NUM ? col.pay[i] : c === ISO ? isoText(col.pay[i]) : s.pre + col.pay[i];
}

function put(s, col, i, v) {
  let code = NULL, p = null;
  if (v === null) code = NULL;
  else if (typeof v === 'number' && Number.isFinite(v)) { code = NUM; p = v; }
  else if (typeof v === 'string' && (p = isoMs(v)) !== null) code = ISO;
  else if (typeof v === 'string' && (p = ownNo(s.pre, v)) !== null) code = OWN;
  else {
    let k = col.code.get(v);
    if (k === undefined) { k = col.dict.length; col.dict.push(v); col.code.set(v, k); s.heap += DICT_HEAP + sized(v); }
    code = DICT + k;
  }
  if (p !== null) (col.pay || (col.pay = new Float64Array(s.cap)))[i] = p;
  if (code > MAX(col.codes)) { const b = new (code > 0xffff ? Uint32Array : Uint16Array)(s.cap); b.set(col.codes); col.codes = b; }
  col.codes[i] = code;
}

function append(s, e) {
  if (s.n === s.cap) {
    s.cap = s.cap ? s.cap * 2 : START;
    if (s.cols) for (const col of s.cols) { col.codes = resize(col.codes, s.cap); if (col.pay) col.pay = resize(col.pay, s.cap); }
  }
  if (!s.keys) setKeys(s, Object.keys(e));
  const i = s.n++;
  if (!fits(s.keys, e)) { s.exc.set(i, Object.freeze(Object.assign(Object.create(EXC), e))); s.heap += EXC_HEAP + sized(JSON.stringify(e)); return; }
  for (let c = 0; c < s.keys.length; c++) put(s, s.cols[c], i, e[s.keys[c]]);
}

function setKeys(s, keys) {
  s.keys = keys;
  s.heap += COLUMN_HEAP * keys.length;
  s.cols = keys.map(() => ({ codes: new Uint8Array(s.cap), pay: null, dict: [], code: new Map() }));
  // a row: its position, behind getters on a per-store prototype — read-only, and `{ ...row }` copies nothing (use toJSON)
  class Row {
    #i;
    constructor(i) { this.#i = i; }
    static pos(r) { return r.#i; }
    toJSON() { const o = {}; for (let c = 0; c < keys.length; c++) o[keys[c]] = get(s, s.cols[c], this.#i); return o; }
  }
  keys.forEach((k, c) => Object.defineProperty(Row.prototype, k, { get() { return get(s, s.cols[c], Row.pos(this)); } }));
  s.Row = Row;
}

// the store's row i is the entry e
function same(s, i, e) {
  const x = s.exc.get(i);
  if (x) return JSON.stringify(x) === JSON.stringify(e);
  if (!fits(s.keys, e)) return false;
  for (let c = 0; c < s.keys.length; c++) if (get(s, s.cols[c], i) !== e[s.keys[c]]) return false;
  return true;
}

class RowView {
  #s; #n;
  constructor(s, n) { this.#s = s; this.#n = n; Object.freeze(this); }
  static store(v) { return v.#s; }
  get length() { return this.#n; }
  at(i) {
    i = Math.trunc(i) || 0;
    if (i < 0) i += this.#n;
    if (i < 0 || i >= this.#n) return undefined;
    const s = this.#s;
    return (s.exc.size && s.exc.get(i)) || new s.Row(i);
  }
  *[Symbol.iterator]() { for (let i = 0; i < this.#n; i++) yield this.at(i); }
  map(fn) { const out = new Array(this.#n); for (let i = 0; i < this.#n; i++) out[i] = fn(this.at(i), i, this); return out; }
  filter(fn) { const out = []; for (let i = 0; i < this.#n; i++) { const r = this.at(i); if (fn(r, i, this)) out.push(r); } return out; }
  slice(a = 0, b = this.#n) {
    const n = this.#n, at = (x) => (x < 0 ? Math.max(n + x, 0) : Math.min(x, n));
    const out = [];
    for (let i = at(Math.trunc(a) || 0); i < at(Math.trunc(b) || 0); i++) out.push(this.at(i));
    return out;
  }
  /** concat(entries) → a view of these rows then `entries` (plain entries, or another view's rows). */
  concat(more) {
    const list = Array.isArray(more) ? more : [...more].map((r) => r.toJSON());
    const s = this.#s;
    let n = this.#n, k = 0;
    while (k < list.length && n < s.n && same(s, n, list[k])) { n++; k++; }
    if (k < list.length && n < s.n) return rowTable([...this.map((r) => r.toJSON()), ...list], s.own);
    for (; k < list.length; k++, n++) append(s, list[k]);
    return n === this.#n ? this : new RowView(s, n);
  }
}

/** rowTable(entries, own) → a view over a new store holding `entries`; `own` = the segment whose record ids are `<own>:<n>`. */
export function rowTable(entries = [], own = null) {
  const s = store(own);
  for (const e of entries) append(s, e);
  return new RowView(s, s.n);
}
/** heapOf(...views) → the V8 heap their stores hold (the constants above), each store once however many views share it;
 *  what is no view holds none here. */
export const heapOf = (...views) => { let n = 0; for (const s of new Set(views.filter(isRowTable).map(RowView.store))) n += s.heap; return n; };
// A view's cells with no row object: `keysOf(view)` its columns, `wholeAt(view, i)` row i when it is kept whole (else undefined),
// `cellAt(view, c, i)` row i's value in column c.
export const keysOf = (view) => RowView.store(view).keys;
export const wholeAt = (view, i) => { const s = RowView.store(view); return s.exc.size ? s.exc.get(i) : undefined; };
export const cellAt = (view, c, i) => { const s = RowView.store(view); return get(s, s.cols[c], i); };
/** isRowTable(x) → whether x is a view rowTable made. */
export function isRowTable(x) { return x instanceof RowView; }
