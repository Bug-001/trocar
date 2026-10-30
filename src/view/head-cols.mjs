// head-cols.mjs — the step columns of a `session --head` answer (3.5 §会话读 `cols`; 4.4 静态面 shared module): three bytes a step (or a
// cell of `bucket` steps) — its height against `peak` (0–255), its largest composition bucket (high 4 bits, an index in the composition
// keys) and that bucket's share in 15ths (low 4 bits), its flag bits. One definition for the worker that writes the head and the board
// that draws the rough page from it. Pure, imports nothing: the browser fetches it as is.
/** The flag bits of a step, from the low bit: compaction, inferred compaction, a cache break that changed the prefix, failed, a user ask,
 *  summarize, a subagent spawned, no usage (a call that did not fail and reported none). */
export const FLAG = Object.freeze({ compaction: 1, inferred: 2, cacheBreak: 4, failed: 8, user: 16, summarize: 32, spawn: 64, noUsage: 128 });
/** cellsOf(base64) → the bytes of `cols` (3 a cell; empty for '' or anything that is not base64). */
export function cellsOf(b64) {
  let bin = ''
  try { bin = atob(String(b64 || '')) } catch { return new Uint8Array(0) }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
