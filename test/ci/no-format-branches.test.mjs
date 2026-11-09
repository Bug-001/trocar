// 3.1 / 0.1 §2: the read side looks a wire's board path up by the dissector's `fold` and fields, never by its format name.
// A comparison with the Anthropic format string in src/view or src/query is a provider branch on the read side.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const ROOTS = ['view', 'query'];
// a comparison either way, a `case`, or a table keyed by the name (`{ anthropic: … }`, `'anthropic': …`)
const BRANCH = /[!=]==?\s*(['"`])anthropic\1|(['"`])anthropic\2\s*[!=]==?|\bcase\s+(['"`])anthropic\3|[{,]\s*(['"`]?)anthropic\4\s*:/;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : e.name.endsWith('.mjs') ? [p] : [];
});

test('the read side (src/view, src/query) never branches on the Anthropic format name', () => {
  const files = ROOTS.flatMap((r) => walk(path.join(SRC, r))).map((p) => path.relative(SRC, p).split(path.sep).join('/'));
  for (const must of ['view/reduce.mjs', 'view/extract.mjs', 'query/usage.mjs']) assert.ok(files.includes(must), `the walk read src/${must}`);
  const hits = [];
  for (const f of files) {
    fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').forEach((line, i) => { if (BRANCH.test(line)) hits.push(`src/${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});
