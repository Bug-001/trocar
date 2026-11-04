// launch.mjs (src/rules) — how a rule process starts (RFC 5.1 §规则进程「权限收窄」), and the one-shot client `rules test` uses (§槽文件). The resident pool is not here.
// Not Node IPC: a process that gives up its IPC channel stops receiving on it, and a script must not hold one. The channel is a plain pipe on fd 3.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LIMITS } from './closed.mjs'
import { ANSWER_BYTES, encodeFrame, frameReader, HEAD_BYTES, NO_RULE, readProgress } from './slot.mjs'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const APP = new URL('../../', import.meta.url)
const RUNNER = new URL('./runner.mjs', import.meta.url)
// The watchdog gets there first. This one is for a process frozen whole, watchdog included.
const FROZEN_MS = 100
// runner.mjs exits with this before it loads anything. After the load the same number is a script's process.exit(78).
const SELF_CHECK_FAILED = 78

/** The memory limit of one rule process: at most six run, so together they stay under 3/8 of the machine. */
export const memoryCap = (total = os.totalmem()) => Math.min(GIB, Math.floor(total / 16))

/** argv for `process.execPath`, or null when this Node has no permission model. Every path is real: a symlink in an allow list stops the process starting. */
export function runnerArgs({ script, slot, app = APP, capBytes, allowed = process.allowedNodeEnvironmentFlags }) {
  if (!allowed.has('--permission')) return null
  const real = fs.realpathSync, target = script ? real(script) : null, slotPath = real(slot)
  const flags = [
    '--permission', '--allow-worker', ...(target ? ['--allow-net'] : []),
    `--allow-fs-read=${path.join(real(app), '*')}`, ...(target ? [`--allow-fs-read=${path.join(path.dirname(target), '*')}`] : []),
    `--allow-fs-read=${slotPath}`, `--allow-fs-write=${slotPath}`, `--max-old-space-size=${Math.ceil(capBytes / MIB)}`,
  ]
  return [...flags.filter((flag) => allowed.has(flag.split('=')[0])), real(RUNNER), slotPath, ...(target ? [target] : [])]
}

// One process and its one question at a time. An answer nobody asked for is the process breaking the rule, so it goes.
function talkTo(args, slot) {
  const { XDG_RUNTIME_DIR } = process.env
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR } : {} })
  const pipe = child.stdio[3]
  let asked = null, killed = null
  const kill = (why) => {
    killed ??= why
    child.kill('SIGKILL')
  }
  const settle = (value) => {
    if (!asked) return
    const { resolve, timer } = asked
    asked = null
    clearTimeout(timer)
    resolve(value)
  }
  pipe?.on('data', frameReader((frame) => (asked && frame.id === asked.id ? settle(frame) : kill('bad-result')), () => kill('bad-result'), ANSWER_BYTES))
  pipe?.on('error', () => {}) // the write to a dead process: 'close' below says what happened
  const link = {
    dead: false,
    kill,
    ask: (message, ms) => new Promise((resolve) => {
      asked = { id: message.id, resolve, timer: setTimeout(() => kill('timeout'), ms) }
      pipe.write(encodeFrame(message))
    }),
  }
  link.gone = new Promise((resolve) => {
    const end = (code) => {
      link.dead = true
      settle({ died: killed ?? readProgress(slot).death ?? 'crashed', code })
      resolve()
    }
    child.once('close', end)
    child.once('error', () => end(null))
  })
  return link
}

/** A rule process for `rules test`: `run(unit)` → the answer, `{died}` when the process died on it, one at a time; the next run starts a new one. `close()` takes the process and
 *  its slot away. An answer is applyRules's result less `survivors`, plus `console`, `edits` parsed and `bytes` read back; or `{id, why}` when the process would not answer. */
export function openOneShot({ script, rules, maxTaskMs = 2000, tmp = os.tmpdir(), capBytes = memoryCap() }) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(tmp), 'trocar-slot-'))
  const file = path.join(dir, 'slot.bin')
  const slot = fs.openSync(file, 'wx+', 0o600)
  let runner = null, task = 0

  async function start() {
    fs.ftruncateSync(slot, 0)
    const args = runnerArgs({ script, slot: file, capBytes })
    if (!args) return { died: 'runner-down' }
    runner = talkTo(args, slot)
    const answer = await runner.ask({ load: { rules, max_delay_ms: maxTaskMs } }, LIMITS.loadMs + FROZEN_MS)
    if (answer.ready) return answer
    runner.kill('load-failed')
    await runner.gone
    return { died: answer.code === SELF_CHECK_FAILED ? 'runner-down' : 'load-failed', reason: answer.reason ?? answer.died }
  }

  const slice = ({ at, bytes }) => {
    const out = Buffer.alloc(bytes)
    if (fs.readSync(slot, out, 0, bytes, at) !== bytes) throw new RangeError('short slot')
    return out
  }

  function take({ body, edits, ...answer }) {
    try {
      return { ...answer, bytes: body ? slice(body) : null, edits: edits ? JSON.parse(`[${slice(edits)}]`) : [] }
    } catch {
      runner.kill('bad-result')
      return { died: 'bad-result' }
    }
  }

  async function run({ body, ...unit }) {
    if (!runner || runner.dead) {
      const started = await start()
      if (started.died) return started
    }
    const id = ++task
    if (body) fs.writeSync(slot, body, 0, body.length, HEAD_BYTES)
    const frame = await runner.ask({ id, unit, body_bytes: body ? body.length : null }, maxTaskMs + FROZEN_MS)
    const { task: ran, rule } = readProgress(slot)
    const answer = frame.died ? { died: frame.died, rule: ran === id && rule !== NO_RULE ? rule : null } : take(frame)
    fs.ftruncateSync(slot, 0) // the body is an agent's: it stays here only as long as the task
    return answer
  }

  async function close() {
    if (runner && !runner.dead) {
      runner.kill('closed')
      await runner.gone
    }
    fs.closeSync(slot)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { run, close }
}
