import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOptions, build } from '../build.mjs';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'dist');

test('buildOptions targets the vanilla frontend entry (D18a = vanilla JS + esbuild)', () => {
  assert.equal(buildOptions.bundle, true);
  assert.equal(buildOptions.format, 'esm');
  assert.ok(Array.isArray(buildOptions.entryPoints));
  assert.match(buildOptions.entryPoints[0], /src\/web\/app\.mjs$/);
});

test('build() bundles app.js + copies index.html/style.css into dist', async () => {
  const res = await build();
  assert.equal(res.skipped, false);
  for (const f of ['app.js', 'index.html', 'style.css']) {
    assert.ok(fs.existsSync(path.join(DIST, f)), `${f} emitted to dist`);
  }
  // render.mjs is inlined into the bundle (no bare import survives) → markup class present
  const js = fs.readFileSync(path.join(DIST, 'app.js'), 'utf8');
  assert.ok(js.includes('cblk'), 'bundle inlines render output markup');
});
