import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { markClosed } from '../../src/raw/closed.mjs';
import { osStubs } from '../helpers/os-stubs.mjs'; // on a Mac `doctor`'s status block asks launchd and the keychain (read-only): stubs answer (0.1 §3)
import { conversation, envelope, toLine, writeShard, listFiles } from './helpers.mjs';

// E2 / E8 / E9 through the PRODUCT layout and the CLI only (review F2): a collector shard in
// ~/.asight/collector/, sealed by `asight raw seal <shard>` with its DEFAULT --sessions
// (~/.asight/sessions/<key>/), read back by `asight serve --source ~/.asight/collector` and checked by
// `asight doctor`. No test-only multi-root source: the per-session files must be found because they
// are the continuation of a shard that lived in the served directory (0.2 状态表 「封存文件」).
// helpers.mjs points HOME at a sandbox; every spawned CLI gets that HOME.
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'asight.mjs');
const env = { ...process.env, PATH: osStubs().path, ASIGHT_SOURCE: '', ASIGHT_DB: path.join(os.homedir(), 'no.duckdb') };
const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8', env });
const A = 'aaaaaaaa-1111-4111-8111-11111111111a', B = 'bbbbbbbb-2222-4222-8222-22222222222b';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function board(source, paths) {
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, 'serve', '--source', source, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((res, rej) => { child.stdout.on('data', (d) => { if (/asight serving/.test(d)) res(); }); child.on('exit', (c) => rej(new Error('serve exited ' + c))); });
    const out = {};
    for (const p of paths) out[p] = await (await fetch(`http://127.0.0.1:${port}${p}`)).json();
    return out;
  } finally { child.kill(); }
}
const shape = (snap) => Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, JSON.stringify(v)]));

test('E2 / E8 / E9 in the product layout: serve --source <collector dir> shows the same before and after `asight raw seal`', async () => {
  const cap = path.join(os.homedir(), '.asight', 'collector');
  const a = conversation(A, 3, { idPrefix: 'ra_' }), b = conversation(B, 2, { idPrefix: 'rb_' });
  const tel = envelope({ id: 'tel_1', body: { raw_chars: 9, verbatim: false }, endpoint: '/api/event_logging/batch', llm: false });
  const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), [a[0], b[0], tel, a[1], b[1], a[2]].map((r) => toLine(r)));
  const paths = ['/api/projects', `/api/session?id=${A}`, `/api/session?id=${B}`, '/api/control',
    `/api/block?ref=${encodeURIComponent(`${A}/capture-2026-10-05.ndjson#ra_00002::0-30`)}`,
    `/api/block?ref=${encodeURIComponent(`${B}/capture-2026-10-05.ndjson#rb_00001::5-25`)}`];
  try {
    const before = await board(cap, paths);
    assert.match(JSON.stringify(before['/api/projects']), new RegExp(A));
    const sampled = (out) => (/(\d+) record\(s\) captured/.exec(out) || [])[1];
    const doctorBefore = sampled(cli('doctor', '--source', cap).stdout);
    assert.equal(doctorBefore, '6');
    markClosed(shard);
    const s = cli('raw', 'seal', shard);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(fs.existsSync(shard), false);
    assert.equal(listFiles(path.join(os.homedir(), '.asight', 'sessions')).length, 2, 'per-session files are not where the default --sessions puts them');
    const after = await board(cap, paths);
    assert.deepEqual(shape(after), shape(before), 'the board / resolver differ after sealing in the product layout');
    // E9: doctor over the same source sees the per-session sealed files (and every sealed file under
    // the default sessions dir) and hard-fails on a group-readable one
    const [per] = listFiles(path.join(os.homedir(), '.asight', 'sessions'));
    const okRun = cli('doctor', '--source', cap).stdout;
    assert.match(okRun, /owner-only/);
    assert.equal(sampled(okRun), doctorBefore, 'doctor examined fewer records after the seal (continuations not read)');
    fs.chmodSync(per, 0o644);
    const d = cli('doctor', '--source', cap);
    assert.equal(d.status, 1, d.stdout);
    assert.match(d.stdout, new RegExp(path.basename(per).replace(/\./g, '\\.') + ' 0644'));
    // …and with its default sources, which do not include the collector dir yet: every sealed file
    // under ~/.asight/sessions is checked whichever source it continues
    const dd = cli('doctor');
    assert.equal(dd.status, 1, dd.stdout);
    assert.match(dd.stdout, new RegExp(path.basename(per).replace(/\./g, '\\.') + ' 0644'));
    fs.chmodSync(per, 0o600);
  } finally { fs.rmSync(path.join(os.homedir(), '.asight'), { recursive: true, force: true }); }
});
