// runner.mjs (src/rules) — a rule process (RFC 5.1 §规则进程): the only place a rule's regex, JSON edit or script runs. `node --permission … runner.mjs <slot> [<script>]`, see
// launch.mjs. Channel on fd 3. First frame `{load: {rules, max_delay_ms}}` → `{ready: true}`; each task `{id, unit, body_bytes}` with the body in the slot → one answer.
const { fileURLToPath } = await import('node:url')
const capMiB = process.execArgv.map((arg) => /^--max-old-space-size=(\d+)$/.exec(arg)?.[1]).find(Boolean)
const { permission } = process
// A Node that would quietly give more than the flags asked for gets no rules at all.
if (!permission || permission.has('child') || permission.has('fs.write', fileURLToPath(new URL('../..', import.meta.url))) || !capMiB) process.exit(78)

const [{ Buffer }, { once }, fs, net, { pathToFileURL }, util, { Worker }, { full, RuleFault }, { applyRules }, { byteBudget }, { LIMITS }, { compileRules }, slots] = await Promise.all([
  import('node:buffer'), import('node:events'), import('node:fs'), import('node:net'), import('node:url'), import('node:util'), import('node:worker_threads'),
  import('./actions.mjs'), import('./apply.mjs'), import('./budget.mjs'), import('./closed.mjs'), import('./compile.mjs'), import('./slot.mjs'),
])
const { ANSWER_BYTES, die, editsSegment, encodeFrame, frameReader, HEAD_BYTES, NO_RULE, writeProgress } = slots

const MIB = 1024 * 1024
const NS_PER_MS = 1_000_000n
const CONSOLE_BYTES = 16 * 1024
const LOAD_REASON_CHARS = 1024
const SCRIPT_RESULT_KEYS = new Set(['body', 'headers'])

const [slotPath, scriptPath] = process.argv.slice(2)
const capBytes = Number(capMiB) * MIB
const slot = fs.openSync(slotPath, 'r+')

const shared = new SharedArrayBuffer(16)
const deadline = new BigInt64Array(shared, 0, 1)
const wake = new Int32Array(shared, 8, 1)
const setClock = (at) => {
  Atomics.store(deadline, 0, at)
  Atomics.add(wake, 0, 1)
  Atomics.notify(wake, 0)
}
const arm = (ms) => setClock(process.hrtime.bigint() + BigInt(Math.max(0, Math.ceil(ms))) * NS_PER_MS)

const watchdog = new Worker(new URL('./watchdog.mjs', import.meta.url), { workerData: { shared, fd: slot, capBytes, ppid: process.ppid } })
watchdog.once('exit', () => process.exit(1)) // no rule runs unwatched
await once(watchdog, 'online')

// RSS misses pages macOS compressed and Windows trimmed. A stuck main thread stops this one, but then what it allocates is in the RSS.
setInterval(() => {
  const { heapUsed, external, arrayBuffers } = process.memoryUsage()
  if (heapUsed + external + arrayBuffers > capBytes) die(slot, 'memory')
}, 1000).unref()

let printed = ''
const print = (...args) => { printed = `${printed}${util.format(...args)}\n`.slice(0, CONSOLE_BYTES) }
for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = print

// The permission model has no say over signals, and a script holds the agent's pid. This stops the plain call on this thread; a thread the script starts has a `process` of its own.
const { pid: self, _kill: signal } = process
process._kill = (target, name) => {
  if (target !== self) throw new Error('a rule process signals nothing but itself')
  return signal.call(process, target, name)
}
// Counted as the frame carries it: 16 KiB of control characters is 96 KiB of escapes.
function consoleText() {
  let text = printed
  while (Buffer.byteLength(JSON.stringify(text)) > CONSOLE_BYTES) text = text.slice(0, Math.floor(text.length * 3 / 4))
  return text
}

let progress = { task: 0, rule: NO_RULE, slowest: NO_RULE, done: false }
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
  if (typeof result !== 'object' || Object.keys(result).some((key) => !SCRIPT_RESULT_KEYS.has(key))) throw new RuleFault('bad-result')
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

// `recover`'s bulk stays out of the frame: its edits are the edits segment, its inline body the bytes the parent holds.
function answerOf(id, { escalate, survivors, bytes, edits, recover, ...rest }, end) {
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

const channel = new net.Socket({ fd: 3, readable: true, writable: true })
const quit = () => process.exit(0)
let last = Promise.resolve()
channel.on('data', frameReader((message) => {
  last = last.then(async () => {
    channel.write(message.load ? encodeFrame(await load(message.load)) : await runTask(message))
  })
}, quit))
channel.once('close', quit)
channel.once('error', quit)
