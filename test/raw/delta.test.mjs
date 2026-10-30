import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../../src/raw/delta.mjs';

// The v1 delta decoder (4.2 §封存格式, version 1 read-only): damaged ops MUST throw, never yield bytes.
test('applyOps refuses a COPY that reaches past the predecessor', () => {
  const ops = Buffer.from([0xc8, 0x01, 0x00]);               // COPY(len 100, offset 0): head 200, offset 0
  assert.ok(applyOps(Buffer.from('x'.repeat(100)), ops).equals(Buffer.from('x'.repeat(100))));
  assert.throws(() => applyOps(Buffer.from('x'.repeat(10)), ops), /out of range|corrupt/i);
});
