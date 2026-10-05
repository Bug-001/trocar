// cache.mjs — prompt-cache simulation (README "Prompt cache model"). One store per mock instance with
// its own clock, so a test can expire entries without waiting. Every count comes from one estimator,
// ceil(bytes / 4) over a canonical serialization of the prompt, so the usage fields add up exactly.
import { createHash } from 'node:crypto'

const MINUTE = 60_000, HOUR = 60 * MINUTE

export const createCache = () => ({ enabled: true, offsetMs: 0, entries: new Map(), now() { return Date.now() + this.offsetMs } })

const sha = (...parts) => parts.reduce((h, p) => h.update(p), createHash('sha256')).digest('hex')
const arr = (v) => (Array.isArray(v) ? v : [])

// Who shares a cache: dialect, model and the credential, kept as a fingerprint only. Real providers
// isolate by organization / workspace; the credential header stands in for that.
function scopeOf(ctx, dialect, model, route = '') {
  const h = ctx.headers || {}
  const key = sha(String(h['x-api-key'] || h.authorization || '')).slice(0, 12)
  return { dialect, model, key, seed: sha(JSON.stringify([dialect, model, key, String(route ?? '')])) }
}

const live = (cache, h, now) => { const e = cache.entries.get(h); return e && e.expiresAt > now ? e : null }
const touch = (e, now) => { e.expiresAt = Math.max(e.expiresAt, now + e.ttlMs) } // a read refreshes the entry
function put(cache, h, entry, now) {
  const e = live(cache, h, now)
  if (e) { e.ttlMs = Math.max(e.ttlMs, entry.ttlMs); touch(e, now) } else cache.entries.set(h, { ...entry, expiresAt: now + entry.ttlMs })
}
function prune(cache, now) { for (const [h, e] of cache.entries) if (e.expiresAt <= now) cache.entries.delete(h) }

// ── Anthropic: explicit breakpoints ──
const blocksOf = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : arr(c))
const strip = (b) => { if (!b || typeof b !== 'object') return b; const { cache_control, ...rest } = b; return rest }
// Claude Code's billing-header block changes on every call, yet real hit rates stay ~100% (asight's
// src/dissect/cc.mjs marks it volatile): the provider leaves it out, and so does the mock.
const BILLING = /^x-anthropic-billing-header/
// Minimum cacheable prefix per model family (docs table); unknown and mock models get 1024.
const MIN_TOKENS = [[/opus-4-[56]|haiku-4-5/, 4096], [/opus-4-7|mythos-preview|3-5-haiku|3-haiku|haiku-3/, 2048], [/fable-5|mythos-5|opus-5|sonnet-5-5/, 512]]
const minTokens = (model) => MIN_TOKENS.find(([re]) => re.test(model))?.[1] ?? 1024

// The prompt in the order the provider builds it (tools, system, messages), one block at a time,
// cache_control dropped (a marker that moves must not change the prefix) and message blocks paired
// with their role. A run of tool_use or of tool_result blocks in one message is one lookback position.
function anthropicSegs(body) {
  const out = []
  for (const t of arr(body.tools)) out.push({ seg: strip(t), cc: t?.cache_control })
  for (const b of blocksOf(body.system)) if (!BILLING.test(b?.text || '')) out.push({ seg: strip(b), cc: b?.cache_control })
  arr(body.messages).forEach((m, i) => {
    for (const b of blocksOf(m?.content)) out.push({ seg: [m?.role, strip(b)], cc: b?.cache_control, run: /^tool_(use|result)$/.test(b?.type) ? `${i}/${b.type}` : null })
  })
  return out
}
function anthropicBlocks(body) {
  let h = '', bytes = 0, pos = 0, run = null
  return anthropicSegs(body).map((b, i) => {
    const s = JSON.stringify(b.seg) ?? ''
    h = sha(h, s); bytes += Buffer.byteLength(s)
    if (!b.run || b.run !== run) pos++
    run = b.run
    return { ...b, i, h, pos, tokens: Math.ceil(bytes / 4) }
  })
}

// The whole prompt in the same estimate a model call's usage adds up to (input + creation + read);
// count_tokens answers with it so the two never drift apart.
export const anthropicTokens = (body) => Math.max(1, anthropicBlocks(body).at(-1)?.tokens || 0)

// Usage per the docs: A = highest hit, B = last 1h breakpoint after A, C = last breakpoint; read A,
// write 1h (B - A) and 5m (C - B); input_tokens is what follows C. Each breakpoint looks back over
// 20 positions (itself first) for an entry an earlier request wrote; writes happen only at breakpoints.
export function anthropicUsage(ctx, body) {
  const cache = ctx.cache, model = String(body.model || 'mock-model'), sc = scopeOf(ctx, 'anthropic', model)
  if (/deepseek/i.test(model)) { // DeepSeek's Anthropic-compatible endpoint: cache_control ignored, automatic caching
    const c = prefixUsage(ctx, 'anthropic', body)
    return { input_tokens: c.total - c.cached, cache_creation_input_tokens: 0, cache_read_input_tokens: c.cached, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }
  }
  const blocks = anthropicBlocks(body).map((b) => ({ ...b, h: sha(sc.seed, b.h) }))
  const total = Math.max(1, blocks.at(-1)?.tokens || 0)
  let read = 0, long = 0, last = 0
  if (cache?.enabled) {
    const now = cache.now(), min = minTokens(model)
    prune(cache, now)
    const bps = blocks.filter((b) => b.cc && typeof b.cc === 'object' && b.tokens >= min).map((b) => ({ ...b, ttlMs: b.cc.ttl === '1h' ? HOUR : 5 * MINUTE }))
    for (const bp of bps) {
      for (let i = bp.i; i >= 0 && bp.pos - blocks[i].pos < 20; i--) {
        const e = live(cache, blocks[i].h, now)
        if (e) { touch(e, now); read = Math.max(read, blocks[i].tokens); break }
      }
    }
    long = Math.max(read, ...bps.filter((b) => b.ttlMs === HOUR).map((b) => b.tokens))
    last = Math.max(read, ...bps.map((b) => b.tokens))
    for (const bp of bps) put(cache, bp.h, { dialect: 'anthropic', model, key: sc.key, tokens: bp.tokens, ttlMs: bp.ttlMs }, now)
  }
  const c1 = long - read, c5 = last - long
  return { input_tokens: total - last, cache_creation_input_tokens: c1 + c5, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 } }
}

// ── OpenAI Responses / Chat Completions and DeepSeek: automatic prefix caching ──
// The prompt (tools, then Responses' instructions + input, Chat's messages, or for DeepSeek on the
// Anthropic route the same segments as above) is cut into units of
// 4 × unit bytes, and each unit's entry hashes the prefix up to its end; a hit is the run of leading
// units earlier requests wrote. OpenAI: 128-token units, nothing reported under 1024, prompt_cache_key
// as a hard partition, 5 min idle (24 h with prompt_cache_retention "24h"). DeepSeek: 64-token
// units from the first, 1 h idle.
export function prefixUsage(ctx, dialect, body) {
  const cache = ctx.cache, model = String(body.model || 'mock-model'), deepseek = /deepseek/i.test(model)
  const sc = scopeOf(ctx, dialect, model, deepseek ? '' : body.prompt_cache_key)
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : arr(body.input)
  const segs = dialect === 'anthropic' ? anthropicSegs(body).map((b) => b.seg)
    : [...arr(body.tools), ...(body.instructions == null ? [] : [body.instructions]), ...input, ...arr(body.messages)]
  const buf = Buffer.from(segs.map((x) => JSON.stringify(x) ?? '').join(''))
  const total = Math.max(1, Math.ceil(buf.length / 4))
  const [unit, min, ttlMs] = deepseek ? [64, 64, HOUR] : [128, 1024, body.prompt_cache_retention === '24h' ? 24 * HOUR : 5 * MINUTE]
  let hits = 0
  if (cache?.enabled && total >= min) {
    const now = cache.now(), size = unit * 4
    prune(cache, now)
    let h = sc.seed, missed = false
    for (let n = 1; n * size <= buf.length; n++) {
      h = sha(h, buf.subarray((n - 1) * size, n * size))
      if (!missed && live(cache, h, now)) hits = n; else missed = true
      put(cache, h, { dialect, model, key: sc.key, tokens: n * unit, ttlMs }, now) // refreshes a hit
    }
  }
  return { total, cached: hits * unit >= min ? hits * unit : 0 }
}

// ── admin ──
export function cacheState(cache) {
  const now = cache.now()
  prune(cache, now)
  const entries = [...cache.entries.values()].map(({ expiresAt, ...e }) => ({ ...e, expiresInMs: expiresAt - now }))
  return { enabled: cache.enabled, clockOffsetMs: cache.offsetMs, entries }
}

// POST /__mock/cache {enabled?, flush?, advanceMs?}; invalid fields are ignored, like /__mock/config.
export function cacheAdmin(cache, body) {
  if (typeof body.enabled === 'boolean') cache.enabled = body.enabled
  if (body.flush === true) cache.entries.clear()
  if (Number.isFinite(body.advanceMs) && body.advanceMs >= 0) cache.offsetMs += body.advanceMs
  return cacheState(cache)
}
