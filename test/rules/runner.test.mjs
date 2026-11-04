// The rule process through its one-shot client (spec 5.1 §规则进程, §槽文件, 验收 9 57 49 60): real `node --permission` processes, real slot files, no stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers/tmp.mjs';
import { full } from '../../src/rules/actions.mjs';
import { applyRules } from '../../src/rules/apply.mjs';
import { byteBudget } from '../../src/rules/budget.mjs';
import { compileRules } from '../../src/rules/compile.mjs';
import { memoryCap, openOneShot, runnerArgs } from '../../src/rules/launch.mjs';
import { editsSegment, HEAD_BYTES, readProgress, writeProgress } from '../../src/rules/slot.mjs';

const MIB = 1024 * 1024, GIB = 1024 * MIB;
const RUNNER = fileURLToPath(new URL('../../src/rules/runner.mjs', import.meta.url));
const NET_FLAG = process.allowedNodeEnvironmentFlags.has('--allow-net');
const scriptRule = (script, more = {}) => ({ name: 'script', on_error: 'forward', match: { harness: 'any' }, do: [{ script }], ...more });
const unitOf = (body, more = {}) => ({
  on: 'request', harness: 'codex', pid: 42, method: 'POST', host: 'api.example.com', path: '/v1/messages', class: 'llm', status: null, event_index: null,
  headers: [['content-type', 'application/json'], ['authorization', 'Bearer secret']], req_headers: [], encoding: null, body: body === null ? null : Buffer.from(body), ...more,
});

function scriptFile(source, name = 'script.mjs') {
  const file = path.join(tmpDir('trocar-runner-'), name);
  fs.writeFileSync(file, source);
  return file;
}

async function withRunner(source, use, options = {}) {
  const script = scriptFile(source);
  const runner = openOneShot({ script, rules: [scriptRule(script)], ...options });
  try { return await use(runner, script); } finally { await runner.close(); }
}

test('57: the flags a Node knows, and nothing else; no --permission means no process', () => {
  const dir = fs.realpathSync(tmpDir('trocar-args-'));
  const slot = path.join(dir, 'slot'), script = path.join(dir, 'a.mjs'), link = path.join(dir, 'link');
  fs.writeFileSync(slot, '');
  fs.writeFileSync(script, '');
  fs.symlinkSync(dir, link);
  const known = (flags) => new Set(flags);
  const all = ['--permission', '--allow-worker', '--allow-net', '--allow-fs-read', '--allow-fs-write', '--max-old-space-size'];
  const args = (more) => runnerArgs({ slot, capBytes: 512 * MIB, allowed: known(all), ...more });

  assert.equal(args({ allowed: known(all.filter((f) => f !== '--permission')) }), null);
  assert.ok(args({ script }).includes('--allow-net'));
  assert.ok(!args({}).includes('--allow-net'), 'the built-in process does not reach the network');
  assert.ok(!args({ script, allowed: known(all.filter((f) => f !== '--allow-net')) }).includes('--allow-net'));
  assert.ok(args({}).includes('--max-old-space-size=512'));
  assert.ok(args({ script: path.join(link, 'a.mjs'), slot: path.join(link, 'slot') }).every((a) => !a.includes(link)), 'a symlinked path in the allow list stops the process starting');
  assert.deepEqual(args({ script }).slice(-3).slice(1), [slot, script]);
});

test('57: the rule process\'s memory limit is 1 GiB or a sixteenth of the machine', () => {
  assert.equal(memoryCap(64 * GIB), GIB);
  assert.equal(memoryCap(8 * GIB), GIB / 2);
});

test('57: a script reads its own directory, writes nowhere, sees no environment and no channel', () => {
  return withRunner(`
    import fs from 'node:fs'
    export default () => {
      const read = fs.readFileSync(new URL('./neighbour.txt', import.meta.url), 'utf8')
      let write = 'allowed'
      try { fs.writeFileSync(new URL('./written.txt', import.meta.url), 'x') } catch (e) { write = e.code }
      return JSON.stringify({ read, write, env: Object.keys(process.env), send: typeof process.send, channel: typeof process.channel })
    }`, async (runner, script) => {
    fs.writeFileSync(path.join(path.dirname(script), 'neighbour.txt'), 'next door');
    const seen = JSON.parse((await runner.run(unitOf('{}'))).bytes);
    assert.equal(seen.read, 'next door');
    assert.equal(seen.write, 'ERR_ACCESS_DENIED');
    assert.ok(!fs.existsSync(path.join(path.dirname(script), 'written.txt')));
    for (const name of ['PATH', 'HOME', 'TROCAR_TEST_SANDBOX']) assert.ok(!seen.env.includes(name), name);
    assert.equal(seen.send, 'undefined');
    assert.equal(seen.channel, 'undefined');
  });
});

test('57: a script reaches a local HTTP service', async () => {
  const server = http.createServer((_, res) => res.end('from the service'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    await withRunner(`export default async (m) => (await fetch(m.text)).text()`, async (runner) => {
      const answer = await runner.run(unitOf(`http://127.0.0.1:${server.address().port}/`));
      assert.equal(String(answer.bytes), 'from the service');
    });
  } finally { server.close(); server.closeAllConnections(); }
});

test('57: a Node that knows --allow-net keeps the built-in process off the network', { skip: NET_FLAG ? false : `this Node has no --allow-net: its permission model does not govern the network, so the built-in process has nothing to withhold` }, async () => {
  const server = http.createServer((_, res) => res.end('x'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const dir = fs.realpathSync(tmpDir('trocar-net-'));
    const slot = path.join(dir, 'slot');
    fs.writeFileSync(slot, '');
    const flags = runnerArgs({ slot, capBytes: 256 * MIB }).filter((a) => a.startsWith('--'));
    const probe = `fetch('http://127.0.0.1:${server.address().port}/').then(() => process.exit(0), () => process.exit(9))`;
    assert.equal(spawnSync(process.execPath, [...flags, '-e', probe], { stdio: 'ignore' }).status, 9);
  } finally { server.close(); server.closeAllConnections(); }
});

const WIDE = ['--allow-worker', '--allow-fs-read=*'];
for (const [name, flags] of [
  ['no permission model', ['--max-old-space-size=256']],
  ['the right to start processes', ['--permission', '--allow-child-process', '--max-old-space-size=256', ...WIDE]],
  ['the right to write the code directory', ['--permission', '--allow-fs-write=*', '--max-old-space-size=256', ...WIDE]],
  ['no memory limit', ['--permission', ...WIDE]],
]) {
  test(`57: started with ${name}, it exits 78 and loads nothing`, () => {
    const dir = tmpDir('trocar-selfcheck-'), marker = path.join(dir, 'loaded'), slot = path.join(dir, 'slot');
    fs.writeFileSync(slot, '');
    const script = scriptFile(`import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, 'x')\nexport default () => {}`);
    const { status } = spawnSync(process.execPath, [...flags, RUNNER, slot, script], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    assert.equal(status, 78);
    assert.ok(!fs.existsSync(marker));
  });
}

test('49: a CR or LF in a script\'s header never lands, and the rule says why', () => {
  return withRunner(`export default () => ({ body: 'changed', headers: { 'x-ok': 'fine', 'x-evil': 'a\\r\\nset-cookie: 1' } })`, async (runner) => {
    const answer = await runner.run(unitOf('{}'));
    assert.deepEqual(answer.skipped.map(({ why }) => why), ['rule-error']);
    assert.equal(answer.headers, null);
    assert.equal(answer.bytes, null);
  });
});

test('a script answers with text, bytes, nothing, or {body, headers} where null removes a header', async () => {
  const cases = [
    ['\'text\'', (a) => assert.equal(String(a.bytes), 'text')],
    ['new Uint8Array([0xff, 0xfe])', (a) => assert.deepEqual([...a.bytes], [0xff, 0xfe])],
    ['undefined', (a) => { assert.equal(a.bytes, null); assert.equal(a.headers, null); }],
    ['null', (a) => assert.equal(a.bytes, null)],
    ['({ headers: { \'x-new\': \'1\', \'content-type\': null } })', (a) => { assert.equal(a.bytes, null); assert.deepEqual(a.headers, [['authorization', 'Bearer secret'], ['x-new', '1']]); }],
    ['({ body: new Uint8Array([97]) })', (a) => assert.equal(String(a.bytes), 'a')],
    ['({ bdoy: \'typo\' })', (a) => assert.deepEqual(a.skipped.map(({ why }) => why), ['bad-result'])],
    ['7', (a) => assert.deepEqual(a.skipped.map(({ why }) => why), ['bad-result'])],
  ];
  for (const [value, check] of cases) await withRunner(`export default () => ${value}`, async (runner) => check(await runner.run(unitOf('{}'))));
});

test('a script sees the unit, with credential headers blanked', () => {
  return withRunner(`export default (m) => JSON.stringify({ ...m, bytes: m.bytes.toString('hex') })`, async (runner) => {
    const seen = JSON.parse((await runner.run(unitOf('hi'))).bytes);
    assert.deepEqual(seen, {
      on: 'request', harness: 'codex', pid: 42, method: 'POST', host: 'api.example.com', path: '/v1/messages', status: null,
      headers: [['content-type', 'application/json'], ['authorization', '']], bytes: '6869', text: 'hi',
    });
  });
});

test('console output reaches the answer of `rules test`, cut to 16 KiB however it escapes', () => {
  return withRunner(`export default () => { console.log('hello', 1); console.error('\\u0001'.repeat(50000)) }`, async (runner) => {
    const answer = await runner.run(unitOf('{}'));
    assert.equal(answer.why, undefined);
    assert.ok(answer.console.startsWith('hello 1\n'));
    assert.ok(Buffer.byteLength(JSON.stringify(answer.console)) <= 16 * 1024);
  });
});

test('9: the same rules on the same input give the same bytes in the rule process and in this one', async () => {
  const rules = [
    { name: 'lit', on_error: 'forward', match: { harness: 'any' }, do: [{ replace: 'ALPHA', with: 'BETA', literal: true }] },
    { name: 're', on_error: 'forward', match: { harness: 'any', body: { re: 'BE+TA' } }, do: [{ replace: '(B)E(TA)', with: '$1$2' }] },
    { name: 'head', on_error: 'forward', match: { harness: 'any' }, do: [{ header: 'x-seen', set: '1' }] },
    { name: 'json', on_error: 'forward', match: { harness: 'any', method: 'POST' }, do: [{ json: '/drop', remove: true }] },
    { name: 'stop', on_error: 'forward', match: { harness: 'any', path: '/stop' }, do: [{ reply: { status: 429 } }] },
  ];
  const units = [
    unitOf('{"a":"ALPHA","b":"中文ALPHA😀"}'), unitOf('{"a":"ALPHA","drop":1,"c":"x"}'), unitOf('{"a":"plain"}', { path: '/stop' }), unitOf('not json ALPHA'), unitOf(null),
    unitOf('{"a":"ALPHA"}', { on: 'response', status: 200 }), unitOf(''),
  ];
  const { lookup } = compileRules({ rules });
  const runner = openOneShot({ rules });
  try {
    for (const unit of units) {
      const candidates = lookup(unit.on, unit.harness, unit.host);
      let local = await applyRules(unit, candidates, { tier: 1, budget: byteBudget() });
      if (local.escalate) local = await applyRules(unit, local.survivors, { tier: 2, full });
      const remote = await runner.run(unit);
      assert.equal(remote.died, undefined);
      assert.deepEqual(remote.skipped.map(({ rule, why }) => [rule, why]), local.skipped.map(({ rule, why }) => [rule, why]));
      assert.deepEqual(remote.bytes, local.bytes);
      assert.deepEqual(remote.edits, local.edits);
      assert.deepEqual(remote.headers, local.headers);
      assert.deepEqual([remote.verdict, remote.hits, remote.recover?.result_sha256], [local.verdict, local.hits, local.recover?.result_sha256]);
    }
  } finally { await runner.close(); }
});

test('an answer over 64 KiB is rule-error: the parent never parses a large message', async () => {
  const rules = [{ name: 'big', on_error: 'forward', match: { harness: 'any' }, do: [{ reply: { status: 200, body: 'x'.repeat(70 * 1024) } }] }];
  const runner = openOneShot({ rules });
  try { assert.equal((await runner.run(unitOf('{}'))).why, 'rule-error'); } finally { await runner.close(); }
});

test('the slot is 0600 in a directory of its own, empty between tasks, and gone after close', async () => {
  const tmp = tmpDir('trocar-slotdir-');
  const script = scriptFile(`export default () => process.argv[2]`);
  const runner = openOneShot({ script, rules: [scriptRule(script)], tmp });
  const slot = String((await runner.run(unitOf('{}'))).bytes);
  assert.equal(path.dirname(path.dirname(slot)), fs.realpathSync(tmp));
  assert.equal(fs.statSync(slot).size, 0, 'a body stays only as long as its task');
  if (process.platform !== 'win32') assert.equal(fs.statSync(slot).mode & 0o777, 0o600);
  await runner.close();
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('progress: the 24-byte head of a slot reads back what was written, and a written head leaves the death alone', () => {
  const file = path.join(tmpDir('trocar-progress-'), 'slot');
  const fd = fs.openSync(file, 'w+');
  try {
    assert.deepEqual(readProgress(fd), { task: 0, rule: 0, slowest: 0, done: false, death: null });
    writeProgress(fd, { task: 0xFFFFFFF0, rule: 7, slowest: 3, done: true });
    assert.deepEqual(readProgress(fd), { task: 0xFFFFFFF0, rule: 7, slowest: 3, done: true, death: null });
    assert.equal(fs.fstatSync(fd).size <= HEAD_BYTES, true);
  } finally { fs.closeSync(fd); }
});

test('60: an edits segment that does not parse is bad-result before it reaches the slot', () => {
  assert.deepEqual([...editsSegment([])], []);
  assert.deepEqual(JSON.parse(`[${editsSegment([{ at: 1, del: 2, ins: 'x\n' }, { at: 9, del: 0, ins: '"' }])}]`), [{ at: 1, del: 2, ins: 'x\n' }, { at: 9, del: 0, ins: '"' }]);
  assert.throws(() => editsSegment([undefined, undefined]), { why: 'bad-result' });
});
