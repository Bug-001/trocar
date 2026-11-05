// 12e: a script reaches no signal, thread, child process or native addon (spec 5.1 §隔离). Each row is a way there. A row must throw, and on POSIX it sends a real signal the
// parent counts, so a way that throws after reaching the parent is still red, and so is one that reaches it from a thread and throws nothing here.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCRIPT_BUILTINS } from '../../src/rules/closed.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { openOneShot } from '../../src/rules/launch.mjs';

const WIN = process.platform === 'win32';
const OUTSIDE = tmpDir('trocar-outside-');
const SIGNAL = WIN ? 0 : 'SIGUSR2';
const say = JSON.stringify(SIGNAL);
const THREAD = `require('node:process').kill(require('node:process').ppid, ${say})`;
const HOOK = `data:text/javascript,process.kill(process.ppid, ${encodeURIComponent(say)})`;

const ROWS = {
  'process.kill': `process.kill(process.ppid, ${say})`,
  'process._kill': `process._kill(process.ppid, ${WIN ? 0 : os.constants.signals.SIGUSR2})`,
  'named import of kill': `const { kill } = await import('node:process'); kill(process.ppid, ${say})`,
  'the default export of node:process': `(await import('node:process')).default.kill(process.ppid, ${say})`,
  'the prototype of process': `Object.getPrototypeOf(process).kill(process.ppid, ${say})`,
  'process.binding': "process.binding('process_methods')",
  'a Worker by import': `const { Worker } = await import('node:worker_threads'); new Worker(${JSON.stringify(THREAD)}, { eval: true })`,
  'a Worker by require': `const { createRequire } = await import('node:module'); const { Worker } = createRequire(import.meta.url)('worker_threads'); new Worker(${JSON.stringify(THREAD)}, { eval: true })`,
  'a Worker by getBuiltinModule': `const { Worker } = process.getBuiltinModule('node:worker_threads'); new Worker(${JSON.stringify(THREAD)}, { eval: true })`,
  'child_process': "(await import('node:child_process')).execSync('true')",
  'node:process by getBuiltinModule': `process.getBuiltinModule('node:process').kill(process.ppid, ${say})`,
  'process.dlopen': "process.dlopen({ exports: {} }, new URL('./addon.node', import.meta.url).pathname)",
  'the Function constructor': `new Function('return process.kill')()(process.ppid, ${say})`,
  'a loader hooks thread': `(await import('node:module')).register(${JSON.stringify(HOOK)})`,
  'process._debugProcess': 'process._debugProcess(process.ppid)',
  'renicing the parent': "(await import('node:os')).setPriority(process.ppid, 19)",
  'vm in this context': `(await import('node:vm')).runInThisContext('process.kill')(process.ppid, ${say})`,
  'a cluster worker': "(await import('node:cluster')).default.fork()",
  'a database outside the slot': `const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(${JSON.stringify(path.join(OUTSIDE, 'made.db'))}).close()`,
  'a trace file in the working directory': "(await import('node:trace_events')).createTracing({ categories: ['node'] }).enable()",
  'a handle that was never spawned': `new (await import('node:child_process')).ChildProcess()._handle.kill(${WIN ? 0 : os.constants.signals.SIGUSR2})`,
  'V8 flags that open files': `const v8 = await import('node:v8'); v8.setFlagsFromString('--trace-turbo-cfg-file=${path.join(OUTSIDE, 'made.cfg').replaceAll('\\', '/')}'); v8.setFlagsFromString('--trace-turbo')`,
  'a heap snapshot near the limit': "(await import('node:v8')).default.setHeapSnapshotNearHeapLimit(1)",
  'the compile cache': `(await import('node:module')).enableCompileCache(${JSON.stringify(path.join(OUTSIDE, 'cache'))})`,
  'a crypto engine': "try { (await import('node:crypto')).setEngine('dynamic') } catch (e) { if (e.code === 'ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED') throw e }",
  'an engine by way of TLS': "try { (await import('node:tls')).createSecureContext({ clientCertEngine: 'dynamic' }) } catch (e) { if (e.code === 'ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED') throw e }",
  'a report on an exception': `process.report.directory = ${JSON.stringify(OUTSIDE)}; process.report.reportOnUncaughtException = true; process.report.writeReport()`,
  'an env file outside': `process.loadEnvFile(${JSON.stringify(process.execPath)})`,
  'a CommonJS file, whose module is all of node:module': "await import('./escape.cjs')",
  'the inspector': "(await import('node:inspector')).default.open(0)",
  'a linked binding': "process._linkedBinding('spawn_sync')",
  'process.execve': "if (!process.execve) throw new Error('this Node has none'); process.execve(process.execPath, [process.execPath, '-e', '0'])",
};

const unit = { on: 'request', harness: 'codex', pid: 42, method: 'POST', host: 'api.example.com', path: '/v1/messages', class: 'llm', status: null, event_index: null, sse: false,
  headers: [], req_headers: [], encoding: null, body: Buffer.from('{}') };

let delivered = 0;
const count = () => { delivered++; };
const signals = WIN ? [] : ['SIGUSR1', 'SIGUSR2'];
before(() => { for (const name of signals) process.on(name, count); });
after(() => { for (const name of signals) process.off(name, count); });

async function outcome(code) {
  const dir = tmpDir('trocar-sealed-'), script = path.join(dir, 'script.mjs');
  fs.writeFileSync(path.join(dir, 'escape.cjs'), 'module.exports = module.constructor');
  fs.writeFileSync(script, `export default async () => { try { ${code}\n console.log('reached') } catch (e) { console.log('refused', String(e.message).slice(0, 80)) } await new Promise((r) => setTimeout(r, 150)) }`);
  const runner = openOneShot({ script, rules: [{ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }] }], maxTaskMs: 2000 });
  try { return await runner.run(unit); } finally { await runner.close(); }
}

for (const [name, code] of Object.entries(ROWS)) {
  test(`12e: ${name} is refused and the parent gets no signal`, async () => {
    const before = delivered;
    const answer = await outcome(code);
    assert.equal(delivered, before, 'the parent got a signal');
    assert.match(answer.console ?? '', /^refused/, `the script got through: ${JSON.stringify(answer)}`);
    assert.deepEqual(fs.readdirSync(OUTSIDE), [], 'a file appeared outside the slot');
  });
}

test('12e: a script still runs, and the row above it proves nothing by accident', async () => {
  const answer = await outcome("process.memoryUsage()");
  assert.match(answer.console ?? '', /^reached/);
});

// A walk, not a list of paths: a Node that hangs one of these where a script can see it is caught here.
test('12e: nothing a script can reach is a way out', async () => {
  const answer = await outcome(`
    const BARRED = /^(Worker|ChildProcess|spawn|spawnSync|fork|execFile|execFileSync|execSync|kill|_kill|getBuiltinModule|createRequire|registerHooks|setFlagsFromString|createTracing|DatabaseSync|runInThisContext|_debugProcess|_debugEnd)$/
    const queue = [globalThis, process], seen = new Set(), found = []
    for (const id of ${JSON.stringify(SCRIPT_BUILTINS)}) queue.push((await import('node:' + id)).default ?? {})
    const roots = new Set(queue) // a getter called on anything else can take native code down with a wrong receiver
    while (queue.length) {
      const value = queue.pop()
      if (Object(value) !== value || seen.has(value)) continue
      seen.add(value)
      if (typeof value === 'function' && BARRED.test(value.name)) found.push(value.name)
      queue.push(Object.getPrototypeOf(value))
      for (const key of Reflect.ownKeys(value)) {
        const { value: held, get, set } = Object.getOwnPropertyDescriptor(value, key) ?? {}
        queue.push(held, get, set)
        if (get && roots.has(value)) queue.push(value[key])
      }
    }
    if (found.length) throw new Error(found.join(' '))
  `);
  assert.match(answer.console ?? '', /^reached/, JSON.stringify(answer));
});

// A script shares its realm with the code that reports on it, so what it does to the intrinsics must not make a report false (5.1 §隔离).
for (const patch of ['Array.prototype.push = () => 0', 'Array.prototype.map = () => []', 'Object.assign = (a) => a', 'Map.prototype.get = () => undefined', 'Object.prototype.toJSON = () => ({})', 'Buffer.prototype.equals = () => true', 'Buffer.byteLength = () => 0']) {
  test(`12e: ${patch} fails in the script and changes no report`, async () => {
    const answer = await outcome(patch);
    assert.match(answer.console ?? '', /^refused/, JSON.stringify(answer));
  });
}
