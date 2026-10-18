// test/query/daemon-seam.test.mjs — the CLI ↔ daemon seam of a read, on its DEFAULT path (RFC 1.6 §4.1 「谁答」, 3.5 验收 7 · 8; D63 ①②).
//
// the platform-seam rule / incident 2: a seam between processes is only tested when the test crosses it the way the product does. So this
// runs a REAL daemon (startDaemon, the model collector, the control server on the endpoint the platform's own controlEndpoint picks
// and writes into control.json) and a REAL `asight query` over it — no injected `request`, no injected `socketPath`, no injected fs.
//   1. byte-identical: the document the daemon's query worker computed and the one the CLI computes locally are the same bytes.
//   2. never stale: a record that lands in the segment the daemon is appending to is in the NEXT query of that session, and a query
//      of an unchanged session is still answered from the warm assembly (which is what the ≤ 50 ms line buys).
// The engine's own path from an agent's bytes to that segment is test/collector/model-capture-e2e.test.mjs's cell; here the record
// arrives in the live segment the daemon's lock names, which is what a query must notice.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit } from '../helpers/model-daemon.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { run as runQueryCli } from '../../src/cli/query.mjs'
import { queryDocument } from '../../src/query/client.mjs'
import net from 'node:net'

/** `asight query <argv>` as the command line runs it → { out, exit }: one document on stdout, nothing injected. */
async function cli(argv, { home, env, platform }) {
  const out = []
  const io = { out: (s) => out.push(s), err: (s) => out.push(s), stdout: { isTTY: false }, stderr: {}, stdin: { isTTY: false } }
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]; else flags[k] = true }
    else positionals.push(argv[i])
  }
  const exit = await runQueryCli(argv, { io, json: !!flags.json, args: { positionals, flags }, home, env, platform, deps: {} })
  return { out: out.join('\n'), exit }
}

/** The id of the session with the most records in a generated corpus, and the segment the daemon is writing. */
const biggestSession = (doc) => JSON.parse(doc).sessions.slice().sort((a, b) => b.calls - a.calls)[0].session_id

test('darwin: a read goes through the real daemon and gives the very bytes the local path gives; a new record of a session is in its next query', { timeout: 60_000 }, async () => {
  const w = await modelWorld({ os: 'darwin' })
  const asight = path.join(w.home, '.asight')
  generate({ home: asight, seed: 7, bytes: 3_000_000, segmentBytes: 1 << 20 })
  // the same corpus, but with no daemon to find: the copy is taken before this daemon starts, so its own sealing
  // cannot be mistaken for a difference between the two read paths
  const alone = tmpDir('asight-local-')
  fs.cpSync(asight, path.join(alone, '.asight'), { recursive: true })
  fs.rmSync(path.join(alone, '.asight', 'collector'), { recursive: true, force: true })
  const local = (argv) => cli(argv, { home: alone, env: { ...w.env, HOME: alone }, platform: 'darwin' })
  const box = await liveUnit({ w, platform: 'darwin' })
  box.unit.start()
  await within(box.starting, 20_000, 'the real daemon started')
  try {
    // the endpoint the daemon itself wrote: this is what the CLI resolves, through the one resolver
    const control = JSON.parse(fs.readFileSync(path.join(w.dir, 'control.json'), 'utf8'))
    assert.ok(control.path && control.token, 'the daemon named its control endpoint')

    const viaDaemon = await cli(['sessions', '--json'], { home: w.home, env: w.env, platform: 'darwin' })
    assert.equal(viaDaemon.exit, 0, viaDaemon.out)
    const id = biggestSession(viaDaemon.out)
    const ref = `${JSON.parse(viaDaemon.out).sessions.length ? fs.readdirSync(path.join(asight, 'raw')).sort()[0].replace(/\.(ndjson|sealed)$/, '') : ''}:1`

    // `segments` and `classes` are not here: both report the raw layer's live state (its sizes, what is sealed), and
    // this daemon seals its own copy — the two HOMEs may honestly disagree about those two documents, not about a record.
    for (const argv of [['sessions', '--json'], ['session', '--id', id, '--json'], ['session', '--id', id, '--after', '1', '--limit', '1', '--json'], ['calls', '--session', id, '--json'], ['block', '--ref', ref, '--json'], ['pricing', '--json']]) {
      const d = await cli(argv, { home: w.home, env: w.env, platform: 'darwin' })
      const l = await local(argv)
      assert.equal(d.exit, 0, d.out)
      assert.equal(d.out === l.out, true, `the daemon path and the local path print the same bytes for ${argv.join(' ')}:\n  daemon ${d.out.length} B\n  local  ${l.out.length} B`)
    }

    // never stale (D63 ①): more records of this session arrive after the first query — one in a NEW segment (the
    // rollover shape) and one appended to that segment (the live shape). Each must be in the very next query. The
    // records are copies of one this session already has, so they carry its own shape and its own session key.
    const rawDir = path.join(asight, 'raw')
    const one = fs.readdirSync(rawDir).filter((n) => n.endsWith('.ndjson'))
      .flatMap((n) => fs.readFileSync(path.join(rawDir, n), 'utf8').split('\n')).find((l) => l.includes(id))
      || fs.readFileSync(path.join(alone, '.asight', 'raw', fs.readdirSync(path.join(alone, '.asight', 'raw'))[0]), 'utf8').split('\n').find((l) => l.includes(id))
    assert.ok(one, 'a record of this session is on disk')
    const line = (ts) => JSON.stringify({ ...JSON.parse(one), ts, ts_request: ts }) + '\n'
    const fresh = path.join(rawDir, '20261019T100000Z.ndjson')
    assert.equal(fs.existsSync(fresh), false, 'the new segment is new')
    const count = async () => JSON.parse((await cli(['session', '--id', id, '--json'], { home: w.home, env: w.env, platform: 'darwin' })).out).records.length
    const before = await count()
    fs.writeFileSync(fresh, line('2026-10-19T10:00:00.000Z'), { mode: 0o600 })
    assert.equal(await count(), before + 1, 'a record in a segment that did not exist at the last query is in this one')
    fs.appendFileSync(fresh, line('2026-10-19T10:00:01.000Z'))
    assert.equal(await count(), before + 2, 'a record appended to the segment that grew is in the next query too')

    // and a session nothing happened to is still answered, correctly, from the warm worker
    const other = JSON.parse(viaDaemon.out).sessions.find((s) => s.session_id !== id)
    if (other) {
      const again = await cli(['session', '--id', other.session_id, '--json'], { home: w.home, env: w.env, platform: 'darwin' })
      assert.equal(JSON.parse(again.out).meta.calls, other.calls, 'an untouched session keeps its own answer while another one grows')
    }
  } finally {
    await box.stop()
  }
})

/** A raw request on the daemon's control socket that is DESTROYED as soon as the document starts arriving: a caller
 *  that went away mid-document (Ctrl-C, a closed board tab). Resolves when the socket is gone. */
function hangUp({ socketPath, token, path: p }) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath, () => s.write(`GET ${p} HTTP/1.1\r\nHost: collector\r\nx-asight-token: ${token}\r\nConnection: close\r\n\r\n`))
    s.once('data', () => { s.destroy(); resolve() })
    s.once('error', reject)
    setTimeout(() => { s.destroy(); resolve() }, 5000).unref()
  })
}

test('darwin: the cold read is local, the worker is warmed behind it, and a caller that hangs up mid-document leaves the worker usable', { timeout: 60_000 }, async () => {
  const w = await modelWorld({ os: 'darwin' })
  const asight = path.join(w.home, '.asight')
  generate({ home: asight, seed: 11, bytes: 3_000_000, segmentBytes: 1 << 20 })
  const box = await liveUnit({ w, platform: 'darwin' })
  box.unit.start()
  await within(box.starting, 20_000, 'the real daemon started')
  const ctx = { home: asight, userHome: w.home, dir: w.dir, platform: 'darwin', env: w.env }
  /** The one read client, over the real socket it resolves itself: `via` says WHO answered. */
  const ask = (name, params = {}) => queryDocument(name, params, ctx)
  const warm = async (name, params) => { for (let i = 0; i < 40; i++) { const r = await ask(name, params); if (r.via === 'daemon') return r; await new Promise((d) => setTimeout(d, 50)) } throw new Error('the worker never answered') }
  try {
    // 1. COLD (D63, the cold path): no worker runs yet, so the daemon says so at once and this process answers —
    //    a cold read is never slower than a local one. The warm worker then answers the very same bytes.
    const cold = await ask('sessions')
    assert.equal(cold.via, 'local', 'with no worker running the read is answered locally, not after a fork')
    const hot = await warm('sessions')
    assert.equal(hot.text, cold.text, 'and the worker the cold read warmed answers the same document, byte for byte')

    // 2. A CALLER THAT GOES: a big document is cut off mid-flight. The worker must stay usable — before this fix
    //    its stdout stayed paused, the 30 s deadline then wrote a false failure and killed it with its cache, and
    //    every read went local for 30 s.
    const id = biggestSession((await ask('sessions')).text)
    await warm('session', { id })
    const control = JSON.parse(fs.readFileSync(path.join(w.dir, 'control.json'), 'utf8'))
    await hangUp({ socketPath: control.path, token: control.token, path: `/query?name=session&id=${encodeURIComponent(id)}&indent=2` })
    const after = await ask('session', { id })
    assert.equal(after.via, 'daemon', 'the next query is still answered by the worker, not by the fallback')
    assert.equal(JSON.parse(after.text).ok, true)
  } finally {
    await box.stop()
  }
})
