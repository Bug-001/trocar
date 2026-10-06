// test/collector/harness/_ctx.mjs — builds the ctx a harness callback receives from the tracker, over a
// temp HOME, plus a one-call "judge" (registry + layers + trust) for descriptor tests. Exports only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { createTrustChecker, effectiveEnv, markerLayer } from '../../../src/collector/core/trust/confirm.mjs'
import { readText, readTextOrError } from '../../../src/collector/core/config-read.mjs'

export function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-h-'))
  const put = (rel, text) => { const f = path.isAbsolute(rel) ? rel : path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  return { home, put, done: () => fs.rmSync(home, { recursive: true, force: true }) }
}

// os defaults to 'none' so no machine-wide config dir (/etc/…) is read unless a test opts in (0.1 §3).
// startedAt defaults to a process started just after the sandbox was written (an unknown start time is judged
// untrusted for a layer read only at start — review 2 #5); pass null to test exactly that.
export function ctxFor({ home, cwd = home, env = {}, argv = [], os: osName = 'none', startedAt = Date.now() + 1000, startTicks = null, pid = 1000, unparsable = undefined }) {
  const environ = new Map(Object.entries(env))
  return {
    os: osName, environ, env: environ, home, cwd, argv, startedAt, startTicks, pid,
    readText: (f) => readText(f),
    readTextOrError: (f) => readTextOrError(f),
    mtimeOf: (f) => { try { return fs.statSync(f).mtimeMs } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
    ...(unparsable ? { unparsable } : {}),
  }
}

export const facts = (o) => ({ os: 'linux', pid: 1000, ppid: 1, uid: 1000, exe: null, argv: [], env: new Map(), cwd: '/', startedAt: null, source: 'exec', ...o })

export const CA = createCa({ commonName: 'asight collector CA' })
export const OTHER = createCa({ commonName: 'not asight' })

// A plugin's per-pid trust marker (4.6 「标记」): <dir>/<pid> = the process's start ticks.
export function plantMarker(dir, pid, ticks) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, String(pid)), String(ticks)); return dir }

// What the tracker computes for one process: trust result + the env its readers see. With markerDir + caPem the
// plugin marker layer is added as the tracker adds it; runtimeVersion is what the tracker reads from the exe.
export function judge(descriptor, ctx, { markerDir = null, caPem = null, runtimeVersion = null, collectorDir = path.join(ctx.home, '.asight', 'collector'), exe = null, caCertPem = CA.certPem } = {}) {
  const layers = (descriptor.layers ? descriptor.layers(ctx) : []).filter(Boolean)
  const marker = markerDir && caPem ? markerLayer({ dir: markerDir, pid: ctx.pid, startTicks: ctx.startTicks, caPem, readText: (f) => readText(f) }) : null
  if (marker) layers.push(marker)
  const trust = createTrustChecker({ caCertPem }).check(descriptor.trust, { environ: ctx.environ, layers, cwd: ctx.cwd, startedAt: ctx.startedAt, argv: ctx.argv, extra: { runtimeVersion: () => runtimeVersion, readText: ctx.readText, collectorDir, exe } })
  const live = { ...ctx, env: effectiveEnv(ctx.environ, layers.filter((l) => !l.ignored)).env }
  const proxyEntries = descriptor.proxies ? descriptor.proxies(live) : []
  return { trust, layers, hosts: descriptor.configHosts ? descriptor.configHosts(live) : [], proxies: proxyEntries.map((p) => p.url), proxyEntries }
}

export const matchOf = (descriptors, f) => createRegistry(descriptors).match(f)
