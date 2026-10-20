// test/helpers/board-world.mjs — the OS fakes `trocar on` / `off` need when the board's query worker runs them (POST /control/harness, 4.4 §控制面),
// built as test/helpers/model-world.mjs and test/collector/model-daemon-e2e.test.mjs give them to the CLI: the login entry install registered (its
// start a no-op: the test's daemon is already up), no OS tool, an empty process table. The worker imports a module whose default export is these
// deps (src/query/worker.mjs argv[3]); depsFile writes that module for one world. Exports only.
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './tmp.mjs'
import crypto from 'node:crypto'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { rootCertDer, intermediateCertDer } from '../../src/collector/core/tls/cert.mjs'
import { rootIdOf } from '../../src/off/root-store.mjs'

/** The login entry install registered (1.6 §3.3), its start a no-op: the test's daemon is already up. */
export const standInUnit = (home) => ({
  // its text depends on the process and the env that build it (the real one names the script and carries NODE_EXTRA_CA_CERTS), and enable leaves a
  // line in HOME: a run that rewrites or registers the login entry from another process changes bytes a snapshot of HOME sees
  path: path.join(home, 'trocar-unit'), text: (env = {}) => `# stands for the LaunchAgent / scheduled task: pid ${process.pid} ${env.NODE_EXTRA_CA_CERTS || ''}`, links: [],
  enable: () => { fs.appendFileSync(path.join(home, 'trocar-unit.enabled'), `${process.pid}\n`); return { code: 0 } }, start: () => ({ code: 0 }), startNow: () => ({ code: 0 }), reload: () => {},
  registered: () => ({ state: 'present' }),
})

/**
 * The key custody and the user root store as files under `state` (outside HOME), so the test, its daemon and the board's worker process share one
 * key and one store (Set up runs install's function in the worker, 4.4 §控制面). store.json `answer` is what an add says ('ok' | 'pending');
 * `delayMs` holds the add that long (a slow prompt); calls.log gets one line per verb. → { custody, rootStore, calls() }
 */
export function sharedTrust(state) {
  fs.mkdirSync(state, { recursive: true })
  const at = (n) => path.join(state, n)
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(at(n), 'utf8')) } catch { return d } }
  const write = (n, v) => fs.writeFileSync(at(n), JSON.stringify(v))
  const call = (verb) => fs.appendFileSync(at('calls.log'), `${verb}\n`)
  const key = () => { const k = read('custody.json', null); return k && { priv: crypto.createPrivateKey(k.priv), rootDer: Buffer.from(k.root, 'base64') } }
  const DAY = 86400e3
  const custody = {
    kind: 'stub',
    exists: () => { call('exists'); return !!key() },
    create: ({ subject }) => {
      call('create')
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const rootDer = rootCertDer({ subject, spkiDer: publicKey.export({ type: 'spki', format: 'der' }), serial: crypto.randomBytes(16).fill(1, 0, 1), notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + 3650 * DAY), sign: (tbs) => crypto.sign('sha256', tbs, privateKey) })
      write('custody.json', { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }), root: rootDer.toString('base64') })
      return { rootDer, fp256: rootIdOf(rootDer).fp256 }
    },
    remove: () => { call('remove'); const had = !!key(); fs.rmSync(at('custody.json'), { force: true }); return { removed: had } },
    issueIntermediate: ({ spkiDer, serial, notBefore }) => { const k = key(); return intermediateCertDer({ root: k.rootDer, subject: `trocar intermediate ${notBefore.toISOString()}`, spkiDer, serial, notBefore, sign: (tbs) => crypto.sign('sha256', tbs, k.priv) }) },
  }
  const store = () => read('store.json', { held: [], answer: 'ok' })
  const rootStore = {
    has: (id) => { call('has'); return { present: store().held.includes(id.fp256) } },
    add: async (der) => {
      call('add'); const s = store()
      if (s.delayMs) await new Promise((res) => setTimeout(res, s.delayMs)) // an OS prompt somebody is slow to answer
      if (s.answer !== 'ok') return { ok: false, state: s.answer, reason: `the OS prompt was ${s.answer}` }
      write('store.json', { ...s, held: [...s.held, rootIdOf(der).fp256] }); return { ok: true }
    },
    remove: (id) => { call('remove'); const s = store(); write('store.json', { ...s, held: s.held.filter((f) => f !== id.fp256) }); return { ok: true } },
  }
  return { custody, rootStore, calls: () => { try { return fs.readFileSync(at('calls.log'), 'utf8').split('\n').filter(Boolean) } catch { return [] } }, setStore: (v) => write('store.json', v) }
}

/** → the deps of `on` / `off` / `status` / Set up for a world `{ platform, home, env, dirs, trust? }` (trust: sharedTrust's state directory). */
export async function boardDeps({ platform, home, env, dirs, trust = null }) {
  const harnesses = await loadHarnesses()
  const unit = standInUnit(home)
  return {
    platform, env, harnesses, unit, backends: { dirs, ...(trust ? (({ custody, rootStore }) => ({ custody, rootStore }))(sharedTrust(trust)) : {}) }, parts: { os: platform, harnesses, arch: { unit: { userUnit: () => unit } } },
    getuid: () => 501, exec: () => ({ status: 0, stdout: '', stderr: '' }), sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))),
    procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }),
    lingerRead: async () => ({ state: null }), netFactsDeps: async () => ({ harnesses, archFacts: null }),
  }
}

/** → the path of a deps module for the worker, for a modelWorld `w` on `platform` (`trust`: sharedTrust's state directory, for Set up). */
export function depsFile(w, platform, trust = null) {
  const file = path.join(tmpDir('trocar-board-deps-'), 'deps.mjs')
  const world = { platform, home: w.home, env: w.env, dirs: w.ctx.dirs, trust }
  fs.writeFileSync(file, `import { boardDeps } from ${JSON.stringify(import.meta.url)}\nexport default await boardDeps(${JSON.stringify(world)})\n`)
  return file
}
