// test/helpers/contract-world.mjs — the world of the switch contract suite (RFC 4.11 CM15 / CM25 / CM26 / CM32, D48, D54): a modelWorld
// (tmp HOME, stub custody, in-memory user root store) made hermetic for paths outside HOME, a form made present from its descriptor's `present`
// data alone, a real control server standing for the daemon (startControlServer at the endpoint control.json names), and the four commands the
// product has — runInstall, turnOnModel, runOffCli, runUninstall — each with a recording runner for the OS tools. A snapshot is HOME as bytes,
// mode, owner and mtime per path, plus every OS-tool call and trust-store verb seen so far. Imports src only for the commands under test and the
// descriptor reader; every expectation is made by the suite from snapshots (G4). Exports only.
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from './model-world.mjs'
import { tmpDir } from './tmp.mjs'
import { renderWrapper as darwinWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { renderWrapper as win32Wrapper } from '../../src/collector/arch/win32/wrapper.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { resolveLoc } from '../../src/collector/core/proxymode/sources.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])
const PE = Buffer.from('MZ\x90\x00 a native program', 'latin1')
const TOKEN = 'c'.repeat(32)
const pick = (x, os) => (x && x.perOs ? x.perOs[os] : x)
const inside = (root, p) => p === root || p.startsWith(root + path.sep) || p.startsWith(root + '/')

/** The places a form's `present` names on this OS, as data: { command } | { loc, at, abs }. */
export function placesOf(form, ctx) {
  return (form.present || []).map((p) => {
    if ('command' in p) return { command: p.command }
    const l = pick(p, ctx.os)
    if (!l) return null
    const at = resolveLoc({ ...l, glob: undefined }, ctx)[0]
    return at ? { at: l.glob ? path.join(at, l.glob.replace(/\*/g, '1.0.0')) : at, abs: l.base === 'abs' } : null
  }).filter(Boolean)
}

/** world({ os, env }) → a modelWorld whose ctx sees nothing outside HOME but the apps `install(place)` put on its fake machine. */
export async function contractWorld({ os, env = {} }) {
  const w = await modelWorld({ os, env })
  w.os = os
  const apps = new Set()
  const ok = (p) => inside(w.home, p)
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  w.ctx.exists = (p) => apps.has(p) || (ok(p) && fs.existsSync(p))
  w.ctx.readdir = (p) => { const kids = [...apps].filter((a) => path.dirname(a) === p).map((a) => path.basename(a)); if (kids.length) return kids; if (!ok(p)) throw enoent(p); return fs.readdirSync(p) }
  w.ctx.readFile = (p) => { if (!ok(p)) throw enoent(p); return fs.readFileSync(p, 'utf8') }
  /** Make one place present: a command on PATH, an app on the machine, a program file in a bin directory, or a folder. */
  w.place = (pl) => {
    if (pl.command) return fs.writeFileSync(path.join(w.home, 'bin', pl.command), '#!/bin/sh\n', { mode: 0o755 })
    if (pl.abs) return apps.add(pl.at)
    fs.mkdirSync(path.dirname(pl.at), { recursive: true })
    if (/[\\/]bin[\\/][^\\/]+$/.test(pl.at)) fs.writeFileSync(pl.at, os === 'win32' ? PE : MACHO, { mode: 0o755 })
    else fs.mkdirSync(pl.at, { recursive: true })
  }
  w.exec = []
  const run = (file, args) => { w.exec.push([file, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' } }
  const kit = os === 'win32' ? { renderWrapper: win32Wrapper, compile: (src) => Buffer.concat([PE, Buffer.from(String(src.length))]) } : { renderWrapper: darwinWrapper }
  w.cmd = {
    install: () => w.install({ wrapperKit: kit, renderHook }),
    on: (ids = null) => turnOnModel({ os, home: w.home, env: w.env, ids, harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook }),
    off: async (ids = []) => {
      const out = []
      const io = { out: (s) => out.push(s), err: (s) => out.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
      const code = await runOffCli(ids, { io, home: w.home, env: w.env, platform: os, deps: { getuid: () => 501, procs: async () => [], alive: () => false, identity: () => ({ start_time: '1', boot_id: 'b' }), sleep: async () => {}, exec: run } })
      return { exit: code, text: out.join('\n') }
    },
    uninstall: async () => {
      const { receipt, exit } = await runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform: os, exec: run, custody: w.custody, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501 } })
      return { exit, receipt }
    },
  }
  return w
}

/** A real control server for the world's daemon: POST /on opens a door per group, POST /off and GET /holders answer as an idle daemon does. The
 *  endpoint has the platform's own shape (a win32 one is a pipe name: run the case inside withScratchCwd) and lies outside HOME, so it is no residue. */
export async function daemonFor(w) {
  const sock = w.os === 'win32' ? `\\\\.\\pipe\\asight-contract-${path.basename(w.home)}` : path.join(tmpDir('asight-sock-'), 'c.sock')
  fs.mkdirSync(w.dir, { recursive: true })
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token: TOKEN }))
  const doors = {}
  const server = await startControlServer({ socketPath: sock, token: TOKEN, routes: {
    'GET /status': async () => ({ doors }),
    'GET /holders': async () => ({ count: 0, holders: [] }),
    'POST /on': async ({ body }) => { for (const [g, port] of Object.entries(body.groups)) doors[g] = port; return { doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) } },
    'POST /off': async () => ({ confirmed: true, relayed: 0, actual: 'off', exited: false }),
  } })
  return { close: () => server.close(), sock }
}

/** HOME as { path: { bytes?, mode, uid, mtime?, dir?, link? } } plus the OS-tool calls and trust-store verbs seen so far. */
export function snapshot(w) {
  const files = {}
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), st = fs.lstatSync(p), rel = path.relative(w.home, p)
      if (st.isSymbolicLink()) files[rel] = { link: fs.readlinkSync(p), uid: st.uid }
      else if (st.isDirectory()) { files[rel] = { dir: true, mode: st.mode & 0o7777, uid: st.uid }; walk(p) }
      else if (st.isFile()) files[rel] = { bytes: fs.readFileSync(p).toString('base64'), mode: st.mode & 0o7777, uid: st.uid, mtime: st.mtimeMs }
      else files[rel] = { other: true, uid: st.uid }
    }
  }
  walk(w.home)
  return { files, exec: [...w.exec], store: [...w.store.calls] }
}
