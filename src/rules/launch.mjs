// launch.mjs (src/rules) — how a rule process starts (RFC 5.1 §规则进程「权限收窄」), and the one-shot client `rules test` uses (§槽文件). The resident pool is not here.
// Not Node IPC: a process that gives up its IPC channel stops receiving on it, and a script must not hold one. The channel is a plain pipe on fd 3.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LIMITS, SKIP_WHY } from './closed.mjs'
import { checkHeaderSet, headerChanges } from './headers.mjs'
import { normalizeRule } from './validate.mjs'
import { ANSWER_BYTES, encodeFrame, frameReader, HEAD_BYTES, NO_RULE, readProgress, segmentHolds } from './slot.mjs'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const APP = new URL('../..', import.meta.url) // no trailing slash: test/ci/reachable.test.mjs reads one as "everything in this directory"
const RUNNER = new URL('./runner.mjs', import.meta.url)
// The watchdog gets there first. This one is for a process frozen whole, watchdog included.
const FROZEN_MS = 100
const VERDICTS = Object.freeze(['forward', 'drop', 'reply', 'hold'])
// V8's, so `allowed` does not list it. On the command line and not from v8.setFlagsFromString: flipped in a running process, about one start in three hundred under load died of
// SIGBUS on entering a regex's code. From the command line none in the same run did.
const REGEX_FLAG = '--no-regexp-tier-up'

/** The memory limit of one rule process: at most six run, so together they stay under 3/8 of the machine. */
export const memoryCap = (total = os.totalmem()) => Math.min(GIB, Math.floor(total / 16))

/** argv for `process.execPath`, or null when this Node has no permission model. Every path is real: a symlink in an allow list stops the process starting. */
export function runnerArgs({ script, slot, app = APP, capBytes, allowed = process.allowedNodeEnvironmentFlags }) {
  if (!allowed.has('--permission')) return null
  const real = fs.realpathSync, target = script ? real(script) : null, slotPath = real(slot)
  const flags = [
    '--permission', '--allow-worker', ...(target ? ['--allow-net', '--frozen-intrinsics'] : []),
    `--allow-fs-read=${path.join(real(app), '*')}`, ...(target ? [`--allow-fs-read=${path.join(path.dirname(target), '*')}`] : []),
    `--allow-fs-read=${slotPath}`, `--allow-fs-write=${slotPath}`, `--max-old-space-size=${Math.ceil(capBytes / MIB)}`,
  ]
  return [REGEX_FLAG, ...flags.filter((flag) => allowed.has(flag.split('=')[0])), real(RUNNER), slotPath, String(process.pid), ...(target ? [target] : [])]
}

// One process and its one question at a time. An answer nobody asked for is the process breaking the rule, so it goes. `ask` resolves to `{frame}` or to `{died, code}`:
// a process says what it answers, never how it ended.
function talkTo(args, slot) {
  const { XDG_RUNTIME_DIR } = process.env
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'ignore', 'ignore', 'pipe'], env: XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR } : {} })
  const [pipeIn, , , pipe] = child.stdio ?? [] // none at all when no fd was left to make them: 'error' below says so
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
  pipe?.on('data', frameReader((frame) => (asked && frame.id === asked.id ? settle({ frame }) : kill('bad-result')), () => kill('bad-result'), ANSWER_BYTES))
  for (const end of [pipeIn, pipe]) end?.on('error', () => {}) // the write to a dead process: 'close' below says what happened
  const link = {
    dead: false,
    get killed() { return killed }, // set before `dead`: until 'close' the process is going, and hears nothing more
    kill,
    ask: (message, ms) => new Promise((resolve) => {
      asked = { id: message.id, resolve, timer: setTimeout(() => kill('timeout'), ms) }
      pipeIn?.write(encodeFrame(message))
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

/** A rule process for `rules test`: `run(unit)` → the answer, `{died}` when the process died on it, one at a time; the next run starts a new one, unless it was the load that failed:
 *  every run after that gets the same `{died, reason}`. `close()` takes the process and its slot away. An answer is applyRules's result less `survivors`, plus `console`, `edits` parsed and `bytes` read back; or `{id, why}` when the process would not answer. */
export function openOneShot({ script, rules, maxTaskMs = 2000, tmp = os.tmpdir(), capBytes = memoryCap() }) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(tmp), 'trocar-slot-'))
  const file = path.join(dir, 'slot.bin')
  const slot = fs.openSync(file, 'wx+', 0o600)
  let runner = null, task = 0, unloaded = null

  async function start() {
    fs.ftruncateSync(slot, 0)
    const args = runnerArgs({ script, slot: file, capBytes })
    if (!args) return { died: 'runner-down' }
    runner = talkTo(args, slot)
    const { frame, died, code } = await runner.ask({ load: { rules, max_delay_ms: maxTaskMs } }, LIMITS.loadMs + FROZEN_MS)
    if (frame?.ready) return null
    runner.kill('load-failed')
    await runner.gone
    return { died: !frame && !fs.fstatSync(slot).size ? 'runner-down' : 'load-failed', reason: frame?.reason ?? died } // an empty slot: this Node never reached the rule process's code
  }

  const slice = ({ at, bytes }) => {
    if (at < HEAD_BYTES || bytes > LIMITS.bodyBytes) throw new RangeError('not a place in the slot')
    const out = Buffer.alloc(bytes)
    if (fs.readSync(slot, out, 0, bytes, at) !== bytes) throw new RangeError('short slot')
    return out
  }

  // A script can write on the channel too, so what makes an answer safe to use is checked here, not only where the answer was made.
  function trusted({ why, skipped = [], hits = [], would = [], rule_ms: ms = {}, console: said = '', verdict, headers }, unit) {
    const shaped = [skipped, hits, would].every(Array.isArray) && Object(ms) === ms && typeof said === 'string' && (why !== undefined || VERDICTS.includes(verdict))
    if (!shaped) return false
    const closed = (reason) => SKIP_WHY.includes(reason)
    const inClosedSet = (why === undefined || closed(why)) && skipped.every((skip) => closed(skip?.why))
    const changes = headers === null || headers === undefined ? [] : headerChanges(unit.headers ?? [], headers)
    return inClosedSet && checkHeaderSet(changes, { before: unit.headers ?? [] }).length === 0
  }

  // What the action at `[rule, at]` says under `key`. A place that holds no such thing throws, which is a bad answer like any other.
  function effectAt([rule, at], key) {
    const value = normalizeRule(rules[rule]).do[at][key]
    if (value === undefined) throw new RangeError(`no ${key} there`)
    return value
  }

  function take({ body, edits, ...answer }, unit) {
    try {
      if ('died' in answer || !trusted(answer, unit)) throw new RangeError('an answer the rules could not have given')
      const reply = answer.reply_at ? effectAt(answer.reply_at, 'reply') : null, inject = (answer.inject_at ?? []).map((at) => effectAt(at, 'inject'))
      const segment = edits ? slice(edits) : Buffer.alloc(0)
      if (!segmentHolds(segment)) throw new RangeError('not an edits segment')
      return { ...answer, reply, inject, bytes: body ? slice(body) : null, edits: JSON.parse(`[${segment}]`) }
    } catch {
      runner.kill('bad-result')
      return { died: 'bad-result' }
    }
  }

  async function run({ body, ...unit }) {
    if (unloaded) return unloaded
    if (runner?.killed) await runner.gone
    if (!runner || runner.dead) {
      unloaded = await start().catch((e) => ({ died: 'load-failed', reason: e.message }))
      if (unloaded) return unloaded
    }
    const id = ++task
    if (body) fs.writeSync(slot, body, 0, body.length, HEAD_BYTES)
    const { frame, died } = await runner.ask({ id, unit, body_bytes: body ? body.length : null }, maxTaskMs + FROZEN_MS)
    const { task: ran, rule } = readProgress(slot)
    const fate = died ?? runner.killed // a second answer in the same read as the first
    const answer = fate ? { died: fate, rule: ran === id && rule !== NO_RULE ? rule : null } : take(frame, unit)
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
