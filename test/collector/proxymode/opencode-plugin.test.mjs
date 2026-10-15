// CM13 (spec 4.11 P9 `opencode-plugin`): the OpenCode routing template, rendered and imported the way each loader takes it — the 1.x loader
// calls every named export, the v2 loader reads the default { id, server } and must find no `effect`. The work happens at import: the
// prior proxy recorded (or 'none'), both spellings at the door, and fetch carrying `proxy: <door>` only for https non-loopback URLs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpDir } from '../../helpers/tmp.mjs'
import { renderTemplate } from '../../../src/collector/core/proxymode/hooks/render.mjs'
import { templateUrl } from '../../../src/collector/harness/templates/index.mjs'
import opencode from '../../../src/collector/harness/opencode.mjs'

const DOOR = 'http://127.0.0.1:18103'
const PROXY_ENV = opencode.proxy.env
const PROXY_NAMES = ['HTTPS_PROXY', 'https_proxy']

async function load(env) {
  const file = path.join(tmpDir(), 'asight-route.js')
  fs.writeFileSync(file, renderTemplate(fs.readFileSync(templateUrl('opencode-plugin'), 'utf8'), { DOOR, PROXY_ENV, PROXY_NAMES }))
  const saved = { env: { ...process.env }, fetch: globalThis.fetch }
  for (const k of [...PROXY_ENV, 'ASIGHT_PRIOR_PROXY']) delete process.env[k]
  Object.assign(process.env, env)
  const before = { ...process.env }
  const seen = []
  globalThis.fetch = Object.assign(async (input, init) => { seen.push({ input, init }); return 'response' }, { preconnect: () => 'kept' })
  const mod = await import(pathToFileURL(file).href)
  const after = { ...process.env }
  const restore = () => { for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch }
  return { mod, before, after, seen, restore }
}

test('CM13 loaders: the 1.x named export and the v2 default without effect both accept the module', async () => {
  const p = await load({})
  try {
    const named = Object.entries(p.mod).filter(([k, v]) => k !== 'default' && typeof v === 'function')
    assert.ok(named.length >= 1, '1.x: a named plugin function')
    for (const [, fn] of named) assert.deepEqual(await fn({}), {}, '1.x: it returns no hooks')
    const def = p.mod.default
    assert.equal(typeof def.id, 'string')
    assert.equal(typeof def.server, 'function')
    assert.equal('effect' in def, false, 'v2: no effect (it broke the v2 transport)')
    assert.equal('effect' in p.mod, false)
  } finally { p.restore() }
})

test('CM13 import: prior recorded (or none), both spellings at the door, only the allowed names changed', async () => {
  const CASES = [
    [{}, 'none'],
    [{ HTTPS_PROXY: 'http://corp:3128' }, 'http://corp:3128'],
    [{ https_proxy: 'http://low:1', HTTP_PROXY: 'http://plain:2' }, 'http://low:1'],
    [{ HTTP_PROXY: 'http://plain:2' }, 'http://plain:2'],
    [{ HTTPS_PROXY: DOOR, ASIGHT_PRIOR_PROXY: 'http://outer:9' }, 'http://outer:9'], // OpenCode started by an OpenCode: the outer prior stays
    [{ HTTPS_PROXY: DOOR }, 'none'],
  ]
  for (const [env, prior] of CASES) {
    const p = await load(env), before = p.before
    try {
      assert.equal(p.after.ASIGHT_PRIOR_PROXY, prior, JSON.stringify(env))
      for (const k of PROXY_NAMES) assert.equal(p.after[k], DOOR)
      const changed = Object.keys({ ...before, ...p.after }).filter((k) => before[k] !== p.after[k] )
      assert.deepEqual(changed.filter((k) => ![...PROXY_NAMES, 'ASIGHT_PRIOR_PROXY'].includes(k)), [], 'nothing else in the environment changes')
    } finally { p.restore() }
  }
})

test('CM13 fetch: https non-loopback gets the door; http, loopback and a caller\'s own proxy are left alone; the same objects pass through', async () => {
  const p = await load({})
  try {
    const f = globalThis.fetch
    assert.equal(f.preconnect(), 'kept', "Bun's fetch properties are kept")
    const body = { stream: true }
    assert.equal(await f('https://api.anthropic.com/v1/messages', { method: 'POST', body }), 'response')
    assert.deepEqual(p.seen.at(-1).init, { method: 'POST', body, proxy: DOOR })
    assert.equal(p.seen.at(-1).init.body, body, 'the body object is passed through, not read')
    const req = { url: 'https://openrouter.ai/api' }
    await f(req)
    assert.equal(p.seen.at(-1).input, req)
    assert.equal(p.seen.at(-1).init.proxy, DOOR, 'a Request-like input')
    await f(new URL('https://api.x.ai/'))
    assert.equal(p.seen.at(-1).init.proxy, DOOR, 'a URL input')
    for (const u of ['http://127.0.0.1:4096/session', 'https://localhost:4096/x', 'https://[::1]/x', 'http://example.com/']) {
      await f(u, { a: 1 })
      assert.deepEqual(p.seen.at(-1).init, { a: 1 }, u)
    }
    await f('https://api.anthropic.com', { proxy: 'http://own:1' })
    assert.equal(p.seen.at(-1).init.proxy, 'http://own:1', "the caller's own proxy wins")
  } finally { p.restore() }
})
