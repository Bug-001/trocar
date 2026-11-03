// test/server/daemon-board.e2e.test.mjs — 4.4 #12 (D66): the board comes up with the daemon. A REAL startDaemon (the model collector, its real
// control endpoint found through controlEndpointFor; test/helpers/model-daemon.mjs) on a tmp HOME whose ingress.json has the board's
// port; only the query worker's fork is the test one (no-real-os preloaded). Nothing is injected into either endpoint.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd, boardPortOf, unservable } from '../helpers/model-daemon.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }))
  })
  r.on('error', reject); r.end()
})
const keys = (v) => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [])

/** A world whose ingress.json has the board's port, as install leaves it (one the OS hands out: boardPortOf). */
async function boardWorld(platform) {
  const w = await modelWorld({ os: platform })
  return { w, port: await boardPortOf(w.dir) }
}
async function daemonOf(w, platform) {
  const box = await liveUnit({ w, platform, daemon: { fork: workerFork } })
  box.unit.start(); await box.starting
  const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
  return { box, ask: (p) => ep.request({ socketPath: ep.socketPath, method: 'GET', path: p }) }
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform} · 4.4 #12: the daemon serves the board on the recorded port — static plane without the token, /api with the board.token, /status names it (never the token), GET /board gives it`, { skip: await unservable(platform), timeout: 30_000 }, async () => {
    const { w, port } = await boardWorld(platform)
    await withScratchCwd(platform, async () => {
      const { box, ask } = await daemonOf(w, platform)
      try {
        const file = path.join(w.dir, 'board.token')
        const token = fs.readFileSync(file, 'utf8')
        assert.match(token, /^[A-Za-z0-9_-]{43}$/)
        assert.equal(fs.statSync(file).mode & 0o777, 0o600)
        assert.equal((await get(port, '/')).status, 200)
        const api = await get(port, '/api/sessions', { [CONTROL_TOKEN_HEADER]: token })
        assert.equal(api.status, 200, api.body)
        assert.equal(JSON.parse(api.body).command, 'sessions')
        assert.equal((await get(port, '/api/sessions')).status, 403)
        const st = await ask('/status')
        assert.deepEqual([st.board.state, st.board.port], ['serving', port])
        assert.equal(keys(st).includes('token'), false)
        assert.equal(JSON.stringify(st).includes(token), false)
        const b = await ask('/board')
        assert.deepEqual([b.state, b.port, b.token], ['serving', port, token])
        // V84: the board binds the loopback only
        const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')
        if (ext) {
          const err = await new Promise((resolve) => {
            const s = net.connect({ host: ext.address, port, timeout: 2000 })
            s.on('connect', () => { s.destroy(); resolve(null) }); s.on('timeout', () => { s.destroy(); resolve('ETIMEDOUT') }); s.on('error', (e) => resolve(e.code))
          })
          assert.ok(err, `the board accepted a connection on ${ext.address}`)
        }
      } finally { await box.stop() }
    })
  })

  test(`${platform} · 4.4 #12 · D38: a board port another socket holds → board port-taken with a reason, one failure record {where:'daemon'}, and /query still answers`, { skip: await unservable(platform), timeout: 30_000 }, async () => {
    const { w, port } = await boardWorld(platform)
    const squat = net.createServer(); squat.listen(port, '127.0.0.1'); await once(squat, 'listening')
    await withScratchCwd(platform, async () => {
      const { box, ask } = await daemonOf(w, platform)
      try {
        const st = await ask('/status')
        assert.deepEqual([st.board.state, st.board.port, typeof st.board.reason], ['port-taken', port, 'string'])
        const flows = path.join(w.dir, 'flows')
        const recs = fs.readdirSync(flows).flatMap((n) => fs.readFileSync(path.join(flows, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        const mine = recs.filter((r) => r.event === 'failure' && r.where === 'daemon')
        assert.equal(mine.length, 1, JSON.stringify(mine)); assert.equal(mine[0].code, 'EADDRINUSE')
        let q = null
        for (let i = 0; i < 50 && !q; i++) q = await ask('/query?name=segments').catch((e) => { if (e.status !== 503) throw e; return new Promise((r) => setTimeout(() => r(null), 100)) })
        assert.ok(q && typeof q === 'object', 'GET /query answered')
      } finally { await box.stop(); squat.close() }
    })
  })
}
