// test/netenv/fixtures/model-rows.mjs — the proxy-mode rows of RFC 1.6 §9.3 (8–10, 12, 14, 25–28, 31) as NetFacts generated from the collector model's
// facts (core/proxymode/status-facts.mjs), for every descriptor's proxyMode.forms × the model's OSes (darwin, win32); they replace the retired rows the old
// win32 collector's forms half gave (W29). The entry is a real journal record (applyJsonKey in a tmpDir() HOME, the prior value in the file first); the daemon's
// reply, the system proxy and the sources ctx are injected. Nothing is hand-drawn here: the expected kinds and verdicts are the test's literals.
import fs from 'node:fs'
import path from 'node:path'
import { modelFormFacts, netFormsOf } from '../../../src/collector/core/proxymode/status-facts.mjs'
import { applyJsonKey, newManifest } from '../../../src/collector/core/trust/journal.mjs'
import { gatherNetFacts } from '../../../src/netenv/facts.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

export const MODEL = (await loadHarnesses()).filter((d) => d.proxyMode)
export const OSES = ['darwin', 'win32']
export const PRIOR = 'http://alice:pw@proxy.corp:8080'
export const SYS = { url: 'http://127.0.0.1:7897', bypass: [] }
export const ROOT_OK = { state: 'in-place', code: null, command: null }
const globs = []
JSON.stringify(MODEL.map((d) => d.proxyMode.forms), (k, v) => { if (k === 'glob' && typeof v === 'string') globs.push(v.replace(/\*/g, 'x')); return v })

/** A sources ctx where every form is (present) or none is (absent): which, exists and readdir answer for the descriptors' own places. */
export const ctxOf = (os, home, present = true) => ({ os, home, cwd: home, env: {}, dirs: { appSupport: path.join(home, 'as'), localAppData: path.join(home, 'la') },
  readFile: (p) => fs.readFileSync(p, 'utf8'), exists: () => present, readdir: () => (present ? globs : []), which: (c) => (present ? `/bin/${c}` : null), policy: () => ({ set: false }) })

/** A manifest with h installed and (unless `on` is false) one phase:on record per route, the door written over `prior` when given, as entries.mjs leaves it. */
export function world(desc, { prior = null, ports = 17990, on = true } = {}) {
  const home = tmpDir('model-rows'), dir = path.join(home, '.trocar', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  const m = newManifest()
  m.install = { state: 'complete', at: '2026-10-15T09:00:00.000Z', pending: [], harnesses: [desc.name], items: {} }
  m.entries.push({ kind: 'json-key', harness: desc.name, phase: 'install', path: path.join(home, 'carrier.json'), keys: ['ca'], installed_at: '2026-10-15T09:00:01.000Z' }, { kind: 'system-root', harness: null, phase: 'install', installed_at: '2026-10-15T09:00:00.000Z' })
  const doors = {}
  Object.keys(desc.proxyMode.routes).forEach((rid, i) => {
    const file = path.join(home, `${rid}.json`), door = `http://${desc.name}%3A${rid}:${'ab'.repeat(16)}@127.0.0.1:${ports + i}`
    fs.writeFileSync(file, JSON.stringify(prior ? { proxy: prior } : {}))
    if (on) Object.assign(applyJsonKey({ dir, manifest: m, harness: desc.name, phase: 'on', file, keys: ['proxy'], value: door, home, fs }), { route: rid, door })
    doors[`${desc.name}:${rid}`] = ports + i
  })
  return { home, m, doors }
}

/**
 * NetFacts for one harness on `os`, its per-form half from the model through netFormsOf (what arch/{darwin,win32}/netfacts.mjs return beside their OS reads).
 * `reply` null = the daemon is not running; `holders` = pids still on a door; `desired` 'on' | 'off'.
 */
export async function modelFacts({ os, desc, prior = null, on = true, reply, upstreams = null, systemProxy = null, desired = 'on', holders = [], drift = () => null, root = ROOT_OK, present = true }) {
  const w = world(desc, { prior, on })
  const answer = reply === null ? null : { pid: 4121, doors: w.doors, ...(upstreams ? { upstreams: upstreams(w.doors) } : {}), ...(reply || {}) }
  const status = {
    daemon: answer ? { state: 'running', pid: 4121, reply: { engine: { port: 17980 }, links: [], negatives: [], agents: [], ...answer } } : { state: 'not-running', pid: null, reply: null },
    link: { attached: null, helper: 'ok', ids: [] },
    harnesses: [{ id: desc.name, installed: true, desired, entry: { state: 'intact' }, installedAt: '2026-10-15T09:00:00.000Z', procs: [] }],
    holders: holders.map((pid) => ({ harness: desc.name, pid })),
  }
  const sysFact = systemProxy ? { value: systemProxy.url, pac: false } : { value: null, pac: false }
  const archFacts = async () => {
    const model = await modelFormFacts({ harnesses: MODEL, os, manifest: w.m, reply: status.daemon.reply, root, systemProxy, ctx: ctxOf(os, w.home, present), drift })
    return { routing: 'proxy', listeners: [7890, 7897].map((port) => ({ addr: '127.0.0.1', port, pid: 777, exe: '/opt/proxy/bin/mihomo' })), procs: {}, systemProxy: sysFact, ...netFormsOf({ model, status, systemProxy: sysFact }), unknowns: [] }
  }
  return gatherNetFacts({ platform: os, home: w.home, env: {}, harnesses: MODEL, status, archFacts, now: () => Date.parse('2026-10-16T10:00:00.000Z') })
}
