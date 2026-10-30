import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../src/cli/commands.mjs';

// The stated bar for this README is that it must not TRAP a user: every command it tells someone to
// run has to exist, and every file it points at has to be there. That is not a style question — the
// audit found the README promising `npx trocar` (a package name that was never this one),
// documenting 5 of 11 CLI verbs, and drifting between `trocar on` and `trocar monitor on`. A reader
// who types what they are told and gets "command not found" has been trapped by the docs.
//
// These assertions are mechanical on purpose: they hold whoever edits the README to reality.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// what bin/trocar.mjs dispatches: the table of commands and the first word of each hidden alias (src/cli/commands.mjs, RFC 1.6 §2)
const implementedVerbs = new Set(COMMANDS.map((c) => c.name));

// Only text the reader would actually TYPE counts as an instruction: fenced code blocks and inline
// `code` spans. Prose like "trocar sits on the wire" is not a command, and the README's own
// prose about a command must not read as an instruction to type it.
const fenced = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
const inlineCode = [...readme.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join('\n');
const commandText = fenced + '\n' + inlineCode;

test('every `trocar <verb>` the README tells you to run actually exists', () => {
  // `[ \t]+`, not `\s+`: the spans are newline-joined, and `\s` would match across the join —
  // "…01-trocar" + "\n" + "spec/…" would read as the command `trocar spec`.
  const documented = new Set([...commandText.matchAll(/\btrocar[ \t]+([a-z-]+)/g)].map((m) => m[1]));
  const missing = [...documented].filter((v) => !implementedVerbs.has(v));
  assert.deepEqual(missing, [],
    `README documents commands that do not exist: ${missing.join(', ')}. `
    + `the table of src/cli/commands.mjs has: ${[...implementedVerbs].sort().join(', ')}`);
});

test('the README\'s Commands section lists every command of the table, in code the reader can copy (1.6 §8, R10)', () => {
  const section = readme.slice(readme.indexOf('\n## Commands'), readme.indexOf('Design authority:'));
  assert.ok(section.length > 100, 'sanity: found the Commands section');
  const listed = new Set([...section.matchAll(/\btrocar[ \t]+([a-z-]+)/g)].map((m) => m[1]));
  assert.deepEqual(COMMANDS.map((c) => c.name).filter((n) => !listed.has(n)), [], 'a command of the table the README does not list');
});

test('the README teaches no command that is gone (`collector …`, `etl`, `shard`, `keep`, `verify`), and not `trocar test`', () => {
  const taught = [...commandText.matchAll(/\btrocar[ \t]+([a-z-]+)/g)].map((m) => m[1]);
  // the hidden aliases are gone with 1.6 §2 (one feature, one name): what they named is not a command any more
  for (const a of ['collector', 'etl', 'shard', 'keep', 'verify', 'test']) assert.ok(!taught.includes(a), `the README tells the reader to run \`trocar ${a}\`, which is gone (1.6 §2)`);
});

test('the README no longer says what D39 and the code made false: the steer of `trocar on`, <redacted> credentials, "observe-only: never rewrite", a test count', () => {
  assert.doesNotMatch(readme, /`trocar on` writes the steer/, '`trocar on` is the collector now');
  assert.doesNotMatch(readme, /`trocar (monitor|desktop|capture|mitm) /, 'the old capture\'s commands are retired (D39⑥ executed 2026-10-11): the README must not teach them');
  assert.doesNotMatch(readme, /replaced with `<redacted>`/, 'credential headers are stored verbatim (files 0600; trocar doctor checks them)');
  assert.doesNotMatch(readme, /never inject or\s+rewrite traffic/, 'D30: a request is changed or re-sent only by the operator, and the one `Connection: close` line is trocar\'s');
  assert.doesNotMatch(readme, /\b\d+ passing\b/, 'a hard-coded test count is stale the day after');
  assert.doesNotMatch(readme, /`monitor off --remove-ca` deletes it/, '--remove-ca takes the trust entry out; the CA files stay');
  assert.doesNotMatch(readme, /trocar mitm\s+# :9899\ntrocar desktop on/, '`desktop on` installs its own MITM on 9898; a hand-started one on 9899 is not what its rule points at');
});

test('every `npm run <script>` the README mentions exists in package.json', () => {
  const used = [...readme.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]);
  for (const s of used) {
    assert.ok(pkg.scripts?.[s], `README says "npm run ${s}" but package.json has no such script`);
  }
});

test('every repo file the README links to exists', () => {
  // markdown links + bare image paths, relative only
  const refs = [...readme.matchAll(/\]\((?!https?:)([^)#]+)\)/g)].map((m) => m[1].trim());
  for (const r of refs) {
    const p = path.join(ROOT, r.replace(/^\.\//, ''));
    assert.ok(existsSync(p), `README links to ${r}, which does not exist`);
  }
});

test('every package the README tells you to install with npm or npx is this package (4.5)', () => {
  // the first non-flag token after `npx`, or after `npm i` / `npm install` with -g / --global; a path or the Release's
  // .tgz is not a package name. A version or dist-tag suffix is stripped, a scope's leading '@' kept.
  const named = [];
  for (const line of fenced.split('\n')) {
    for (const m of line.matchAll(/\bnpx((?:[ \t]+\S+)+)/g)) named.push(m[1].trim().split(/\s+/).find((t) => !t.startsWith('-')));
    for (const m of line.matchAll(/\bnpm[ \t]+(?:i|install)((?:[ \t]+[^\s#&|;]+)*)/g)) {
      const args = m[1].trim().split(/\s+/).filter(Boolean);
      if (args.includes('-g') || args.includes('--global')) named.push(args.find((t) => !t.startsWith('-')));
    }
  }
  const names = named.filter((t) => t && !t.includes('/') && !t.startsWith('.') && !t.endsWith('.tgz'))
    .map((t) => t.replace(/(.)@.*$/, '$1'));
  assert.ok(names.length > 0, 'sanity: the README tells the reader to install or run trocar with npm or npx');
  assert.deepEqual(names.filter((n) => n !== pkg.name), [], `a package the README installs or runs that is not ${pkg.name}`);
});

// the two facts the README states that a reader acts on are the harnesses and the command lines. Both are read from
// their one home (the descriptors, the table of src/cli/commands.mjs) so neither is a second copy that can drift.
test('the README names every harness the collector has a descriptor for, by its id (D37)', async () => {
  const { loadHarnesses } = await import('../src/collector/harness/index.mjs');
  const ids = (await loadHarnesses()).map((d) => d.name);
  assert.ok(ids.length > 0, 'sanity: the loader found descriptors');
  const missing = ids.filter((id) => !readme.includes('`' + id + '`'));
  assert.deepEqual(missing, [], 'a harness the collector has that the README does not name as `<id>`');
});

test('the README\'s Commands block is the usage lines of src/cli/commands.mjs, flags included, one for one', () => {
  const section = readme.slice(readme.indexOf('\n## Commands'), readme.indexOf('Design authority:'));
  const block = /```sh\n([\s\S]*?)```/.exec(section);
  assert.ok(block, 'sanity: the Commands section holds a ```sh block');
  const shown = block[1].split('\n').map((l) => l.replace(/\s+#\s.*$/, '').trim()).filter((l) => l && !l.startsWith('#'));
  const table = COMMANDS.flatMap((c) => [c.usage, ...(c.also || []).map((a) => a.usage)]).flatMap((u) => u.split('\n'));
  assert.deepEqual([...shown].sort(), [...table].sort(), 'each usage line of the table, exactly once, and nothing else');
});
