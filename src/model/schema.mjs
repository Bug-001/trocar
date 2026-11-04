// src/model/schema.mjs — map provider usage into the 3.2 canonical roles. Owns
// nothing provider-native beyond this file. (The DDL and its projection are gone
// with DuckDB: the readers read the raw files.)
const num = (x) => (x == null ? 0 : Number(x));

// Canonical usage mapping (RFC 3.2 "provider -> canonical" table), keyed by the WIRE FORMAT the usage
// object arrived in (D37 ①: the names are the wire's, whichever vendor answered): 'anthropic',
// 'openai-responses' / 'openai-responses-ws', 'openai-chat'. Anything else fails loud.
// opts.vendor (vendors.mjs::vendorOf, the upstream host's vendor, null = unknown): whether an ABSENT cache-write
// counter is NULL is decided per vendor (3.2 D37 note, 3.3:89) — see the Anthropic branch.
export function mapUsage(provider, raw = {}, opts = {}) {
  if (provider === 'openai-responses' || provider === 'openai-responses-ws') return mapResponses(raw || {});
  if (provider === 'openai-chat') return mapChat(raw || {});
  if (provider !== 'anthropic') {
    throw new Error(`mapUsage: no canonical mapping for provider '${provider}' (anthropic | openai-responses[-ws] | openai-chat)`);
  }
  const input_uncached = num(raw.input_tokens);
  const cache_read = num(raw.cache_read_input_tokens);
  // Anthropic itself always reports the write counter (absent there reads as 0, as before). Another vendor on this
  // wire that omits it (dsh / DeepSeek has no write concept, 3.2 Edge; GLM, Moonshot, an unknown relay: 3.3:89 OPEN,
  // default NULL + 标未知) reported nothing: NULL, never a 0 that AVG / COUNT would take as a reported zero (3.2).
  const writeUnreported = raw.cache_creation_input_tokens == null && 'vendor' in opts && opts.vendor !== 'anthropic';
  const cache_write = writeUnreported ? null : num(raw.cache_creation_input_tokens);
  const output = num(raw.output_tokens);
  const reasoning = raw.output_tokens_details?.thinking_tokens ?? null;
  const total_input = input_uncached + cache_read + (cache_write ?? 0);
  return { input_uncached, cache_read, cache_write, output, reasoning, total_input };
}

// The board's usage {read, create, fresh, out}: a projection of mapUsage's output, never a second mapping (3.2).
// An unreported write is NULL in the stored row too, never a 0: readers take the row's word and decode no frame to tell the two apart.
export function boardUsage(c) {
  return { read: c.cache_read, create: c.cache_write, fresh: c.input_uncached, out: c.output };
}

/** callUsage(x) → the provider usage a call's stored facts carry (x.facts.usage on the anthropic wire, x.nu on a flat one), in the
 *  canonical form by the wire it arrived in and the vendor that answered; null when the reply reported none, or in a wire format no
 *  mapping exists for. */
export function callUsage(x) {
  const raw = x.format === 'anthropic' ? x.facts && x.facts.usage : x.nu;
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length || !x.wire) return null;
  try { return mapUsage(x.format, raw, { vendor: x.wire.vendor }); } catch { return null; }
}

// OpenAI Responses: input_tokens is the TOTAL input (cached included); input_tokens_details.cached_tokens
// is the cache-read part. The wire has no cache-write counter except on relays that add
// cache_write_tokens — absent → NULL, never 0 (3.2: NULL = not reported).
function mapResponses(raw) {
  const total = num(raw.input_tokens);
  const det = raw.input_tokens_details || {};
  const read = num(det.cached_tokens);
  const write = det.cache_write_tokens == null ? null : num(det.cache_write_tokens);
  return { input_uncached: Math.max(0, total - read - (write ?? 0)), cache_read: read, cache_write: write,
    output: num(raw.output_tokens), reasoning: raw.output_tokens_details?.reasoning_tokens ?? null, total_input: total };
}
// OpenAI-compatible Chat Completions: prompt_tokens is the TOTAL input. DeepSeek reports the exact split
// (prompt_cache_hit_tokens / prompt_cache_miss_tokens), preferred when present; otherwise OpenAI's
// prompt_tokens_details.cached_tokens (Kimi may put cached_tokens at the top level). No Chat wire reports
// cache writes → cache_write NULL (3.2 Edge: DeepSeek has no write concept; NULL is not 0).
function mapChat(raw) {
  const hit = raw.prompt_cache_hit_tokens, miss = raw.prompt_cache_miss_tokens;
  const det = raw.prompt_tokens_details || {};
  const read = hit != null ? num(hit) : num(det.cached_tokens ?? raw.cached_tokens);
  const uncached = miss != null ? num(miss) : Math.max(0, num(raw.prompt_tokens) - read);
  return { input_uncached: uncached, cache_read: read, cache_write: null, output: num(raw.completion_tokens),
    reasoning: raw.completion_tokens_details?.reasoning_tokens ?? null, total_input: read + uncached };
}
