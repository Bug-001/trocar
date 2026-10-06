// 0.1 §2: src/dissect is a leaf. Board, ETL, sharder and the D35 sealer all import it; if it imported
// any of them back, the read side would grow a cycle and the sealer would drag the board in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'dissect');
const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

test('src/dissect imports only ./ siblings and node: built-ins', () => {
  const files = fs.readdirSync(DIR).filter((n) => n.endsWith('.mjs'));
  assert.ok(files.includes('harnesses.mjs'), 'the harness table lives in src/dissect');
  for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const m of src.matchAll(SPEC)) {
      const spec = m[1] || m[2];
      assert.ok(spec.startsWith('./') || spec.startsWith('node:'), `${f} imports ${spec}`);
    }
  }
});
