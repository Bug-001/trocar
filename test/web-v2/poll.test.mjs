// test/web-v2/poll.test.mjs — the board's one poll engine (core/poll.mjs; 1.5 K-29, 4.4 §live-poll): createPoller's policy over a
// fake clock, and startPoll's timer and visibility over node's mock timers for every period of 4.4's table.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createPoller, startPoll, backoffMs, BACKOFF_MAX_MS, INTERVAL } from '../../web/legacy/core/poll.mjs'

// ── the poll loop (1.5 K-29): a fake clock and a fake reader ────────────────────────────────────────────────────────────
function rig(answers) {
  let t = 0, reads = 0
  const p = createPoller({ base: 1500, now: () => t, run: async () => { reads++; return answers.length ? answers.shift() : {} } })
  return { p, at: (ms) => { t = ms }, reads: () => reads }
}

test('poller: after a failure no read happens before the back-off is due; it doubles to 30 s; a success resets it', async () => {
  let ms = 0
  for (let n = 1; n <= 8; n++) { const w = backoffMs(n, 1500); assert.ok(w > ms || w === BACKOFF_MAX_MS); assert.ok(w <= BACKOFF_MAX_MS); ms = w }
  assert.equal(backoffMs(20, 1500), BACKOFF_MAX_MS)
  const r = rig([{ ok: false }, { ok: false }, {}, {}])
  await r.p.poll(); assert.equal(r.reads(), 1)
  r.at(backoffMs(1, 1500) - 1); await r.p.poll(); assert.equal(r.reads(), 1, 'a tick before the back-off is due reads nothing')
  r.at(backoffMs(1, 1500)); await r.p.poll(); assert.equal(r.reads(), 2, 'due: it reads (and fails again)')
  const t2 = backoffMs(1, 1500) + backoffMs(2, 1500)
  r.at(t2 - 1); await r.p.poll(); assert.equal(r.reads(), 2, 'the second wait is longer')
  r.at(t2); await r.p.poll(); assert.equal(r.reads(), 3, 'a success')
  r.at(t2 + 1499); await r.p.poll(); assert.equal(r.reads(), 3, 'the success that ends the back-off: no tick before one interval')
  r.at(t2 + 1500); await r.p.poll(); assert.equal(r.reads(), 4, 'one interval after it, the tick reads')
})

test('poller: a reader\'s own action bypasses the back-off', async () => {
  const r = rig([{ ok: false }, { ok: false }])
  await r.p.poll(); await r.p.poll(); assert.equal(r.reads(), 1)
  await r.p.poll(true); assert.equal(r.reads(), 2, 'Retry / a jump / f read at once')
  await r.p.poll(); assert.equal(r.reads(), 2)
})

test('poller: one read in flight; a tick during it is dropped, a reader\'s call during it reads once more after it', async () => {
  for (const [first, reader, want] of [[{}, false, 1], [{ ok: false }, false, 1], [{}, true, 2], [{ ok: false }, true, 2]]) {
    let release, reads = 0
    const answers = [first, {}, {}]
    const p = createPoller({ base: 1500, now: () => 0, run: () => { reads++; const a = answers.shift(); return reads === 1 ? new Promise((res) => { release = () => res(a) }) : Promise.resolve(a) } })
    const done = p.poll()
    await p.poll(reader); await p.poll(reader) // calls while the first read is in flight: no second concurrent read
    assert.equal(reads, 1)
    release(); await done
    assert.equal(reads, want, `${JSON.stringify(first)} reader ${reader}`)
  }
})

test('poller: while idle() holds (hidden tab, a session not listed) a timer tick reads nothing; a reader poll still reads', async () => {
  let idle = true, reads = 0
  const p = createPoller({ base: 1500, now: () => 0, idle: () => idle, run: async () => { reads++; return {} } })
  await p.poll(); await p.poll(); assert.equal(reads, 0, 'idle: the timer reads nothing')
  await p.poll(true); assert.equal(reads, 1, 'a reader poll reads')
  idle = false; await p.poll(); assert.equal(reads, 1, 'no longer idle: not before one interval after the last read')
})

test('poller: after a slow success a timer tick waits 3x that read; a quick read keeps the plain interval', async () => {
  const base = 1500
  for (const D of [10 * base, 5 * base]) {
    let t = 0, reads = 0
    const p = createPoller({ base, now: () => t, run: async () => { reads++; t += D; return {} } })
    await p.poll(); assert.equal(reads, 1)
    t = 3 * D - 1; await p.poll(); assert.equal(reads, 1, `D=${D}: a tick before 3D reads nothing`)
    t = 3 * D; await p.poll(); assert.equal(reads, 2, `D=${D}: at 3D it reads`)
    await p.poll(true); assert.equal(reads, 3, 'a reader poll never waits')
  }
  let t = 0, reads = 0
  const D = Math.floor(base / 3) - 1
  const p = createPoller({ base, now: () => t, run: async () => { reads++; t += D; return {} } })
  await p.poll(); t = base - 1; await p.poll(); assert.equal(reads, 1, 'a quick read: no tick before one interval')
  t = base; await p.poll(); assert.equal(reads, 2, 'a quick read: the tick one interval after its start reads')
})

test('poller: a tick during a slow read does not chain a read before the 3x gap', async () => {
  let t = 0, reads = 0, release
  const p = createPoller({ base: 1500, now: () => t, run: () => { reads++; return new Promise((res) => { release = () => { t += 15000; res({}) } }) } })
  const done = p.poll(); await p.poll(); release(); await done
  assert.equal(reads, 1)
})

// ── 4.4 live-poll: the 3x wait follows only a success without `pending` that did not end a back-off ──────────────
// a poller over scripted answers, each read taking `took` ms of the fake clock
function timed(script, base = 1500) {
  let t = 0, reads = 0
  const p = createPoller({ base, now: () => t, run: async () => { const [a, took] = script[reads++] || [{}, 0]; t += took; return a } })
  return { p, reads: () => reads, at: (ms) => { t = ms }, now: () => t }
}

test('4.4 live-poll: after a pending answer the next timer tick reads at the interval, however long the read took', async () => {
  const base = 1500
  for (const took of [base / 3 + 1, base, 10 * base]) {
    const r = timed([[{ pending: { done: 1, total: 9 } }, took]], base)
    await r.p.poll(); assert.equal(r.reads(), 1)
    r.at(took + base); await r.p.poll(); assert.equal(r.reads(), 2, `took ${took}: the tick one interval later reads`)
  }
})

test('4.4 live-poll: after k failures and then a slow success the next timer tick reads at the interval', async () => {
  const base = 1500
  for (const k of [1, 2, 5]) {
    const r = timed([...Array.from({ length: k }, () => [{ ok: false }, 10]), [{}, 22000]], base)
    for (let i = 0; i < k; i++) await r.p.poll(true)
    await r.p.poll(true); assert.equal(r.reads(), k + 1, 'the success')
    r.at(r.now() + base); await r.p.poll(); assert.equal(r.reads(), k + 2, `k=${k}: the back-off ended at once`)
  }
})

test('4.4 live-poll: after a slow success without pending no timer read comes before 3x its duration', async () => {
  const base = 1500
  for (const D of [base / 3 + 1, base, 7 * base]) {
    const r = timed([[{}, D]], base)
    await r.p.poll()
    for (let t = D; t < 3 * D; t += base / 2) { r.at(t); await r.p.poll() }
    assert.equal(r.reads(), 1, `D=${D}`)
    r.at(3 * D); await r.p.poll(); assert.equal(r.reads(), 2)
  }
})

// 4.4 live-poll 「每 1.5 s 一轮 … head 带 pending 时下一轮仍在 1.5 s 后」: the started poller's one schedule. The first round is the
// reader's (the desk's attach) and answers `pending` after a long wait, whatever phase it ends at; no two rounds that were not a reader's
// start less than `base` apart, and none waits more than `base` past its due time.
test('poller start(): after a long pending round no two timer rounds come less than base apart', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset())
  const base = INTERVAL.session
  for (const took of [7188, 7500, base - 1, 3 * base + 24]) {
    const starts = []
    const p = createPoller({ base, run: () => { starts.push(Date.now()); return new Promise((res) => setTimeout(() => res(starts.length === 1 ? { pending: { done: 1, total: 9 } } : {}), starts.length === 1 ? took : 25)) } })
    p.start(); p.poll(true)
    for (let ms = 0; ms < took + 6 * base; ms += 5) { mock.timers.tick(5); await new Promise((r) => setImmediate(r)) }
    p.stop()
    assert.ok(starts.length >= 6, `took ${took}: ${starts.length} rounds`)
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1], due = i === 1 ? base : Math.max(base, 75)
      assert.ok(gap >= due && gap <= Math.max(due, i === 1 ? took : 0) + 10, `took ${took}: round ${i + 1} ${gap} ms after round ${i}`)
    }
  }
})

// ── startPoll over every period of 4.4's table (mock timers; a fake document and reader) ─────────────────────────────────
import fs from 'node:fs'

test('INTERVAL is 4.4 §live-poll\'s table', () => {
  const all = fs.readFileSync(new URL('../../spec/01-trocar-rfc/4.4-server.md', import.meta.url), 'utf8').split('\n')
  const rows = all.slice(all.findIndex((l) => l.includes('**live-poll**')))
  const period = (name) => Number(/(\d+(?:\.\d+)?) s/.exec(rows.find((l) => l.includes(`| \`${name}\``)))[1]) * 1000
  assert.deepEqual(INTERVAL, { status: period('status'), sessions: period('sessions'), session: period('session'), other: period('classes') })
})

function world(answer) {
  const listeners = new Map(), reads = []
  const doc = { hidden: false, addEventListener: (t, f) => listeners.set(t, f), removeEventListener: (t, f) => { if (listeners.get(t) === f) listeners.delete(t) } }
  const run = async () => { reads.push(Date.now()); return answer(reads.length) }
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  return { doc, run, reads, listeners, settle, vis: () => listeners.get('visibilitychange')() }
}

for (const base of new Set(Object.values(INTERVAL))) {
  test(`startPoll base ${base}: after k failures no timer read before backoffMs(k); a success brings back the base`, async (t) => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset())
    for (let k = 1; k <= 5; k++) {
      const w = world((n) => (n <= k ? { ok: false } : {}))
      const p = startPoll({ run: w.run, base, doc: w.doc })
      await w.settle()
      while (w.reads.length < k + 2) { mock.timers.tick(base); await w.settle() }
      for (let i = 1; i <= k; i++) {
        const gap = w.reads[i] - w.reads[i - 1]
        assert.ok(gap >= backoffMs(i, base), `k=${k}: read ${i} came ${gap} ms after failure ${i}, the back-off is ${backoffMs(i, base)}`)
      }
      assert.equal(w.reads[k + 1] - w.reads[k], base, `k=${k}: one success brings back the plain period`)
      p.stop()
    }
  })

  test(`startPoll base ${base}: hidden reads nothing; visible again reads once at once; stop() reads nothing and drops the listener`, async (t) => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset())
    const w = world(() => ({}))
    const p = startPoll({ run: w.run, base, doc: w.doc })
    await w.settle(); assert.equal(w.reads.length, 1, 'one read at once on start')
    w.doc.hidden = true
    for (let i = 0; i < 10; i++) { mock.timers.tick(base); await w.settle() }
    assert.equal(w.reads.length, 1, 'hidden: zero reads over 10 periods')
    w.doc.hidden = false; w.vis(); await w.settle()
    assert.equal(w.reads.length, 2, 'visible again: exactly one read at once')
    p.stop(); assert.equal(w.listeners.size, 0, 'stop() removes the listener')
    for (let i = 0; i < 10; i++) { mock.timers.tick(base); await w.settle() }
    assert.equal(w.reads.length, 2, 'after stop(): zero reads')
  })

  test(`startPoll base ${base}: after a reader's or a visible-again read at t no timer read comes before t + base`, async (t) => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset())
    for (const by of ['reader', 'visible'])
      for (const at of [1, Math.floor(base / 2), base - 100, base - 1]) {
        const w = world(() => ({}))
        const p = startPoll({ run: w.run, base, doc: w.doc })
        await w.settle()
        mock.timers.tick(at)
        if (by === 'reader') p.poll(); else w.vis()
        await w.settle()
        const t0 = Date.now(), n = w.reads.length
        assert.equal(w.reads.at(-1), t0, `${by} at ${at}: the read happens at once`)
        for (let i = 0; i < 3 * base; i += 50) { mock.timers.tick(50); await w.settle() }
        const next = w.reads.slice(n)
        assert.ok(next.length > 0 && next[0] >= t0 + base, `${by} at ${at}: next timer read at ${next[0] - t0} ms, the period is ${base}`)
        p.stop()
      }
  })
}

// 1.8 §数据与刷新 · 4.4 live-poll `sessions`: an answer that is the stored one (`pending`) brings the next timer read in at `soon`;
// any other answer leaves the timer at `base`
test('startPoll soon: after a pending answer the next timer read comes at soon; after a plain one, at base', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset())
  const base = INTERVAL.sessions, soon = INTERVAL.session
  for (const answers of [[{ pending: true }, {}, {}], [{}, { pending: true }, {}]]) {
    const w = world((n) => answers[n - 1] || {})
    const p = startPoll({ run: w.run, base, soon, doc: w.doc })
    await w.settle()
    while (w.reads.length < answers.length) { mock.timers.tick(50); await w.settle() }
    for (let i = 1; i < answers.length; i++)
      assert.equal(w.reads[i] - w.reads[i - 1], answers[i - 1].pending ? soon : base, `read ${i + 1} after ${JSON.stringify(answers[i - 1])}`)
    p.stop()
  }
})
