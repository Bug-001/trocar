// session-cache.test.mjs — 1.2 #23's bound (0.2 §5 会话缓存, D71③): seeded random put / attach / release sequences over desks of
// changing size. After every step: the detached entries leave the cache within its bounds (or only attached ones remain), an
// attached desk is never disposed, an evicted desk is disposed exactly once, and the one that leaves is the least recently attached.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionCache } from '../../web/legacy/replay/session-cache.mjs'

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 } } // mulberry32

for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
  test(`1.2 #23 session cache (seed ${seed}): bounded, attached never dropped, evicted disposed once, least recently attached first`, () => {
    const r = rng(seed), MB = 2 ** 20, maxSessions = 2 + Math.floor(r() * 4), maxBytes = (40 + Math.floor(r() * 120)) * MB
    const cache = createSessionCache({ maxSessions, maxBytes })
    // the model: key → {inst, on, at} for every desk not disposed
    const live = new Map(), disposed = new Map()
    let clock = 0, made = 0
    const fake = (key) => {
      const d = { key, size: Math.floor(r() * 30 * MB), bytes: () => d.size, dispose: () => disposed.set(d, (disposed.get(d) || 0) + 1) }
      return d
    }
    // one cache call, then the four invariants over the model
    const call = (what, fn) => {
      const seen = new Set(disposed.keys())
      const ret = fn()
      const out = [...disposed.keys()].filter((d) => !seen.has(d))
      for (const d of out) {
        const m = live.get(d.key)
        assert.ok(m && m.inst === d && !m.on, `${what}: only a detached desk is evicted`)
        for (const [k, v] of live) if (!v.on && !out.includes(v.inst)) assert.ok(v.at > m.at, `${what}: ${d.key} left while ${k}, attached less recently, stayed`)
      }
      for (const d of out) live.delete(d.key)
      for (const n of disposed.values()) assert.equal(n, 1, 'an evicted desk is disposed exactly once')
      const total = [...live.values()].reduce((t, v) => t + v.inst.bytes(), 0)
      const within = live.size <= maxSessions && total <= maxBytes
      assert.ok(within || [...live.values()].every((v) => v.on), `${what}: ${live.size} desks / ${total} bytes over the bounds with a detached one kept`)
      return ret
    }
    const open = (key) => { // the screen shows `key`: its cached desk, or a new one
      const e = live.get(key)
      if (e) { e.on = true; e.at = ++clock; assert.equal(call(`take ${key}`, () => cache.take(key)), e.inst, 'a held desk comes back as the same instance'); return }
      assert.equal(cache.take(key), null, 'a key not held is not taken')
      const d = fake(key); made++
      live.set(key, { inst: d, on: true, at: ++clock })
      call(`put ${key}`, () => cache.put(key, d))
    }
    const release = (k) => { live.get(k).on = false; call(`release ${k}`, () => cache.release(k)) }
    for (let step = 0; step < 400; step++) {
      const key = 'k' + Math.floor(r() * 7), x = r(), e = live.get(key)
      const on = [...live].filter(([, v]) => v.on).map(([k]) => k)
      if (e && e.on && x < 0.9) live.get(on[Math.floor(r() * on.length)]).inst.size = Math.floor(r() * 30 * MB) // the shown desk read more
      else if (x < 0.6) { for (const k of on) release(k); open(key) } // the screen switches to `key`
      else if (x < 0.9) { if (e) release(key) } // `key` is detached already: a second release changes nothing
      else open(key) // a second desk attached at once
    }
    assert.ok(made > 7, 'the sequence evicted and reopened desks')
  })
}
