// runner.mjs (src/rules) — a rule process (RFC 5.1 §规则进程): the only place a rule's regex, JSON edit or script runs. `node --permission … runner.mjs <slot> <parent pid> [<script>]`, see
// launch.mjs. Frames come in on stdin and go out on fd 3. First frame `{load: {rules, max_delay_ms}}` → `{ready: true}`; each task `{id, unit, body_bytes}` with the body in the slot → one answer.
const { fileURLToPath } = await import('node:url')
const capMiB = process.execArgv.map((arg) => /^--max-old-space-size=(\d+)$/.exec(arg)?.[1]).find(Boolean)
const { permission } = process
// A Node that would quietly give more than the flags asked for gets no rules at all.
if (!permission || permission.has('child') || permission.has('fs.write', fileURLToPath(new URL('../..', import.meta.url))) || !capMiB) process.exit(78)

const [{ Buffer }, { once }, fs, { pathToFileURL }, util, threads, modules, os, { full, RuleFault }, { applyRules }, { byteBudget }, { LIMITS, SCRIPT_BUILTINS, SCRIPT_FORMATS }, { compileRules }, slots] = await Promise.all([
  import('node:buffer'), import('node:events'), import('node:fs'), import('node:url'), import('node:util'), import('node:worker_threads'), import('node:module'), import('node:os'),
  import('./actions.mjs'), import('./apply.mjs'), import('./budget.mjs'), import('./closed.mjs'), import('./compile.mjs'), import('./slot.mjs'),
])
const { ANSWER_BYTES, DEATHS, editsSegment, encodeFrame, frameReader, HEAD_BYTES, NO_RULE, writeProgress } = slots

const MIB = 1024 * 1024
const NS_PER_MS = 1_000_000n
const CONSOLE_BYTES = 16 * 1024
const LOAD_REASON_CHARS = 1024
const SCRIPT_RESULT_KEYS = new Set(['body', 'headers'])
const KEPT_ENV = Object.freeze(['SYSTEMROOT', 'XDG_RUNTIME_DIR'])

const [slotPath, parentPid, scriptPath] = process.argv.slice(2)
const capBytes = Number(capMiB) * MIB
const slot = fs.openSync(slotPath, 'r+')

const shared = new SharedArrayBuffer(24)
const deadline = new BigInt64Array(shared, 0, 1)
const wake = new Int32Array(shared, 8, 1)
const over = new Int32Array(shared, 12, 1) // an index into DEATHS, plus one
const beat = new Int32Array(shared, 16, 1)
const setClock = (at) => {
  Atomics.store(deadline, 0, at)
  Atomics.add(wake, 0, 1)
  Atomics.notify(wake, 0)
}
// Kept here: `process` is not frozen, and a script that swaps these must not stop the clock or the memory check.
const { getActiveResourcesInfo, memoryUsage } = process, { bigint: clockNow } = process.hrtime
const arm = (ms) => setClock(clockNow() + BigInt(Math.max(0, Math.ceil(ms))) * NS_PER_MS)

const watchdog = new threads.Worker(new URL('./watchdog.mjs', import.meta.url), { workerData: { shared, fd: slot, slotPath, capBytes, ppid: Number(parentPid) } })
watchdog.once('exit', () => process.exit(1)) // no rule runs unwatched
await once(watchdog, 'online')

// The permission model has no say over signals, threads, or what sqlite, trace events, V8's flags and a child process handle do below it. Only the watchdog needs a thread and it is up,
// so the door closes behind it, before any rule or script loads (5.1 §隔离). What may be imported is listed, and a CommonJS file is out because `module` in one is all of node:module.
modules.registerHooks({
  resolve(specifier, context, next) {
    if (modules.isBuiltin(specifier) && !SCRIPT_BUILTINS.includes(specifier.replace(/^node:/, ''))) throw new Error(`a rule process has no ${specifier}`)
    return next(specifier, context)
  },
  load(url, context, next) {
    const loaded = next(url, context)
    if (!SCRIPT_FORMATS.includes(loaded.format)) throw new Error(`a rule process loads ES modules only, not ${url}`)
    return loaded
  },
})
for (const name of ['kill', '_kill', '_debugProcess', '_debugEnd', 'getBuiltinModule']) delete process[name]
// Windows hands every child PATH, USERNAME and the like whatever env it was given. SYSTEMROOT stays: sockets do not load without it.
for (const name of Object.keys(process.env)) if (!KEPT_ENV.includes(name.toUpperCase())) delete process.env[name]
os.default.setPriority = function refused() { throw new Error('a rule process has no say over other processes') }
modules.syncBuiltinESMExports()
// The flag freezes what the language brings. Buffer is Node's, and this code reports through it.
Object.freeze(Buffer.prototype)
Object.freeze(Buffer)

// RSS misses pages macOS compressed and Windows trimmed, and a leak of sockets is ports nobody else on the machine can have. A stuck main thread stops this tick, and the beat says so.
const tell = (why) => {
  Atomics.store(over, 0, DEATHS.indexOf(why) + 1) // the watchdog kills: this thread no longer can
  Atomics.add(wake, 0, 1)
  Atomics.notify(wake, 0)
}
setInterval(() => {
  Atomics.add(beat, 0, 1)
  const { heapUsed, external, arrayBuffers } = memoryUsage()
  if (heapUsed + external + arrayBuffers > capBytes) tell('memory')
  if (getActiveResourcesInfo().length > LIMITS.scriptHandles) tell('handles')
}, 1000).unref()

let printed = ''
const print = (...args) => { printed = `${printed}${util.format(...args)}\n`.slice(0, CONSOLE_BYTES) }
globalThis.console = { ...console, log: print, info: print, warn: print, error: print, debug: print }

// Counted as the frame carries it: 16 KiB of control characters is 96 KiB of escapes.
function consoleText() {
  let text = printed
  while (Buffer.byteLength(JSON.stringify(text)) > CONSOLE_BYTES) text = text.slice(0, Math.floor(text.length * 3 / 4))
  return text
}

let progress = { task: 0, rule: NO_RULE, slowest: NO_RULE, done: false }
writeProgress(slot, progress) // the parent's sign that this Node got as far as here
let spent = new Map(), since = 0

function enter(rule) {
  if (rule === progress.rule) return
  const now = performance.now()
  if (progress.rule !== NO_RULE) {
    const total = (spent.get(progress.rule) ?? 0) + now - since
    spent.set(progress.rule, total)
    if (total >= (spent.get(progress.slowest) ?? 0)) progress.slowest = progress.rule
  }
  since = now
  progress.rule = rule
  writeProgress(slot, progress)
}

let lookup = null, watched = null, script = null, maxTaskMs = 0

// applyRules runs rules one after the other without saying so; every way into one passes here, so a death can be laid at the right rule.
function watchRules({ rules, lookup: find }) {
  const owner = new Map()
  for (const { rule, index } of rules) for (const key of [rule, ...rule.do]) owner.set(key, index)
  const tracked = rules.map((compiled) => ({ ...compiled, judge: (...args) => { enter(compiled.index); return compiled.judge(...args) } }))
  lookup = (unit) => find(unit.on, unit.harness, unit.host).map(({ index }) => tracked[index])
  watched = {
    decode: full.decode,
    judge: (rule, ...args) => { enter(owner.get(rule)); return full.judge(rule, ...args) },
    act: (action, ...args) => { enter(owner.get(action)); return full.act(action, ...args) },
  }
  return owner
}

const isBytes = (value) => value instanceof Uint8Array
const asBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

// What a script may answer → what applyRules takes. A key it does not know is a typo that would otherwise change nothing without a word.
function scriptResult(result) {
  if (result === null || result === undefined || typeof result === 'string') return result
  if (isBytes(result)) return asBuffer(result)
  const plain = typeof result === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(result))
  if (!plain || Object.keys(result).some((key) => !SCRIPT_RESULT_KEYS.has(key))) throw new RuleFault('bad-result') // an ArrayBuffer or a Map is not a change that came to nothing
  const { body, headers } = result
  return {
    body: isBytes(body) ? asBuffer(body) : body,
    headers: headers !== null && typeof headers === 'object' && !Array.isArray(headers) ? Object.entries(headers) : headers,
  }
}

function loadScript(run, owner) {
  script = async (rule, message) => {
    enter(owner.get(rule))
    // What a script throws is not a closed `why`.
    try { return scriptResult(await run(message)) } catch (e) { throw e instanceof RuleFault ? e : new RuleFault('rule-error') }
  }
}

async function load({ rules, max_delay_ms }) {
  const started = performance.now()
  const left = () => LIMITS.loadMs - (performance.now() - started)
  maxTaskMs = max_delay_ms
  arm(left())
  try {
    const compiled = compileRules({ rules }), owner = watchRules(compiled)
    for (const { rule, index } of compiled.rules) {
      progress.rule = index
      writeProgress(slot, progress)
      full.warm(rule, () => arm(Math.min(LIMITS.regexLoadMs, left())))
    }
    if (scriptPath) {
      arm(left())
      const { default: run } = await import(pathToFileURL(scriptPath))
      if (typeof run !== 'function') throw new TypeError('a script\'s default export is a function')
      loadScript(run, owner)
    }
    setClock(0n)
    return { ready: true }
  } catch (e) {
    return { ready: false, reason: String(e?.message ?? e).slice(0, LOAD_REASON_CHARS) }
  }
}

function readBody(size) {
  if (size === null) return null
  const body = Buffer.allocUnsafeSlow(size)
  if (size && fs.readSync(slot, body, 0, size, HEAD_BYTES) !== size) throw new RuleFault('rule-error')
  return body
}

// `recover`'s bulk stays out of the frame: its edits are the edits segment, its inline body the bytes the parent holds. So does what a reply and an injected event say:
// the rule file allows them far more than a frame holds, and the parent has the rules, so `reply_at` and `inject_at` are enough.
function answerOf(id, { escalate, survivors, bytes, edits, recover, reply, inject, ...rest }, end) {
  const answer = { id, ...rest, recover: null, body: null, edits: null }
  if (recover) answer.recover = { recover: recover.recover, base_sha256: recover.base_sha256, result_sha256: recover.result_sha256 }
  if (bytes) {
    if (bytes.length > LIMITS.bodyBytes) throw new RuleFault('too-big')
    fs.writeSync(slot, bytes, 0, bytes.length, end)
    answer.body = { at: end, bytes: bytes.length }
    end += bytes.length
  }
  const segment = editsSegment(edits)
  if (segment.length) {
    fs.writeSync(slot, segment, 0, segment.length, end)
    answer.edits = { at: end, bytes: segment.length }
  }
  return answer
}

async function work({ id, unit, body_bytes: size }) {
  const body = readBody(size), whole = { ...unit, body }
  const first = await applyRules(whole, lookup(whole), { tier: 1, budget: byteBudget() })
  const result = first.escalate ? await applyRules(whole, first.survivors, { tier: 2, full: watched, script }) : first
  return answerOf(id, result, HEAD_BYTES + (size ?? 0))
}

// Measured here so that the parent's main thread never parses a large message, or one that cannot be made at all.
function frameOf(answer) {
  try {
    const frame = encodeFrame(answer)
    if (frame.length - 4 <= ANSWER_BYTES) return frame
  } catch { /* a cycle, or a BigInt */ }
  return encodeFrame({ id: answer.id, why: 'rule-error' })
}

async function runTask(task) {
  printed = ''
  spent = new Map()
  progress = { task: task.id, rule: NO_RULE, slowest: NO_RULE, done: false }
  writeProgress(slot, progress)
  arm(maxTaskMs)
  let answer
  try { answer = { ...await work(task), console: consoleText() } } catch (e) { answer = { id: task.id, why: e.why ?? 'rule-error' } }
  const frame = frameOf(answer)
  progress.done = true
  writeProgress(slot, progress)
  setClock(0n)
  return frame
}

// Not a net.Socket on a file descriptor: a newer permission model counts that as network, and the built-in process has none. Not fs streams either: a read parked on the thread pool
// holds process.exit back.
const send = (frame) => { for (let at = 0; at < frame.length;) at += fs.writeSync(3, frame, at) }
const quit = () => process.exit(0)
let last = Promise.resolve()
process.stdin.on('data', frameReader((message) => {
  last = last.then(async () => {
    send(message.load ? encodeFrame(await load(message.load)) : await runTask(message))
  })
}, quit))
process.stdin.once('close', quit)
process.stdin.once('error', quit)
