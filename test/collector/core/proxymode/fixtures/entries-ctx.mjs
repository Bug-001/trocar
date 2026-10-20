// entries-ctx.mjs — a temp world for the P5 route writers (core/proxymode/entries.mjs): a HOME, the collector dir with an empty manifest, and sources.mjs's
// ctx whose reads see the temp tree plus a virtual overlay (a form's `present` place, a blocker's file or policy) so no real OS path is touched.
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../../helpers/tmp.mjs'
import { newManifest } from '../../../../../src/off/manifest.mjs'
import { resolveLoc } from '../../../../../src/collector/core/proxymode/sources.mjs'

export const LOOP = ['localhost', '127.0.0.1', '::1']
export const door = (port = 18001) => `http://g:0123456789abcdef0123456789abcdef@127.0.0.1:${port}`
/** The P6 value as the spec says it, written here, not taken from the code under test. */
export const merged = (...vals) => { const seen = new Set(); return [...LOOP, ...vals.flatMap((v) => (v ? v.split(',') : []))].map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).join(',') }

export function world({ os = 'darwin', env = {}, persistent = {}, systemProxy = null } = {}) {
  const root = tmpDir('trocar-entries-')
  const home = path.join(root, 'home')
  const dir = path.join(home, '.trocar', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  const virtual = new Map(), policies = new Set(), commands = new Set()
  let n = 0
  const inside = (p) => p === root || p.startsWith(root + path.sep)
  const ctx = {
    os, home, cwd: path.join(root, 'proj'), env, dirs: { appSupport: path.join(root, 'as'), localAppData: path.join(root, 'la') },
    readFile: (p) => (virtual.has(p) ? virtual.get(p) : fs.readFileSync(p, 'utf8')),
    exists: (p) => virtual.has(p) || (inside(p) && fs.existsSync(p)), // an absolute path outside the temp tree (/Applications/…) is never this machine's
    readdir: (p) => { const v = [...virtual.keys()].filter((k) => path.dirname(k) === p).map((k) => path.basename(k)); try { return [...(inside(p) ? fs.readdirSync(p) : []), ...v] } catch (e) { if (v.length) return v; throw e } },
    which: (c) => (commands.has(c) ? path.join(root, 'bin', c) : null),
    policy: (spec) => (policies.has(JSON.stringify(spec)) ? { set: true, value: 'http://managed.example:1', where: `policy:${JSON.stringify(spec)}` } : { set: false }),
    dir, manifest: newManifest(), fs, now: () => new Date('2026-10-16T00:00:00Z'), persistentEnv: () => persistent, systemProxy,
    render: (id, v) => `// ${id} ${v.door}\n`, newId: () => `trocar-${++n}`,
  }
  const pick = (l) => (l && l.perOs ? l.perOs[os] : l)
  /** Make a form installed: its first `present` place that exists on this OS. */
  const present = (form) => {
    for (const p of form.present || []) {
      if (p && 'command' in p) { commands.add(p.command); return }
      const l = pick(p)
      if (!l) continue
      const at = resolveLoc({ ...l, glob: undefined }, ctx)[0]
      virtual.set(l.glob ? path.join(at, l.glob.replace(/\*/g, 'x')) : at, '')
      return
    }
  }
  /** Set a blocker's source: an env var, a managed policy, or a key in a (virtual) file. false when the source has nothing on this OS. */
  const plant = (src) => {
    if ('env' in src) { env[src.env] = 'http://blocked.example:1'; return true }
    if ('policy' in src) { if (!src.policy[os]) return false; policies.add(JSON.stringify(src.policy[os])); return true }
    const l = pick(src.file)
    if (!l) return false
    const at = resolveLoc({ ...l, glob: undefined }, ctx)[0]
    const doc = src.keys.reduceRight((inner, k) => ({ [k]: inner }), 'http://blocked.example:1')
    virtual.set(l.glob ? path.join(at, l.glob.replace(/\*/g, 'x')) : at, JSON.stringify(doc))
    return true
  }
  return { root, home, dir, ctx, present, plant }
}

export const put = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data) }
export const bytesOf = (f) => { try { return fs.readFileSync(f) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
