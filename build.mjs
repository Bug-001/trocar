#!/usr/bin/env node
// asight · Phase-3 frontend bundler placeholder (esbuild).
// The frontend (src/frontend/) does not exist yet; this file freezes the build
// contract so the Phase-3 unit only fills in the entry. Running it today is a no-op.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Phase-3 frontend unit consumes this object as-is (only adds real assets).
export const buildOptions = {
  entryPoints: [path.join(__dirname, 'src/frontend/main.mjs')],
  outfile: path.join(__dirname, 'public/bundle.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: false,
};

export async function build() {
  if (!existsSync(buildOptions.entryPoints[0])) {
    console.log('[asight build] no frontend entry yet (%s) — nothing to bundle (Phase 3).',
      buildOptions.entryPoints[0]);
    return { skipped: true };
  }
  const esbuild = await import('esbuild');
  await esbuild.build(buildOptions);
  return { skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build().catch((e) => { console.error(e); process.exit(1); });
}
