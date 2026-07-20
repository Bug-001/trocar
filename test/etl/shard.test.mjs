import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shardStream, sessionIdOfLine } from '../../src/etl/shard.mjs';

// SPLITTING THE MONOLITH IS AN ETL JOB, AND IT MUST NOT TOUCH A SINGLE BYTE.
//
// The user's capture reached 7.58 GB in one file. `asight serve` cannot open it: the loader
// JSON.parses every record into one resident array and dies at an 8 GB heap. D20 forbids the fix
// people reach for first — sharding inside the capture tee — because that couples session identity
// into the capture layer. 4.2:11 puts per-session grouping HERE, in ETL, and 4.4:34 keeps the
// read-only server out of it entirely.
//
// The invariant this file exists to defend is #2: the source NDJSON is the ONE source of truth.
// A sharder that JSON.parses a record and re-serialises it into a shard has silently rewritten the
// source — key order, number formatting and unicode escapes all drift, and the "verbatim" claim in
// every downstream view becomes a lie. So the shards MUST be built by copying RAW LINE BYTES.
//
// The test that actually proves this is the round-trip: every byte of every line in, every byte of
// every line out, same multiset. Anything weaker (counting records, checking a field survived)
// passes for a sharder that reserialises.

const SID_A = '11111111-2222-3333-4444-555555555555';
const SID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Deliberately awkward: a float that JSON.stringify would renormalise (1.50 -> 1.5), a non-ASCII
// character, and keys out of alphabetical order. A reserialising sharder mangles all three.
const line = (sid, tag, extra = '') => (
  '{"ts":"2026-07-20T00:00:00.000Z","endpoint":"/v1/messages","method":"POST"'
  + `,"req_headers":{"host":"api.anthropic.com"${sid ? `,"x-claude-code-session-id":"${sid}"` : ''}}`
  + `,"req_body":"{\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"${tag} 中文 ${extra}\\"}]}"`
  + ',"resp":{"status":200},"zz_late_key":1.50,"is_llm_call":true}'
);

function mkMonolith(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-shard-'));
  const src = path.join(dir, 'claude-capture.ndjson');
  fs.writeFileSync(src, lines.join('\n') + '\n');
  return { dir, src, out: path.join(dir, 'sessions') };
}

test('sessionIdOfLine reads the header without parsing the record', () => {
  assert.equal(sessionIdOfLine(line(SID_A, 'x')), SID_A);
  assert.equal(sessionIdOfLine(line(null, 'x')), null, 'a record with no session header must report null, not a guess');
});

test('a session id appearing OUTSIDE req_headers is NOT mistaken for the header', () => {
  // The scan must be bounded to the req_headers object. `resp.body` is stored as a real nested
  // object for json responses (not as an escaped string), so an echoed request header lands in the
  // line UNESCAPED — byte-for-byte the same shape the header has. A naive indexOf over the whole
  // line matches it and files the record under a session that never made the call, silently
  // corrupting every per-session view built on the shards.
  const l = '{"ts":"2026-07-20T00:00:00.000Z","req_headers":{"host":"api.anthropic.com"}'
    + ',"req_body":"{}"'
    + `,"resp":{"status":400,"kind":"json","body":{"error":{"echo":{"x-claude-code-session-id":"${SID_B}"}}}}}`;
  assert.ok(l.includes(`"x-claude-code-session-id":"${SID_B}"`),
    'precondition: the fixture really does carry the header shape outside req_headers');
  assert.equal(sessionIdOfLine(l), null,
    'the scan escaped req_headers and picked a session id out of the response body');
});

test('every byte of every line survives the split', async () => {
  const lines = [line(SID_A, 'a1'), line(SID_B, 'b1'), line(SID_A, 'a2'), line(null, 'orphan')];
  const { dir, src, out } = mkMonolith(lines);
  try {
    await shardStream({ file: src, outDir: out });

    const got = [];
    for (const sub of fs.readdirSync(out)) {
      const f = path.join(out, sub, 'calls.ndjson');
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) got.push(l);
    }
    assert.deepEqual(got.slice().sort(), lines.slice().sort(),
      'a shard line differs from its source line — the sharder is reserialising, not copying bytes '
      + '(invariant 2: derived layers MUST NOT rewrite the source)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('records are filed under their own session, and orphans are kept', async () => {
  const lines = [line(SID_A, 'a1'), line(SID_B, 'b1'), line(SID_A, 'a2'), line(null, 'orphan')];
  const { dir, src, out } = mkMonolith(lines);
  try {
    const r = await shardStream({ file: src, outDir: out });
    assert.equal(r.records, 4);
    assert.equal(fs.readFileSync(path.join(out, SID_A, 'calls.ndjson'), 'utf8').trim().split('\n').length, 2);
    assert.equal(fs.readFileSync(path.join(out, SID_B, 'calls.ndjson'), 'utf8').trim().split('\n').length, 1);
    assert.ok(fs.existsSync(path.join(out, '_unassigned', 'calls.ndjson')),
      'a record with no session header was DROPPED — deleting source records is an invariant-2 violation, '
      + 'not a tidy-up');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a line larger than the read buffer is not split in half', async () => {
  // Real records reach ~200 KB; the reader works in 1 MB chunks, so a record WILL straddle a chunk
  // boundary. Getting this wrong writes two invalid JSON fragments and loses the record.
  const big = line(SID_A, 'big', 'x'.repeat(3 * 1024 * 1024));
  const { dir, src, out } = mkMonolith([line(SID_B, 'small'), big, line(SID_B, 'after')]);
  try {
    await shardStream({ file: src, outDir: out, chunkSize: 64 * 1024 });
    const a = fs.readFileSync(path.join(out, SID_A, 'calls.ndjson'), 'utf8').trim();
    assert.equal(a, big, 'a record straddling the chunk boundary came out mangled');
    JSON.parse(a);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the shard job resumes from a byte offset instead of redoing the file', async () => {
  const first = [line(SID_A, 'a1'), line(SID_B, 'b1')];
  const { dir, src, out } = mkMonolith(first);
  try {
    const r1 = await shardStream({ file: src, outDir: out });
    assert.equal(r1.offset, fs.statSync(src).size, 'the job must report where it stopped');

    fs.appendFileSync(src, line(SID_A, 'a2') + '\n');
    const r2 = await shardStream({ file: src, outDir: out, fromOffset: r1.offset });
    assert.equal(r2.records, 1, 'resuming re-read records it had already sharded — they are now duplicated');

    const a = fs.readFileSync(path.join(out, SID_A, 'calls.ndjson'), 'utf8').trim().split('\n');
    assert.equal(a.length, 2, 'the resumed run duplicated an already-sharded record');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a trailing partial line is left for the next run, not written as garbage', async () => {
  // The capture appends live. A shard run that reads mid-write must not commit the half record —
  // and must report an offset BEFORE it, so the next run picks the whole line up.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-shard-'));
  const src = path.join(dir, 'cap.ndjson');
  const out = path.join(dir, 'sessions');
  try {
    const whole = line(SID_A, 'complete');
    fs.writeFileSync(src, whole + '\n' + line(SID_A, 'half').slice(0, 80));
    const r = await shardStream({ file: src, outDir: out });
    assert.equal(r.records, 1, 'the half-written record was committed to a shard');
    assert.equal(r.offset, Buffer.byteLength(whole) + 1,
      'the offset must stop before the partial line so the next run reads it whole');
    assert.equal(fs.readFileSync(path.join(out, SID_A, 'calls.ndjson'), 'utf8').trim(), whole);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shards are created 0600, like the source', async () => {
  // The capture stores headers verbatim, including Authorization. That is the deliberate 2026-07-20
  // decision (no redaction, local-only) — which makes file permissions the ONLY thing standing
  // between the corpus and any other account on the machine. A shard that widens them undoes it.
  const { dir, src, out } = mkMonolith([line(SID_A, 'a1')]);
  try {
    await shardStream({ file: src, outDir: out });
    const mode = fs.statSync(path.join(out, SID_A, 'calls.ndjson')).mode & 0o777;
    assert.equal(mode & 0o077, 0, `shard is group/world readable (0${mode.toString(8)})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an ALREADY-WIDE shard file is tightened, not appended to as-is', async () => {
  // Creation mode only applies at creation. A shard left 0644 by an earlier build (or by a restore,
  // or a `cp` that dropped the mode) would otherwise keep collecting verbatim Authorization headers
  // at world-readable permissions forever.
  const { dir, src, out } = mkMonolith([line(SID_A, 'a1')]);
  try {
    const f = path.join(out, SID_A, 'calls.ndjson');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    assert.equal(fs.statSync(f).mode & 0o077, 0o044, 'precondition: the shard really is world readable');

    await shardStream({ file: src, outDir: out });
    assert.equal(fs.statSync(f).mode & 0o077, 0,
      'the sharder appended to a world-readable shard without tightening it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
