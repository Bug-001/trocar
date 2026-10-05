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
function scopeOf(ctx, dialect, model) {
  const h = ctx.headers || {}
  const key = sha(String(h['x-api-key'] || h.authorization || '')).slice(0, 12)
  return { dialect, model, key, seed: sha(JSON.stringify([dialect, model, key])) }
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
function anthropicBlocks(body) {
  const out = []
  for (const t of arr(body.tools)) out.push({ seg: strip(t), cc: t?.cache_control })
  for (const b of blocksOf(body.system)) if (!BILLING.test(b?.text || '')) out.push({ seg: strip(b), cc: b?.cache_control })
  arr(body.messages).forEach((m, i) => {
    for (const b of blocksOf(m?.content)) out.push({ seg: [m?.role, strip(b)], cc: b?.cache_control, run: /^tool_(use|result)$/.test(b?.type) ? `${i}/${b.type}` : null })
  })
  let h = '', bytes = 0, pos = 0, run = null
  return out.map((b, i) => {
    const s = JSON.stringify(b.seg) ?? ''
    h = sha(h, s); bytes += Buffer.byteLength(s)
    if (!b.run || b.run !== run) pos++
    run = b.run
    return { ...b, i, h, pos, tokens: Math.ceil(bytes / 4) }
  })
}

// Usage per the docs: A = highest hit, B = last 1h breakpoint after A, C = last breakpoint; read A,
// write 1h (B - A) and 5m (C - B); input_tokens is what follows C. Each breakpoint looks back over
// 20 positions (itself first) for an entry an earlier request wrote; writes happen only at breakpoints.
export function anthropicUsage(ctx, body) {
  const cache = ctx.cache, model = String(body.model || 'mock-model'), sc = scopeOf(ctx, 'anthropic', model)
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
