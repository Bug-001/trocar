import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, build } from '../build.mjs';

test('buildOptions is a valid esbuild config shape', () => {
  assert.equal(buildOptions.bundle, true);
  assert.equal(buildOptions.format, 'esm');
  assert.ok(Array.isArray(buildOptions.entryPoints));
  assert.match(buildOptions.entryPoints[0], /src\/frontend\/main\.mjs$/);
});

test('build() no-ops when the frontend entry does not exist yet', async () => {
  const res = await build();
  assert.equal(res.skipped, true);
});
