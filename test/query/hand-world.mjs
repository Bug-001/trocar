// test/query/hand-world.mjs — a query service whose worker is a stand-in the test feeds by hand, and a response that records what was written to it.
// What a parked request does is a matter of which frame came when: `frame()` is the worker saying that frame, and once `parked()` is through the
// service has taken it in. Exports only: node --test runs every .mjs.
import { EventEmitter } from 'node:events'
import { createQueryService } from '../../src/query/service.mjs'
import { within } from '../helpers/bounded.mjs'
import { rawHome } from './raw-home.mjs'

/** A response that records what was written to it. */
export const recorder = () => {
  const r = { status: null, chunks: [], ended: false, headersSent: false }
  return Object.assign(r, {
    writeHead: (s) => { r.status = s; r.headersSent = true },
    write: (b) => { r.chunks.push(b); return true },
    end: () => { r.ended = true },
    once: () => {},
    text: () => Buffer.concat(r.chunks).toString('utf8'),
  })
}

export const handWorld = (opts = {}) => {
  const got = [], said = []
  let forks = 0, child = null
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), failure: (where, e) => said.push(e.code), ...opts, fork: () => {
    forks++
    child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { pause() {}, resume() {} }), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write: (l) => got.push(JSON.parse(l).params.tag) }), kill() {} })
    return child
  } })
  const frame = (s) => child.stdout.emit('data', Buffer.from(s))
  const parked = () => { frame('102 0 - 0 -\n'); return new Promise(setImmediate) }
  const ask = (name, tag, res = recorder()) => svc.relay({ name, params: { tag }, res })
  /** Until `n` lines were written to the worker. */
  const sent = (n) => within((async () => { while (got.length < n) await new Promise((d) => setTimeout(d, 2)) })(), 10_000, `line ${n} to the worker`)
  return { svc, got, said, frame, parked, ask, sent, forks: () => forks }
}
