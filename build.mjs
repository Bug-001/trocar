#!/usr/bin/env node
// asight · Phase-3 frontend bundler (esbuild, D18a = vanilla JS + esbuild). Bundles
// src/web/app.mjs (which imports render.mjs) → src/web/dist/app.js, and copies the static
// index.html + style.css alongside it. The server (4.4) static-serves src/web/dist/.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'src', 'web');
const DIST = path.join(WEB, 'dist');

export const buildOptions = {
  entryPoints: [path.join(WEB, 'app.mjs')],
  outfile: path.join(DIST, 'app.js'),
  bundle: true, format: 'esm', target: 'es2022', sourcemap: true, minify: false,
};

export async function build() {
  if (!existsSync(buildOptions.entryPoints[0])) {
    console.log('[asight build] no frontend entry (%s) — nothing to bundle.', buildOptions.entryPoints[0]);
    return { skipped: true };
  }
  mkdirSync(DIST, { recursive: true });
  const esbuild = await import('esbuild');
  await esbuild.build(buildOptions);
  for (const f of ['index.html', 'style.css']) copyFileSync(path.join(WEB, f), path.join(DIST, f));
  console.log('[asight build] → %s (app.js + index.html + style.css)', DIST);
  return { skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build().catch((e) => { console.error(e); process.exit(1); });
}
