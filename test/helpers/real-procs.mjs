// test/helpers/real-procs.mjs — the one table the real-OS identity contracts run (0.1 §3 约定 2 / 3, G3; plan 2026-10-14-d51-name-allowlist §5, §7):
// install shapes of Claude Code made REAL — the system's `sleep` copied to each path under a tmpDir() and started — so the process facts the OS
// gives for them (darwin: `ps` + `lsof`; linux: /proc) go through the same name list the daemon and `off` judge by. No agent is started, nothing
// outside the temp dir is touched. Used by test/collector/arch/{darwin,linux}/identity-real.test.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { onceWithin } from './bounded.mjs'

/** The program every shape is a copy of: it only sleeps, and it is on every darwin and linux machine. */
export const SLEEP = '/bin/sleep'

/** The shapes: `file` is where the copy lives (relative to the sandbox), `via` a symlink it is started through instead (argv[0] is then the
 *  link, the executable the target), `expect` the harness the preset list names (null: none), `listed` the harness once agents.json adds it,
 *  `host` (when present) the harness whose form names it as its host program. */
export const SHAPES = Object.freeze([
  { label: 'Homebrew cask', file: 'Caskroom/claude-code/9.9.9/claude', expect: 'claude-code' },
  { label: 'Desktop-bundled Claude Code (spaces in the path)', file: 'Application Support/Claude/claude-code/9.9.9/abc/claude.app/Contents/MacOS/claude', expect: 'claude-code' },
  { label: 'native version-named file, started directly', file: 'claude/versions/9.9.9', expect: 'claude-code' },
  { label: 'native version-named file, started through bin/claude', file: 'claude/versions/9.9.9', via: 'bin/claude', expect: 'claude-code' },
  { label: 'a space and CJK in the directory', file: '测 试/claude', expect: 'claude-code' },
  { label: 'a name on no preset list', file: 'claude-nightly', expect: null, listed: 'claude-code' },
  // an editor's helpers: on no name list; `host` = the harness whose form's hosts.processes names it (the host-tree rule, darwin forms)
  { label: 'VS Code\'s extension host (spaces and parentheses)', file: 'Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)', expect: null, host: 'kimi-code' },
  { label: 'VS Code\'s plain helper (the Chromium network service)', file: 'Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper', expect: null, host: null },
])

/** Copies `source` to every shape's file under `dir` (once per file) and makes the symlinks. `prepare(file)` runs on each copy (darwin re-signs
 *  it). → the shapes with `exe` (the copy) and `run` (what is started). */
export function stageShapes(dir, source, { prepare = () => {} } = {}) {
  const done = new Set()
  return SHAPES.map((s) => {
    const exe = path.join(dir, s.file)
    if (!done.has(exe)) {
      fs.mkdirSync(path.dirname(exe), { recursive: true })
      fs.copyFileSync(source, exe)
      fs.chmodSync(exe, 0o755)
      prepare(exe)
      done.add(exe)
    }
    let run = exe
    if (s.via) {
      run = path.join(dir, s.via)
      fs.mkdirSync(path.dirname(run), { recursive: true })
      fs.symlinkSync(exe, run)
    }
    return { ...s, exe: fs.realpathSync(exe), run }
  })
}

/** Starts every staged shape (`run 30`) and waits until each has exec'd. → [{ shape, child, pid }]; stopAll() ends them. */
export async function startShapes(staged) {
  const out = []
  for (const shape of staged) {
    const child = spawn(shape.run, ['30'], { stdio: 'ignore' })
    out.push({ shape, child, pid: child.pid })
    await onceWithin(child, 'spawn')
  }
  return out
}

/** Kills them and waits for each exit, so the temp dir is removed with nothing running from it (leak-guard). */
export async function stopAll(procs) {
  await Promise.all(procs.map(({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null) return null
    const gone = onceWithin(child, 'exit')
    child.kill('SIGKILL')
    return gone
  }))
}
