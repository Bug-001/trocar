import { test } from 'node:test';
import assert from 'node:assert/strict';

test('toolchain: node:test runs and assertions work', () => {
  assert.equal(1 + 1, 2);
});

test('esm: dynamic import of a core module works', async () => {
  const os = await import('node:os');
  assert.equal(typeof os.platform(), 'string');
});
