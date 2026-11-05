// runner.mjs (src/rules) — a rule process (RFC 5.1 §规则进程): the only place a rule's regex, JSON edit or script runs. `node --permission … runner.mjs <slot> <parent pid> [<script>]`, see
// launch.mjs. Frames come in on stdin and go out on fd 3. First frame `{load: {rules, max_delay_ms}}` → `{ready: true}`; each task `{id, unit, body_bytes}` with the body in the slot → one answer.
const { fileURLToPath } = await import('node:url')
const capMiB = process.execArgv.map((arg) => /^--max-old-space-size=(\d+)$/.exec(arg)?.[1]).find(Boolean)
const { permission } = process
// A Node that would quietly give more than the flags asked for gets no rules at all.
if (!permission || permission.has('child') || permission.has('fs.write', fileURLToPath(new URL('../..', import.meta.url))) || !capMiB) process.exit(78)

const [{ Buffer }, { once }, fs, net, { pathToFileURL }, util, threads, modules, os, { full, RuleFault }, { applyRules }, { byteBudget }, { LIMITS, SCRIPT_BUILTINS, SCRIPT_FORMATS }, { compileRules }, slots] = await Promise.all([
  import('node:buffer'), import('node:events'), import('node:fs'), import('node:net'), import('node:url'), import('node:util'), import('node:worker_threads'), import('node:module'), import('node:os'),
  import('./actions.mjs'), import('./apply.mjs'), import('./budget.mjs'), import('./closed.mjs'), import('./compile.mjs'), import('./slot.mjs'),
])
const { ANSWER_BYTES, DEATHS, editsSegment, encodeFrame, frameReader, HEAD_BYTES, NO_RULE, writeProgress } = slots

const MIB = 1024 * 1024
const NS_PER_MS = 1_000_000n
const NS_PER_S = 1e9
const CONSOLE_BYTES = 16 * 1024
const LOAD_REASON_CHARS = 1024
const SCRIPT_RESULT_KEYS = new Set(['body', 'headers'])
const KEPT_ENV = Object.freeze(['SYSTEMROOT', 'XDG_RUNTIME_DIR'])
const SOCKET = /^(TCP(Socket|Server)|Pipe(Server)?|TLS|UDP)Wrap$/

const [slotPath, parentPid, scriptPath] = process.argv.slice(2)
const capBytes = Number(capMiB) * MIB
const slot = fs.openSync(slotPath, 'r+')

const shared = new SharedArrayBuffer(48)
const deadline = new BigInt64Array(shared, 0, 1)
const wake = new Int32Array(shared, 8, 1)
const over = new Int32Array(shared, 12, 1) // an index into DEATHS, plus one
const beat = new Int32Array(shared, 16, 1)
const working = new BigInt64Array(shared, 24, 2) // the nanoseconds tasks have taken, and when the one running began
const tasks = new Int32Array(shared, 40, 1)
const setClock = (at) => {
  Atomics.store(deadline, 0, at)
  Atomics.add(wake, 0, 1)
  Atomics.notify(wake, 0)
}
// Kept here: `process` is not frozen, and a script that swaps these must not stop the clock or the memory check.
const { _kill: kill, getActiveResourcesInfo, memoryUsage, pid } = process, { bigint: clockNow } = process.hrtime
const arm = (ms) => setClock(clockNow() + BigInt(Math.max(0, Math.ceil(ms))) * NS_PER_MS)
// Node's own way out stops the watchdog and then waits for the thread pool, which a script can keep busy for hours. So this is the only way out. Native: a JS function overflows on entry
// with the stack nearly full, and C++ takes Node's way out after all.
const end = kill.bind(null, pid, 9)
const fixed = (on, name, value) => Object.defineProperty(on, name, { value, writable: false, configurable: false })

const watchdog = new threads.Worker(new URL('./watchdog.mjs', import.meta.url), { workerData: { shared, fd: slot, slotPath, capBytes, ppid: Number(parentPid) } })
watchdog.once('exit', end)
await once(watchdog, 'message') // in its loop, not just started: no rule runs unwatched, and a script that takes every fd stops a thread still loading its modules

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
for (const name of ['kill', '_kill', '_debugProcess', '_debugEnd', '_tickCallback', 'getBuiltinModule']) delete process[name]
fixed(process, 'reallyExit', end)
fixed(process, '_fatalException', end)
// Windows hands every child PATH, USERNAME and the like whatever env it was given. SYSTEMROOT stays: sockets do not load without it.
for (const name of Object.keys(process.env)) if (!KEPT_ENV.includes(name.toUpperCase())) delete process.env[name]
os.default.setPriority = function refused() { throw new Error('a rule process has no say over other processes') }
modules.syncBuiltinESMExports()
// The flag freezes what the language brings. Buffer is Node's, and this code reports through it.
Object.freeze(Buffer.prototype)
Object.freeze(Buffer)

// RSS misses pages macOS compressed and Windows trimmed, and a leak of sockets is ports nobody else on the machine can have. A stuck main thread stops this tick, and the beat says so.
// A socket that is closed holds its port for a while yet, and one that is unref'd is in no count, so what takes a port is counted on the handle, where every way of asking ends up. A bind to
// a path is a file the permission model never sees, on a name trocar may be about to need.
const tell = (why) => {
  Atomics.store(over, 0, DEATHS.indexOf(why) + 1) // the watchdog kills: this thread no longer can
  Atomics.add(wake, 0, 1)
  Atomics.notify(wake, 0)
}
let opened = 0, openedAt = clockNow()
const open = () => {
  const now = clockNow()
  opened = Math.max(0, opened - Number(now - openedAt) / NS_PER_S * LIMITS.scriptConnectsPerSecond) + 1
  openedAt = now
  if (opened > LIMITS.scriptConnects) tell('handles')
}
const unconnected = new net.Socket().on('error', () => {}).connect(1, '127.0.0.1') // destroyed before it dials: all this wants is the kind of handle a socket has
const tcp = Object.getPrototypeOf(unconnected._handle), pipe = Object.getPrototypeOf(process.stdin._handle)
const wrap = Object.getPrototypeOf(Object.getPrototypeOf(tcp))
unconnected.destroy()
for (const name of ['connect', 'connect6', 'bind', 'bind6']) {
  const real = tcp[name]
  tcp[name] = function counted(...args) { open(); return real.apply(this, args) }
}
pipe.bind = function refused() { throw new Error('a rule process binds no path') }
wrap.unref = function counts() {}
for (const prototype of [tcp, pipe, wrap]) Object.freeze(prototype)
// The watchdog's message and not a timer: a script can walk Node's timer lists to a timer of this length and call it, or clear it.
watchdog.on('message', () => {
  Atomics.add(beat, 0, 1)
  const { heapUsed, external, arrayBuffers } = memoryUsage()
  if (heapUsed + Math.max(external, arrayBuffers) > capBytes) tell('memory') // a Buffer is in both
  if (getActiveResourcesInfo().filter((name) => SOCKET.test(name)).length > LIMITS.scriptSockets) tell('handles')
})

let printed = ''
const print = (...args) => { printed = `${printed}${util.format(...args)}\n`.slice(0, CONSOLE_BYTES) }
globalThis.console = Object.fromEntries(Object.keys(console).map((name) => [name, print]))
// The flag freezes objects, not the names they go by, and not Atomics. The clock and the beat look these names up on each call, so a new Math is a limit thirty years off.
Object.freeze(Atomics)
for (const [name, held] of Object.entries(Object.getOwnPropertyDescriptors(globalThis))) if ('value' in held) fixed(globalThis, name, held.value)

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
  if (segment.length > LIMITS.editsBytes) throw new RuleFault('edits-full')
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

// What the watchdog gives work its CPU allowance by.
async function timed(work) {
  const started = clockNow()
  Atomics.store(working, 1, started)
  try { return await work() } finally {
    Atomics.add(working, 0, clockNow() - started)
    Atomics.store(working, 1, 0n)
    Atomics.add(tasks, 0, 1)
  }
}

// Not a net.Socket on a file descriptor: a newer permission model counts that as network, and the built-in process has none. Not fs streams either: a read parked on the thread pool
// queues behind whatever a script keeps the pool busy with.
const send = (frame) => { for (let at = 0; at < frame.length;) at += fs.writeSync(3, frame, at) }
let last = Promise.resolve(), loaded = false
process.stdin.on('data', frameReader((message) => {
  last = last.then(async () => {
    if (message.load && loaded) return // a script can emit on stdin, and a limit it chose is none
    loaded ||= Boolean(message.load)
    send(await timed(() => (message.load ? load(message.load).then(encodeFrame) : runTask(message))))
  })
}, end))
process.stdin.once('close', end)
process.stdin.once('error', end)
