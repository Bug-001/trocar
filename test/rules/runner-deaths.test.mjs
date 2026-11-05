// 12e, one-shot half: every way a script can end its process or try to leave it (spec 5.1 §规则进程, §隔离, 验收 12e). A real process per row, a table per axis.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers/tmp.mjs';
import { LIMITS, SKIP_WHY } from '../../src/rules/closed.mjs';
import { memoryCap, openOneShot, runnerArgs } from '../../src/rules/launch.mjs';
import { DEATHS, encodeFrame, HEAD_BYTES, readProgress } from '../../src/rules/slot.mjs';

const MIB = 1024 * 1024;
const WIN = process.platform === 'win32';
const CLOSED = new Set([...SKIP_WHY, ...DEATHS]);
const isGone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
};
const until = async (holds, ms) => {
  const end = Date.now() + ms;
  while (!holds() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return holds();
};
const unit = (text = '{}') => ({ on: 'request', harness: 'codex', pid: 42, method: 'POST', host: 'api.example.com', path: '/v1/messages', class: 'llm', status: null, event_index: null, headers: [['content-length', '2']], req_headers: [], encoding: null, body: Buffer.from(text) });
const whyOf = (answer) => answer.died ?? answer.why ?? answer.skipped?.[0]?.why;

const HOLD = 'await new Promise((r) => setTimeout(r, 1000))';
// `body` runs inside the script once the file `die` exists; `top` at the top of the module.
const ROWS = [
  { name: 'an endless loop', why: 'timeout', body: 'for (;;);', maxTaskMs: 300 },
  { name: 'a task that never settles', why: 'timeout', body: 'await new Promise(() => {})', maxTaskMs: 300 },
  { name: 'an exception', why: 'rule-error', body: 'throw new Error("boom")' },
  { name: 'an exception that forges its why', why: 'rule-error', body: 'throw { why: "made-up" }' },
  { name: 'an unhandled rejection', why: 'crashed', body: 'Promise.reject(new Error("boom")); await new Promise((r) => setTimeout(r, 1000))' },
  { name: 'process.exit()', why: 'crashed', body: 'process.exit()' },
  { name: 'process.exit(78)', why: 'crashed', body: 'process.exit(78)' },
  { name: 'process.abort()', why: 'crashed', body: 'process.abort()' },
  { name: 'frozen from outside, watchdog and all', why: 'timeout', body: 'return "late"', freeze: true, maxTaskMs: 300, posix: 'Windows has no SIGSTOP' },
  { name: 'abort in a top-level setTimeout', why: 'crashed', top: 'const tick = () => (armed() ? process.abort() : setTimeout(tick, 10)); setTimeout(tick, 10)', body: 'await new Promise((r) => setTimeout(r, 1500))' },
  { name: 'a throw in a setInterval', why: 'crashed', top: 'setInterval(() => { if (armed()) throw new Error("boom") }, 10)', body: 'await new Promise((r) => setTimeout(r, 1500))' },
  { name: 'process.dlopen', why: 'rule-error', body: 'try { process.dlopen({ exports: {} }, fileURLToPath(new URL("./addon.node", import.meta.url))) } catch (e) { if (e.code === "ERR_DLOPEN_FAILED") return "the loader was reached"; throw e }' },
  { name: 'a CRLF in a header', why: 'rule-error', body: 'return { headers: { "x-a": "1\\r\\nx-b: 2" } }' },
  { name: 'a header over the growth limit', why: 'rule-error', body: 'return { headers: { "x-a": "v".repeat(16384) } }' },
  { name: 'a header trocar owns', why: 'rule-error', body: 'return { headers: { "Content-Length": "1" } }' },
  { name: 'a body past 64 MiB', why: 'too-big', body: 'return "x".repeat(65 * 1024 * 1024)' },
  ...['new ArrayBuffer(4)', 'new Map([["body", "x"]])', 'new Date()', '[]'].map((value) => ({ name: `a result that says nothing: ${value}`, why: 'bad-result', body: `return ${value}` })),
  { name: 'memory behind a stopped gauge', why: 'memory', top: 'process.memoryUsage = () => ({ heapUsed: 0, external: 0, arrayBuffers: 0 })', body: 'const keep = []; for (;;) { keep.push(Buffer.allocUnsafeSlow(32 << 20)); await new Promise((r) => setTimeout(r, 20)) }', capBytes: 192 * MIB, maxTaskMs: 30000 },
  {
    name: 'a leak of sockets that says they do not count', why: 'handles', maxTaskMs: 8000, top: 'import net from "node:net"; import { once } from "node:events"',
    body: `const server = net.createServer((socket) => socket.on("error", () => {}).unref()).listen(0, "127.0.0.1"); server.unref(); await once(server, "listening");
      for (let i = 0; i < ${LIMITS.scriptSockets + 10}; i++) await once(net.connect(server.address().port, "127.0.0.1").unref(), "connect"); // one at a time: a burst overruns the backlog
      await new Promise(() => {})`,
  },
  {
    name: 'a leak of sockets unref\'d on their handles, past whatever stands in the way', why: 'handles', maxTaskMs: 8000, top: 'import net from "node:net"; import { once } from "node:events"',
    body: `const server = net.createServer((socket) => socket.on("error", () => {})).listen(0, "127.0.0.1"); await once(server, "listening");
      for (let i = 0; i < ${LIMITS.scriptSockets + 10}; i++) {
        const socket = net.connect(server.address().port, "127.0.0.1"); await once(socket, "connect");
        for (let on = Object.getPrototypeOf(socket._handle); on; on = Object.getPrototypeOf(on)) try { delete on.unref } catch {}
        socket._handle.unref()
      }
      await new Promise(() => {})`,
  },
  {
    name: 'a leak of listeners that says they do not count', why: 'handles', maxTaskMs: 8000, top: 'import net from "node:net"; import { once } from "node:events"',
    body: `for (let i = 0; i < ${LIMITS.scriptSockets + 10}; i++) await once(net.createServer().listen(0, "127.0.0.1").unref(), "listening"); await new Promise(() => {})`,
  },
  {
    name: 'an edits segment too big to parse', why: 'bad-result',
    body: `const bytes = ${Math.ceil(LIMITS.editsBytes / 3) * 3 + 2}, slot = fs.openSync(process.argv[2], 'r+')
      fs.writeSync(slot, Buffer.alloc(bytes, '{},'), 0, bytes, ${HEAD_BYTES})
      say({ id: taskId(), verdict: 'forward', edits: { at: ${HEAD_BYTES}, bytes } }); ${HOLD}`,
  },
  { name: 'a leak of file descriptors', why: 'handles', maxTaskMs: 8000, body: `try { for (let i = 0; i <= ${LIMITS.scriptFds}; i++) fs.openSync(process.argv[2], "r") } catch {}; await new Promise(() => {})` },
  {
    name: 'connections opened and closed faster than ports come back', why: 'handles', maxTaskMs: 8000, top: 'import net from "node:net"; import { once } from "node:events"',
    body: `const server = net.createServer((socket) => socket.on("error", () => {}).destroy()).listen(0, "127.0.0.1"); await once(server, "listening");
      for (let i = 0; i < ${LIMITS.scriptConnects + 100}; i++) await new Promise((done) => net.connect(server.address().port, "127.0.0.1").on("error", () => {}).once("close", done).resume());
      await new Promise(() => {})`,
  },
  {
    name: 'a load the script wrote itself', why: 'timeout', body: 'for (;;);', maxTaskMs: 300,
    top: 'const made = Buffer.from(JSON.stringify({ load: { rules: [], max_delay_ms: 9e12 } })), size = Buffer.alloc(4); size.writeUInt32LE(made.length); process.stdin.emit("data", Buffer.concat([size, made]))',
  },
  { name: 'a slot grown past its limit', why: 'memory', body: 'fs.ftruncateSync(fs.openSync(process.argv[2], "r+"), 2 ** 29); await new Promise(() => {})', maxTaskMs: 8000 },
  { name: 'a cycle', why: 'bad-result', body: 'const o = {}; o.self = o; return o' },
  { name: 'a cycle in the body key', why: 'bad-result', body: 'const o = {}; o.body = o; return o' },
  { name: 'memory past the limit', why: 'memory', body: 'const keep = []; for (;;) keep.push(Buffer.alloc(8 << 20, 1))', capBytes: 192 * MIB, maxTaskMs: 30000 },
  { name: 'memory reserved but never touched', why: 'memory', body: 'const keep = []; for (;;) { keep.push(Buffer.allocUnsafeSlow(32 << 20)); await new Promise((r) => setTimeout(r, 20)) }', capBytes: 192 * MIB, maxTaskMs: 30000 },
  { name: 'a signal to its parent', why: 'rule-error', body: 'process.kill(process.ppid, 0)' },
  { name: 'a signal to its process group', why: 'rule-error', body: 'process.kill(0, 0)' },
  { name: 'a frame over 64 KiB on the channel', why: 'bad-result', body: `fs.writeSync(3, Buffer.from([1, 0, 1, 0])); ${HOLD}` },
  { name: 'bytes that are no frame on the channel', why: 'bad-result', body: `fs.writeSync(3, Buffer.from([2, 0, 0, 0, 0x7b, 0x7b])); ${HOLD}` },
  ...['{}', 'null', '7', '"text"', '[]'].map((json) => ({ name: `the frame ${json} on the channel`, why: 'bad-result', body: `say(${json}); ${HOLD}` })),
  // A frame with the task's own id, so nothing but the parent's reading of it stands in the way.
  ...Object.entries({
    'a body past the end of the slot': '{ body: { at: 1e9, bytes: 5 } }',
    'a CRLF in a header': '{ headers: [["content-length", "2"], ["x-evil", "a\\r\\nset-cookie: 1"]] }',
    'a header name that is no token': '{ headers: [["content-length", "2"], ["x y", "1"]] }',
    'a new value for a header trocar owns': '{ headers: [["content-length", "0"]] }',
    'a header trocar owns gone': '{ headers: [] }',
    'a header with no value': '{ headers: [["content-length", "2"], ["x-a", null]] }',
    'headers that are no list': '{ headers: 7 }',
    'headers past the growth limit': '{ headers: [["content-length", "2"], ["x-a", "v".repeat(9000)]] }',
    'a reply from an action that has none': '{ reply_at: [0, 0] }',
    'a reply from a place that is no rule': '{ reply_at: [9, 9] }',
    'a drop no rule wrote': '{ verdict: "drop", hits: ["script"] }',
    'a hold no rule wrote': '{ verdict: "hold", hits: ["script"] }',
    'a reply with nothing to say': '{ verdict: "reply", hits: ["script"] }',
    'an injected event from an action that has none': '{ inject_at: [[0, 0]] }',
    'a why outside the closed set': '{ why: "made-up" }',
    'a skip outside the closed set': '{ skipped: [{ rule: "x", why: "made-up" }] }',
    'a death of its own': '{ died: "made-up" }',
    'a would that says nothing': '{ verdict: "forward", would: [null] }',
    'a rule time that is no number': '{ verdict: "forward", rule_ms: { script: "x" } }',
  }).map(([what, fields]) => ({ name: `a frame with its task's id and ${what}`, why: 'bad-result', body: `say({ id: taskId(), ...${fields} }); ${HOLD}` })),
];

function moduleOf({ top = '', body }, dir) {
  return `
    import fs from 'node:fs'
    import { fileURLToPath } from 'node:url'
    const armed = () => fs.existsSync(new URL('./die', import.meta.url))
    const say = (message) => {
      const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4)
      head.writeUInt32LE(body.length)
      fs.writeSync(3, Buffer.concat([head, body]))
    }
    const taskId = () => fs.readFileSync(process.argv[2]).readUInt32LE(0)
    ${top}
    export default async () => {
      if (!armed()) return String(process.pid)
      ${body}
    }`;
}

// Rows run side by side: most of the time here is a process starting or a limit running out.
describe('12e: what a script does to its process', { concurrency: 8 }, () => {
  for (const row of ROWS) {
    test(row.name, { skip: WIN && row.posix ? row.posix : false }, async () => {
      const dir = tmpDir('trocar-death-'), script = path.join(dir, 'script.mjs');
      fs.writeFileSync(script, moduleOf(row, dir));
      const runner = openOneShot({
        script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }],
        ...(row.maxTaskMs ? { maxTaskMs: row.maxTaskMs } : {}), ...(row.capBytes ? { capBytes: row.capBytes } : {}),
      });
      let pid;
      try {
        const first = await runner.run(unit());
        pid = Number(first.bytes);
        assert.ok(pid > 0, 'a healthy script answers first');

        fs.writeFileSync(path.join(dir, 'die'), '');
        if (row.freeze) process.kill(pid, 'SIGSTOP');
        const answer = await runner.run(unit());
        assert.equal(whyOf(answer), row.why);
        assert.ok(CLOSED.has(whyOf(answer)));

        // At once: a process on its way out must not take the next unit with it.
        fs.rmSync(path.join(dir, 'die'));
        const next = await runner.run(unit());
        assert.ok(Number(next.bytes) > 0, 'the next unit gets an answer');
        if (answer.died) assert.ok(await until(() => isGone(pid), 2000), 'the process is gone');
      } finally { await runner.close(); }
      assert.ok(await until(() => isGone(pid), 2000));
    });
  }
});

// However the two frames fall across the parent's reads, the process goes, and no later unit lands on it.
for (const [name, gap] of [['at once', ''], ['a moment apart', 'await new Promise((r) => setTimeout(r, 100))']]) {
  test(`a question answered twice, ${name}, takes the process with it`, async () => {
    const dir = tmpDir('trocar-twice-'), script = path.join(dir, 'script.mjs');
    fs.writeFileSync(script, moduleOf({ body: `say({ id: taskId() }); ${gap}; return "late"` }, dir));
    const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
    try {
      const pid = Number((await runner.run(unit())).bytes);
      fs.writeFileSync(path.join(dir, 'die'), '');
      await runner.run(unit());
      assert.ok(await until(() => isGone(pid), 2000), 'the process is gone');
      fs.rmSync(path.join(dir, 'die'));
      const next = Number((await runner.run(unit())).bytes);
      assert.ok(next > 0 && next !== pid);
    } finally { await runner.close(); }
  });
}

describe('a load that fails is load-failed, and every run after it gets the same answer from no new process', { concurrency: 4 }, () => {
  const scripts = [
    ['a throw at the top of the script', 'throw new Error("boom")'],
    ['a script with no default export', 'export const x = 1'],
    ['a script that is not JavaScript', '{{{'],
    ['process.exit at the top of the script', 'process.exit(0)'],
    ['an import outside its directory', 'import "../outside.mjs"'],
    ['a load that never ends', 'for (;;);'],
  ];
  for (const [name, source] of scripts) {
    test(name, async () => {
      const dir = path.join(tmpDir('trocar-load-'), 'inner'), script = path.join(dir, 'script.mjs');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '..', 'outside.mjs'), '');
      fs.writeFileSync(script, source);
      const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
      try {
        const failed = await runner.run(unit());
        assert.equal(failed.died, 'load-failed');
        fs.writeFileSync(script, 'export default () => "ok"'); // a new process would load this
        assert.deepEqual(await runner.run(unit()), failed);
      } finally { await runner.close(); }
    });
  }
  test('a regex that does not compile', async () => {
    const runner = openOneShot({ rules: [{ name: 'bad', on_error: 'forward', match: { harness: 'any', body: { re: '(' } }, do: [{ drop: true }] }] });
    try { assert.equal((await runner.run(unit())).died, 'load-failed'); } finally { await runner.close(); }
  });
});

test('a timeout is the rule the progress names', async () => {
  const dir = tmpDir('trocar-blame-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, 'export default () => { for (;;); }');
  const rules = [
    { name: 'first', on_error: 'forward', match: { harness: 'any' }, do: [{ header: 'x-a', set: '1' }] },
    { name: 'second', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] },
  ];
  const runner = openOneShot({ script, rules, maxTaskMs: 300 });
  try {
    const answer = await runner.run(unit());
    assert.deepEqual([answer.died, answer.rule], ['timeout', 1]);
  } finally { await runner.close(); }
});

// Straight on the channel: the one-shot client's own timer would hide a watchdog that never fired.
const SPY = `const { store, add, notify } = Atomics
  let held = null
  const spy = (a, ...rest) => { if (a instanceof BigInt64Array) held = a; return store(a, ...rest) }
`;
const BLIND = 'for (;;) if (held) { store(held, 0, 0n); add(new Int32Array(held.buffer, 16, 1), 0, 1) }';
for (const [how, top, run = 'for (;;);'] of [
  ['by itself', ''],
  ['with the clock swapped under it', 'process.hrtime.bigint = () => 1n << 61n\n'],
  ['with Math rebound', 'try { globalThis.Math = { max: () => 1e12, ceil: (x) => x, min: (a) => a, floor: (x) => x } } catch {}\n'],
  ['with BigInt rebound', 'try { globalThis.BigInt = () => 1n << 61n } catch {}\n'],
  ['with Atomics rebound to get at the shared memory', `${SPY}try { globalThis.Atomics = { store: spy, add, notify } } catch {}\n`, BLIND],
  ['with Atomics changed in place to get at the shared memory', `${SPY}try { Atomics.store = spy } catch {}\n`, BLIND],
]) test(`the watchdog kills a task at its limit ${how}, and the slot says why and who`, { timeout: 10000 }, async (t) => {
  const dir = tmpDir('trocar-watchdog-'), script = path.join(dir, 'script.mjs'), slot = path.join(dir, 'slot');
  fs.writeFileSync(script, `${top}export default () => { ${run} }`);
  fs.writeFileSync(slot, '');
  const child = spawn(process.execPath, runnerArgs({ script, slot, capBytes: memoryCap() }), { stdio: ['pipe', 'ignore', 'ignore', 'pipe'], env: {} });
  t.after(() => child.kill('SIGKILL'));
  const late = setTimeout(() => child.kill('SIGKILL'), 3000); // a red row ends too
  t.after(() => clearTimeout(late));
  child.stdio[3].on('error', () => {});
  child.stdin.write(encodeFrame({ load: { rules: [{ name: 's', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }], max_delay_ms: 200 } }));
  child.stdio[3].once('data', () => child.stdin.write(encodeFrame({ id: 7, unit: unit(), body_bytes: null })));
  const signal = await new Promise((resolve) => { child.once('close', (_, killedBy) => resolve(killedBy)); });
  const fd = fs.openSync(slot, 'r');
  t.after(() => fs.closeSync(fd));
  assert.equal(signal, WIN ? null : 'SIGKILL'); // Windows reports an exit code, there being no signals
  assert.deepEqual([readProgress(fd).task, readProgress(fd).rule, readProgress(fd).done, readProgress(fd).death], [7, 0, false, 'timeout']);
});

const STUCK = 'export default (m) => { if (m.text === "pid") return String(process.pid); for (;;); }';

/** A rule process stuck on a task, under a parent of its own to kill. Nothing else ends the process if a row is red: it is no child of this one, and it would spin on after the run. */
async function stuckUnderParent(t, source, fds) {
  const dir = tmpDir('trocar-orphan-'), script = path.join(dir, 'script.mjs'), parent = path.join(dir, 'parent.mjs');
  const launch = new URL('../../src/rules/launch.mjs', import.meta.url).href;
  fs.writeFileSync(script, source);
  fs.writeFileSync(parent, `
    import { openOneShot } from ${JSON.stringify(launch)}
    const script = ${JSON.stringify(script)}
    const unit = (text) => ({ on: 'request', harness: 'codex', method: 'POST', host: 'h', path: '/', headers: [], req_headers: [], body: Buffer.from(text) })
    const runner = openOneShot({ script, tmp: ${JSON.stringify(dir)}, rules: [{ name: 's', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }], maxTaskMs: 60000 })
    process.stdout.write(String((await runner.run(unit('pid'))).bytes) + '\\n')
    runner.run(unit('stick'))
    setInterval(() => {}, 1000)`);
  const io = { stdio: ['ignore', 'pipe', 'inherit'] };
  const middle = fds ? spawn('/bin/sh', ['-c', `ulimit -n ${fds}; exec "$0" "$@"`, process.execPath, parent], io) : spawn(process.execPath, [parent], io);
  t.after(() => middle.kill('SIGKILL'));
  const pid = await new Promise((resolve) => { middle.stdout.once('data', (d) => resolve(Number(d))); });
  assert.ok(pid > 0);
  t.after(() => { if (!isGone(pid)) process.kill(pid, 'SIGKILL'); });
  await new Promise((r) => setTimeout(r, 100));
  return { dir, middle, pid };
}

for (const [name, source] of [
  ['stuck in a loop', STUCK],
  ['idle', 'export default (m) => (m.text === "pid" ? String(process.pid) : undefined)'],
  ['stuck in a loop with its slot closed', `
    import fs from 'node:fs'
    export default (m) => {
      if (m.text === "pid") return String(process.pid)
      const { ino } = fs.statSync(process.argv[2])
      for (let fd = 4; fd < 256; fd++) { try { if (fs.fstatSync(fd).ino === ino) fs.closeSync(fd) } catch {} }
      for (;;);
    }`],
]) {
  test(`a parent killed outright takes the rule process with it within two seconds, ${name}`, async (t) => {
    const { middle, pid } = await stuckUnderParent(t, source);
    assert.ok(!isGone(pid));
    middle.kill('SIGKILL');
    assert.ok(await until(() => isGone(pid), 2000), 'the rule process outlived its parent');
  });
}

// Nobody takes over from a watchdog thread that ends, and the main thread that would hear of it is in the script's loop. The parent stays alive here: Windows would end the process with it either way.
test('a rule process does not outlive a watchdog that cannot cut its slot down', async (t) => {
  const { dir, pid } = await stuckUnderParent(t, STUCK);
  const slots = path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('trocar-slot-')));
  const slot = path.join(slots, fs.readdirSync(slots)[0]), fd = fs.openSync(slot, 'r+');
  fs.chmodSync(slot, 0o400);
  t.after(() => fs.chmodSync(slot, 0o600));
  fs.ftruncateSync(fd, 5 * LIMITS.bodyBytes);
  fs.closeSync(fd);
  assert.ok(await until(() => isGone(pid), 2000), 'the rule process outlived its watchdog');
});

// Linux reads the RSS through a file, so there the thread fails first. Elsewhere the parent check ends it. Either way it goes.
test('a rule process does not outlive a parent and a script that takes every file descriptor', { skip: WIN && 'no fd limit to reach this way' }, async (t) => {
  const { middle, pid } = await stuckUnderParent(t, `
    import fs from 'node:fs'
    export default (m) => {
      if (m.text === "pid") return String(process.pid)
      try { for (;;) fs.openSync(process.argv[2], 'r') } catch {}
      for (;;);
    }`, 256);
  middle.kill('SIGKILL');
  assert.ok(await until(() => isGone(pid), 2000), 'the rule process outlived its watchdog');
});

// Node's exit stops the watchdog first and then waits for the thread pool: hours of CPU with nobody watching, whatever the way out.
const POOL = 'for (let i = 0; i < 8; i++) crypto.pbkdf2("a", "b", 2 ** 31 - 1, 64, "sha512", () => {})';
for (const [name, ending] of [
  ['process.exit()', 'process.exit()'],
  ['a throw in a timer', 'setTimeout(() => { throw new Error("boom") }, 10)'],
  ['an unhandled rejection', 'Promise.reject(new Error("boom"))'],
  ['a handler that throws', 'process.on("uncaughtException", () => { throw new Error("again") }); setTimeout(() => { throw new Error("boom") }, 10)'],
  ['a handler that swallows it', 'process.on("uncaughtException", () => {}); setTimeout(() => { throw new Error("boom") }, 10)'],
  ['with no handler for it left', 'try { process._fatalException = 0 } catch {}; setTimeout(() => { throw new Error("boom") }, 10)'],
]) {
  test(`a rule process leaves at once with its thread pool busy, ${name}`, async (t) => {
    const { pid } = await stuckUnderParent(t, `
      import crypto from 'node:crypto'
      export default (m) => {
        if (m.text === "pid") return String(process.pid)
        ${POOL}
        ${ending}
        return new Promise(() => {})
      }`);
    assert.ok(await until(() => isGone(pid), 2000), 'the rule process is still there');
  });
}

for (const [name, after] of [['unlinked', ''], ['unlinked and made again', 'fs.closeSync(fs.openSync(process.argv[2], "wx"))']]) {
  test(`a rule process does not outlive its slot, ${name}`, async (t) => {
    const { pid } = await stuckUnderParent(t, `
      import fs from 'node:fs'
      export default (m) => {
        if (m.text === "pid") return String(process.pid)
        fs.unlinkSync(process.argv[2])
        ${after}
        return new Promise(() => {})
      }`);
    assert.ok(await until(() => isGone(pid), 2000), 'the rule process is still there');
  });
}

// The tasks a script makes up itself must not earn it CPU, so they must not get out.
for (const [name, act] of [
  ['half a frame on the channel', 'fs.writeSync(3, Buffer.from([0, 0, 1, 0]))'],
  ['the channel swapped for its slot', 'fs.closeSync(3); fs.openSync(process.argv[2], "r+")'],
]) {
  test(`a rule process with no question out does not survive ${name}`, async (t) => {
    const dir = tmpDir('trocar-channel-'), script = path.join(dir, 'script.mjs');
    fs.writeFileSync(script, moduleOf({ top: `setInterval(() => { if (armed()) { ${act} } }, 20)`, body: '' }, dir));
    const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
    t.after(() => runner.close());
    const pid = Number((await runner.run(unit())).bytes);
    fs.writeFileSync(path.join(dir, 'die'), '');
    assert.ok(await until(() => isGone(pid), 2000), 'the rule process is still there');
  });
}

test('half a frame behind an answer is half a frame with no question out', async (t) => {
  const dir = tmpDir('trocar-channel-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, moduleOf({ body: `
    const body = Buffer.from(JSON.stringify({ id: taskId(), verdict: 'forward' })), head = Buffer.alloc(4)
    head.writeUInt32LE(body.length)
    fs.writeSync(3, Buffer.concat([head, body, Buffer.from([0, 0, 1, 0])]))
    await new Promise(() => {})` }, dir));
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
  t.after(() => runner.close());
  const pid = Number((await runner.run(unit())).bytes);
  fs.writeFileSync(path.join(dir, 'die'), '');
  await runner.run(unit());
  assert.ok(await until(() => isGone(pid), 2000), 'the rule process is still there');
});

for (const [name, ending, why] of [['a task it overran', 'for (;;);', 'timeout'], ['a crash', 'process.abort()', 'crashed'], ['a bad answer', 'say({ id: taskId(), verdict: "hold" }); await new Promise(() => {})', 'bad-result']]) {
  test(`a script process answers for its own death whatever its slot says: ${name}`, async () => {
    const dir = tmpDir('trocar-blame-'), script = path.join(dir, 'script.mjs');
    fs.writeFileSync(script, moduleOf({ body: `const slot = fs.openSync(process.argv[2], 'r+'), zero = Buffer.alloc(4); fs.writeSync(slot, zero, 0, 4, 4); ${ending}` }, dir));
    const runner = openOneShot({
      script, maxTaskMs: 300,
      rules: [{ name: 'guard', on_error: 'drop', match: { harness: 'any', host: 'no.example.com' }, do: [{ drop: true }] }, { name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }],
    });
    try {
      await runner.run(unit());
      fs.writeFileSync(path.join(dir, 'die'), '');
      assert.deepEqual(await runner.run(unit()), { died: why, rule: 1 });
    } finally { await runner.close(); }
  });
}

test('timers are not sockets: a cache of them lives', async () => {
  const dir = tmpDir('trocar-timers-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, 'export default () => { for (let i = 0; i < 2000; i++) setTimeout(() => {}, 600000); return String(process.pid) }');
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
  try {
    const pid = Number((await runner.run(unit())).bytes);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(Number((await runner.run(unit())).bytes), pid);
  } finally { await runner.close(); }
});

test('a process has no more open files than the limit, by the kernel\'s count', { skip: WIN && 'Windows has no such table' }, async (t) => {
  const dir = tmpDir('trocar-ulimit-'), node = path.join(dir, 'node'), seen = path.join(dir, 'seen'), real = process.execPath;
  fs.writeFileSync(node, `#!/bin/sh\nulimit -n > ${JSON.stringify(seen)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  process.execPath = node;
  t.after(() => { process.execPath = real; });
  const runner = openOneShot({ rules: [{ name: 'r', on_error: 'forward', match: { harness: 'any' }, do: [{ replace: 'a', with: 'b' }] }] });
  try { await runner.run(unit()); } finally { await runner.close(); }
  assert.equal(Number(fs.readFileSync(seen, 'utf8')), LIMITS.scriptFds);
});

test('edits up to the limit stay bytes for whoever reads them', async () => {
  const dir = tmpDir('trocar-segment-'), script = path.join(dir, 'script.mjs');
  const one = '{"at":0,"del":0,"ins":""},', bytes = Math.floor(LIMITS.editsBytes / one.length) * one.length - 1;
  fs.writeFileSync(script, moduleOf({ body: `
    const slot = fs.openSync(process.argv[2], 'r+')
    fs.writeSync(slot, Buffer.alloc(${bytes}, ${JSON.stringify(one)}), 0, ${bytes}, ${HEAD_BYTES})
    say({ id: taskId(), verdict: 'forward', edits: { at: ${HEAD_BYTES}, bytes: ${bytes} } }); ${HOLD}` }, dir));
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
  try {
    await runner.run(unit());
    fs.writeFileSync(path.join(dir, 'die'), '');
    const { edits } = await runner.run(unit());
    assert.ok(Buffer.isBuffer(edits));
    assert.equal(edits.length, bytes);
  } finally { await runner.close(); }
});

test('a script binds no path, however it asks', { skip: WIN && 'a named pipe is no file on disk' }, async () => {
  const dir = tmpDir('trocar-bind-'), script = path.join(dir, 'script.mjs'), bound = (n) => path.join(dir, `bound${n}`);
  fs.writeFileSync(script, `
    import http from 'node:http'
    import net from 'node:net'
    const quietly = (open) => { try { open().on('error', () => {}) } catch {} }
    export default async () => {
      quietly(() => net.createServer().listen(${JSON.stringify(bound(1))}))
      quietly(() => net.createServer().listen({ path: ${JSON.stringify(bound(2))} }))
      quietly(() => http.createServer().listen(${JSON.stringify(bound(3))}))
      try { net._createServerHandle(${JSON.stringify(bound(4))}, -1, -1) } catch {}
      await new Promise((r) => setTimeout(r, 100))
      return 'tried'
    }`);
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
  try { assert.equal(String((await runner.run(unit())).bytes), 'tried'); } finally { await runner.close(); }
  assert.deepEqual([1, 2, 3, 4].filter((n) => fs.existsSync(bound(n))), []);
});

for (const [name, places, check] of [
  ['once', '[[1, 0]]', (answer) => assert.deepEqual(answer.inject, ['data: x\n\n'])],
  ['twice', '[[1, 0], [1, 0]]', (answer) => assert.equal(answer.died, 'bad-result')],
]) {
  test(`what a frame says of an injected event, ${name}`, async () => {
    const dir = tmpDir('trocar-inject-'), script = path.join(dir, 'script.mjs');
    fs.writeFileSync(script, moduleOf({ body: `say({ id: taskId(), verdict: 'forward', hits: ['two'], inject_at: ${places} }); ${HOLD}` }, dir));
    const rule = (name, action) => ({ name, on: 'response', on_error: 'forward', match: { harness: 'any' }, do: [action] });
    const runner = openOneShot({ script, rules: [rule('one', { script }), rule('two', { inject: 'data: x\n\n' })] });
    const on = { ...unit(), on: 'response' };
    try {
      await runner.run(on);
      fs.writeFileSync(path.join(dir, 'die'), '');
      check(await runner.run(on));
    } finally { await runner.close(); }
  });
}

test('process has no _tickCallback to run microtasks with on a nearly full stack', async () => {
  const dir = tmpDir('trocar-tick-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, 'export default () => typeof process._tickCallback');
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
  try { assert.equal(String((await runner.run(unit())).bytes), 'undefined'); } finally { await runner.close(); }
});

test('Buffers within the cap are within it, counted once', async () => {
  const dir = tmpDir('trocar-buffers-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, `let held\nexport default () => { held ??= Buffer.alloc(${150 * MIB}, 1); return String(process.pid) }`);
  const runner = openOneShot({ script, capBytes: 256 * MIB, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
  try {
    const pid = Number((await runner.run(unit())).bytes);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(Number((await runner.run(unit())).bytes), pid);
  } finally { await runner.close(); }
});

test('more edits than a record holds is edits-full, not a bad answer', async () => {
  const runner = openOneShot({ rules: [{ name: 'r', on_error: 'forward', match: { harness: 'any' }, do: [{ replace: 'a', with: 'b' }] }] });
  try { assert.equal(whyOf(await runner.run({ ...unit(), body: Buffer.alloc(LIMITS.editsBytes / 16, 'a') })), 'edits-full'); } finally { await runner.close(); }
});

describe('CPU', () => {
  const BURNS = [['a timer that never lets up', 'setInterval(() => { const end = Date.now() + 900; while (Date.now() < end); }, 1)'], ['the thread pool', POOL]];
  const started = async (t, start) => {
    const dir = tmpDir('trocar-idle-cpu-'), script = path.join(dir, 'script.mjs');
    fs.writeFileSync(script, `import crypto from 'node:crypto'\nlet on = false\nexport default () => { if (!on) { on = true; ${start} } return String(process.pid) }`);
    const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
    t.after(() => runner.close());
    return { runner, pid: Number((await runner.run(unit())).bytes) };
  };
  // One at a time: side by side on two cores, none of them gets the share it is being tested for.
  for (const [name, start] of BURNS) {
    test(`with no task on it is ended: ${name}`, async (t) => {
      const { pid } = await started(t, start);
      assert.ok(await until(() => isGone(pid), 16000), 'nothing ended it');
    });
    test(`with a task every 500 ms is ended all the same: ${name}`, async (t) => {
      const { runner, pid } = await started(t, start);
      for (const end = Date.now() + 16000; !isGone(pid) && Date.now() < end;) {
        await runner.run(unit());
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(isGone(pid), 'nothing ended it');
    });
  }
  describe('leaves alone', { concurrency: 3 }, () => {
    for (const [name, start] of [
      ['a timer that takes a tenth of a core', 'setInterval(() => { const end = Date.now() + 50; while (Date.now() < end); }, 500)'],
      ['one burst of work', 'setTimeout(() => { const end = Date.now() + 2400; while (Date.now() < end); }, 3800)'],
    ]) {
      test(name, async (t) => {
        const { runner, pid } = await started(t, start);
        await new Promise((r) => setTimeout(r, 16000));
        assert.equal(Number((await runner.run(unit())).bytes), pid);
      });
    }
    test('a stream of short tasks, however fast', async (t) => {
      const { runner, pid } = await started(t, '');
      for (const end = Date.now() + 16000; Date.now() < end;) {
        const answer = await runner.run(unit());
        assert.equal(Number(answer.bytes), pid, JSON.stringify({ ...answer, bytes: undefined }));
      }
    });
  });
});

test('a script\'s process.exit(78) at the top is a failed load, not a Node that fails the check', async () => {
  const dir = tmpDir('trocar-78-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, 'process.exit(78)');
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }] });
  try { assert.equal((await runner.run(unit())).died, 'load-failed'); } finally { await runner.close(); }
});

test('40: no file descriptor left for a rule process is runner-down, and the caller lives', { skip: WIN && 'no fd limit to reach this way' }, async () => {
  const held = [];
  const dir = tmpDir('trocar-fds-'), file = path.join(dir, 'x');
  fs.writeFileSync(file, '');
  const runner = openOneShot({ rules: [{ name: 'r', on_error: 'forward', match: { harness: 'any' }, do: [{ replace: 'a', with: 'b' }] }] });
  try {
    try { for (;;) held.push(fs.openSync(file, 'r')); } catch (e) { assert.equal(e.code, 'EMFILE'); }
    assert.equal((await runner.run(unit())).died, 'runner-down');
  } finally {
    for (const fd of held) fs.closeSync(fd);
    await runner.close();
  }
});

test('after a task the clock is off: an idle process outlives the max delay and answers again', async () => {
  const dir = tmpDir('trocar-idle-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, 'export default () => String(process.pid)');
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }], maxTaskMs: 200 });
  try {
    const first = String((await runner.run(unit())).bytes);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(String((await runner.run(unit())).bytes), first);
  } finally { await runner.close(); }
});

test('a Node that cannot start the process at all is runner-down', async () => {
  const real = process.execPath;
  const runner = openOneShot({ rules: [{ name: 'r', on_error: 'forward', match: { harness: 'any' }, do: [{ replace: 'a', with: 'b' }] }] });
  process.execPath = path.join(tmpDir('trocar-nonode-'), 'node');
  try { assert.equal((await runner.run(unit())).died, 'runner-down'); } finally { process.execPath = real; await runner.close(); }
});

test('the channel closed is the end of the process, and a wrong parent is too', async () => {
  const dir = tmpDir('trocar-eof-'), slot = path.join(dir, 'slot');
  fs.writeFileSync(slot, '');
  const args = (parent) => { const list = runnerArgs({ slot, capBytes: memoryCap() }); list[list.length - 1] = String(parent); return list; };
  const exited = (child) => new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const eof = spawn(process.execPath, args(process.pid), { stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
  eof.stdin.end();
  await exited(eof);
  const orphan = spawn(process.execPath, args(1), { stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
  const { signal } = await exited(orphan);
  assert.equal(signal, WIN ? null : 'SIGKILL');
  assert.equal(readProgress(fs.openSync(slot, 'r')).death, 'parent');
});

test('a main thread stuck with no task on it is ended within seconds, and the next unit gets a new process', async () => {
  const dir = tmpDir('trocar-idle-stuck-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, 'export default () => { setTimeout(() => { for (;;); }, 50); return String(process.pid) }');
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }], maxTaskMs: 3000 });
  try {
    const pid = Number((await runner.run(unit())).bytes);
    assert.ok(await until(() => isGone(pid), 9000), 'nothing ended it');
    assert.notEqual(Number((await runner.run(unit())).bytes), pid);
  } finally { await runner.close(); }
});

test('close twice is one close, and a run after it touches nothing', async () => {
  const runner = openOneShot({ rules: [{ name: 'r', on_error: 'forward', match: { harness: 'any' }, do: [{ replace: 'a', with: 'b' }] }] });
  await runner.run(unit());
  await runner.close();
  await runner.close();
  assert.equal((await runner.run(unit())).died, 'closed');
});

test('a close while the process loads is closed, not a load that failed', async () => {
  const runner = openOneShot({ rules: [{ name: 'r', on_error: 'forward', match: { harness: 'any' }, do: [{ replace: 'a', with: 'b' }] }] });
  const running = runner.run(unit());
  await runner.close();
  assert.equal((await running).died, 'closed');
});

test('a parent too busy to read is no reason to kill a task that finished', async () => {
  const dir = tmpDir('trocar-busy-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(script, 'export default () => "done"');
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }], maxTaskMs: 1000 });
  try {
    await runner.run(unit());
    const pending = runner.run(unit());
    for (const until = Date.now() + 2500; Date.now() < until;); // the timer comes due with the answer already in the pipe
    assert.equal(String((await pending).bytes), 'done');
  } finally { await runner.close(); }
});

test('two questions at once are refused, not left hanging', async () => {
  const runner = openOneShot({ rules: [{ name: 'r', on_error: 'forward', match: { harness: 'any' }, do: [{ replace: 'a', with: 'b' }] }] });
  await runner.run(unit());
  await assert.rejects(Promise.all([runner.run(unit()), runner.run(unit())]));
  await runner.close();
});
