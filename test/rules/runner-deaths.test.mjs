// 12e, one-shot half: every way a script can end its process or try to leave it (spec 5.1 §规则进程, §隔离, 验收 12e). A real process per row, a table per axis.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers/tmp.mjs';
import { SKIP_WHY } from '../../src/rules/closed.mjs';
import { memoryCap, openOneShot, runnerArgs } from '../../src/rules/launch.mjs';
import { DEATHS, encodeFrame, readProgress } from '../../src/rules/slot.mjs';

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
// `body` runs inside the script once the file `die` exists; `top` at the top of the module. `$MARK` is a file only a process the script started could write.
const sh = (mark) => (WIN ? `cmd /c echo x> ${mark}` : `echo x > ${mark}`);
const ROWS = [
  { name: 'an endless loop', why: 'timeout', body: 'for (;;);', maxTaskMs: 300 },
  { name: 'a task that never settles', why: 'timeout', body: 'await new Promise(() => {})', maxTaskMs: 300 },
  { name: 'an exception', why: 'rule-error', body: 'throw new Error("boom")' },
  { name: 'an exception that forges its why', why: 'rule-error', body: 'throw { why: "made-up" }' },
  { name: 'an unhandled rejection', why: 'crashed', body: 'Promise.reject(new Error("boom")); await new Promise((r) => setTimeout(r, 1000))' },
  { name: 'process.exit()', why: 'crashed', body: 'process.exit()' },
  { name: 'process.exit(78)', why: 'crashed', body: 'process.exit(78)' },
  { name: 'process.abort()', why: 'crashed', body: 'process.abort()' },
  { name: 'a SIGSEGV to itself', why: 'crashed', body: 'process.kill(process.pid, "SIGSEGV"); await new Promise((r) => setTimeout(r, 1000))', posix: 'Windows has no SIGSEGV to send' },
  { name: 'a SIGSTOP to itself, watchdog and all', why: 'timeout', body: 'process.kill(process.pid, "SIGSTOP"); await new Promise((r) => setTimeout(r, 1000))', maxTaskMs: 300, posix: 'Windows has no SIGSTOP' },
  { name: 'abort in a top-level setTimeout', why: 'crashed', top: 'const tick = () => (armed() ? process.abort() : setTimeout(tick, 10)); setTimeout(tick, 10)', body: 'await new Promise((r) => setTimeout(r, 1500))' },
  { name: 'a throw in a setInterval', why: 'crashed', top: 'setInterval(() => { if (armed()) throw new Error("boom") }, 10)', body: 'await new Promise((r) => setTimeout(r, 1500))' },
  { name: 'spawn', why: 'rule-error', body: 'cp.spawn(process.execPath, ["-e", WRITE_MARK], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 200))' },
  { name: 'execSync', why: 'rule-error', body: 'cp.execSync(SHELL_MARK)' },
  { name: 'fork', why: 'rule-error', body: 'cp.fork(fileURLToPath(import.meta.url), { stdio: "ignore" })' },
  { name: 'process.binding', why: 'rule-error', body: 'process.binding("spawn_sync").spawn({ file: process.execPath, args: [process.execPath, "-e", WRITE_MARK], stdio: [] })' },
  { name: 'process.dlopen', why: 'rule-error', body: 'try { process.dlopen({ exports: {} }, fileURLToPath(new URL("./addon.node", import.meta.url))) } catch (e) { if (e.code === "ERR_DLOPEN_FAILED") return "the loader was reached"; throw e }' },
  { name: 'a CRLF in a header', why: 'rule-error', body: 'return { headers: { "x-a": "1\\r\\nx-b: 2" } }' },
  { name: 'a header over the growth limit', why: 'rule-error', body: 'return { headers: { "x-a": "v".repeat(16384) } }' },
  { name: 'a header trocar owns', why: 'rule-error', body: 'return { headers: { "Content-Length": "1" } }' },
  { name: 'a body past 64 MiB', why: 'too-big', body: 'return "x".repeat(65 * 1024 * 1024)' },
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
    'a why outside the closed set': '{ why: "made-up" }',
    'a skip outside the closed set': '{ skipped: [{ rule: "x", why: "made-up" }] }',
    'a death of its own': '{ died: "made-up" }',
  }).map(([what, fields]) => ({ name: `a frame with its task's id and ${what}`, why: 'bad-result', body: `say({ id: taskId(), ...${fields} }); ${HOLD}` })),
];

function moduleOf({ top = '', body }, dir) {
  const mark = path.join(dir, 'started');
  return `
    import cp from 'node:child_process'
    import fs from 'node:fs'
    import { fileURLToPath } from 'node:url'
    const WRITE_MARK = ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(mark)}, 'x')`)}
    const SHELL_MARK = ${JSON.stringify(sh(mark))}
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
        const answer = await runner.run(unit());
        assert.equal(whyOf(answer), row.why);
        assert.ok(CLOSED.has(whyOf(answer)));
        if (answer.died) assert.ok(await until(() => isGone(pid), 2000), 'the process is gone');
        assert.ok(!fs.existsSync(path.join(dir, 'started')), 'nothing a script started ran');

        fs.rmSync(path.join(dir, 'die'));
        const next = await runner.run(unit());
        assert.ok(Number(next.bytes) > 0, 'the next unit gets an answer');
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

describe('a load that fails is load-failed, and the next run tries again', { concurrency: 4 }, () => {
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
        assert.equal((await runner.run(unit())).died, 'load-failed');
        fs.writeFileSync(script, 'export default () => "ok"');
        assert.equal(String((await runner.run(unit())).bytes), 'ok');
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
test('the watchdog kills a task at its limit by itself, and the slot says why and who', { timeout: 10000 }, async (t) => {
  const dir = tmpDir('trocar-watchdog-'), script = path.join(dir, 'script.mjs'), slot = path.join(dir, 'slot');
  fs.writeFileSync(script, 'export default () => { for (;;); }');
  fs.writeFileSync(slot, '');
  const child = spawn(process.execPath, runnerArgs({ script, slot, capBytes: memoryCap() }), { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: {} });
  t.after(() => child.kill('SIGKILL'));
  child.stdio[3].on('error', () => {});
  child.stdio[3].write(encodeFrame({ load: { rules: [{ name: 's', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }], max_delay_ms: 200 } }));
  child.stdio[3].once('data', () => child.stdio[3].write(encodeFrame({ id: 7, unit: unit(), body_bytes: null })));
  const signal = await new Promise((resolve) => { child.once('close', (_, killedBy) => resolve(killedBy)); });
  const fd = fs.openSync(slot, 'r');
  t.after(() => fs.closeSync(fd));
  assert.equal(signal, 'SIGKILL');
  assert.deepEqual([readProgress(fd).task, readProgress(fd).rule, readProgress(fd).done, readProgress(fd).death], [7, 0, false, 'timeout']);
});

for (const [name, source] of [
  ['stuck in a loop', 'export default (m) => { if (m.text === "pid") return String(process.pid); for (;;); }'],
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
    const middle = spawn(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => middle.kill('SIGKILL'));
    const pid = await new Promise((resolve) => { middle.stdout.once('data', (d) => resolve(Number(d))); });
    assert.ok(pid > 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!isGone(pid));
    middle.kill('SIGKILL');
    assert.ok(await until(() => isGone(pid), 2000), 'the rule process outlived its parent');
  });
}
