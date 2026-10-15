// test/helpers/model-world.mjs — a tmp-HOME world for the collector model's install / on / uninstall (plan T20): the stub custody, an in-memory
// user root store (an add can be declined or left pending), the sources ctx over the real tmp fs with an injected `which`, and runInstall bound to
// it. Nothing here touches a keychain, a trust store or the user's real HOME. Exports only.
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './tmp.mjs'
import { custodyStub } from './custody-stub.mjs'
import { rootIdOf } from '../../src/off/root-store.mjs'
import { runInstall } from '../../src/collector/model-install.mjs'
import { sourcesCtx } from '../../src/collector/arch/model-backends.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'

/** An in-memory root store: `answer` is what an add says ('ok' | 'declined' | 'pending'); `calls` records every verb. */
export function rootStoreStub({ answer = 'ok' } = {}) {
  const held = new Set(), calls = []
  return {
    held, calls, set answer(a) { answer = a },
    has: (id) => { calls.push('has'); return { present: held.has(id.fp256) } },
    add: (der) => { calls.push('add'); if (answer !== 'ok') return { ok: false, state: answer, reason: `the OS prompt was ${answer}` }; held.add(rootIdOf(der).fp256); return { ok: true } },
    remove: (id) => { calls.push('remove'); held.delete(id.fp256); return { ok: true } },
  }
}

/** world({ os, env (an object, or home → object), commands }) → { home, dir, env, custody, store, ctx, install(over) } — `commands` are the names `which` finds (under home/bin). */
export async function modelWorld({ os = 'darwin', env = {}, commands = [], cwd = null } = {}) {
  const home = tmpDir('asight-model-')
  const dir = path.join(home, '.asight', 'collector')
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const c of commands) fs.writeFileSync(path.join(bin, c), '#!/bin/sh\n', { mode: 0o755 })
  const custody = custodyStub()
  const store = rootStoreStub()
  const fullEnv = { HOME: home, PATH: bin, ...(typeof env === 'function' ? env(home) : env) }
  const ctx = sourcesCtx({ os, home, env: fullEnv, cwd: cwd || home, dirs: { appSupport: path.join(home, 'Library', 'Application Support'), localAppData: path.join(home, 'AppData', 'Local') } })
  ctx.exists = (p) => (p === home || p.startsWith(`${home}${path.sep}`)) && fs.existsSync(p) // hermetic: the dev machine's /Applications never makes a form present
  const harnesses = await loadHarnesses()
  const owns = (p) => { try { return fs.statSync(p).uid === process.getuid() } catch { return null } }
  const install = (over = {}) => runInstall({ os, home, env: fullEnv, harnesses, custody, rootStore: store, ctx, owns, renderHook, ...over })
  return { home, dir, env: fullEnv, custody, store, ctx, harnesses, owns, install }
}
