// test/query/fallback.test.mjs — what the ONE read client takes as the query core's verdict, and what it answers
// locally (RFC 1.6 §4.1 「谁答」, D63 ②; the platform-seam rule: the real endpoint resolver over a real socket).
//
// The contract: only 400 is the query core's own verdict on these arguments — the client must raise the same
// QueryArgError instead of computing it again. EVERY other answer from the control plane (a wrong token = 401 from
// src/collector/core/control.mjs, an older daemon with no such route = 404, no warm worker = 503) is a fact about
// the CHANNEL, so the document is computed here and is the document the caller asked for. A 401 taken as a verdict
// made `trocar query` exit 2 with a usage message that named a parameter the user had typed correctly.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { queryDocument } from '../../src/query/client.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { rawHome } from './raw-home.mjs'

/** A control plane on a real socket, reached the way the CLI reaches it: `dir`'s control.json, the one resolver.
 *  `token` is what the server demands; `write` is what control.json says — a different one is how a wrong token happens. */
async function plane({ routes = {}, token = 'a'.repeat(32), write = token }) {
  const dir = tmpDir('trocar-fb-')
  const sock = path.join(path.join(dir, 's.sock'))
  const server = await startControlServer({ socketPath: sock, token, routes, pipe: true })
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ path: sock, token: write }))
  return { dir, stop: () => server.close() }
}

const refuse = (status, error) => async () => { throw Object.assign(new Error(error), { status }) }

test('only 400 is the query core\'s verdict: a wrong token (401) and a missing route (404) are answered locally, with the document', async () => {
  const home = rawHome('trocar-fb-')
  const want = JSON.stringify(await runQuery('segments', {}, { home }))
  for (const p of [
    await plane({ write: 'b'.repeat(32) }), //                     401: the token of control.json is not the server's
    await plane({ routes: {} }), //                                404: this daemon has no read route
    await plane({ routes: { 'GET /query': refuse(503, 'no warm query worker') } }), // 503: the cold path (D63)
    await plane({ routes: { 'GET /query': refuse(500, 'the query worker exited') } }), // 500: its worker went
  ]) {
    try {
      const got = await queryDocument('segments', {}, { home, dir: p.dir, platform: 'darwin' })
      assert.equal(got.via, 'local', 'the channel said nothing about the arguments, so this process answers')
      assert.equal(got.text, want, 'and it answers with the document, not with an error')
    } finally { await p.stop() }
  }
})

test('400 IS the verdict: the core\'s own usage error is raised here, not computed again', async () => {
  const home = rawHome('trocar-fb-')
  const p = await plane({ routes: { 'GET /query': refuse(400, 'trocar query sessions: no parameter --nope (its parameters: --harness)') } })
  try {
    await assert.rejects(() => queryDocument('sessions', { nope: '1' }, { home, dir: p.dir, platform: 'darwin' }), (e) => {
      assert.equal(e.name, 'QueryArgError')
      assert.match(e.message, /no parameter --nope/)
      return true
    })
  } finally { await p.stop() }
})
