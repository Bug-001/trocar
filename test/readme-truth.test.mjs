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
// the README is the product page; what it leaves to docs/ is held to the same bar (4.5 #5)
const PAGES = ['README.md', 'docs/install.md', 'docs/board.md', 'docs/capture.md', 'docs/commands.md', 'docs/license.md'];
const pages = PAGES.map((p) => ({ p, text: readFileSync(path.join(ROOT, p), 'utf8') }));
const all = pages.map((x) => x.text).join('\n');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// what bin/trocar.mjs dispatches: the table of commands and the first word of each hidden alias (src/cli/commands.mjs, RFC 1.6 §2)
const implementedVerbs = new Set(COMMANDS.map((c) => c.name));

// Only text the reader would actually TYPE counts as an instruction: fenced code blocks and inline
// `code` spans. Prose like "trocar sits on the wire" is not a command, and the README's own
// prose about a command must not read as an instruction to type it.
const fenced = [...all.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
const inlineCode = [...all.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join('\n');
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

// the command table lives in docs/commands.md, one row per public command of src/cli/commands.mjs (4.5 #5); `trocar help` prints
// the usage lines from the same table, so the page does not copy them
test('docs/commands.md has one row per public command, and no other', () => {
  const page = pages.find((x) => x.p === 'docs/commands.md').text;
  const rows = [...page.matchAll(/^\| `trocar ([a-z-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...rows].sort(), COMMANDS.filter((c) => !c.hidden).map((c) => c.name).sort());
});

test('the README teaches no command that is gone (`collector …`, `etl`, `shard`, `keep`, `verify`), and not `trocar test`', () => {
  const taught = [...commandText.matchAll(/\btrocar[ \t]+([a-z-]+)/g)].map((m) => m[1]);
  // the hidden aliases are gone with 1.6 §2 (one feature, one name): what they named is not a command any more
  for (const a of ['collector', 'etl', 'shard', 'keep', 'verify', 'test']) assert.ok(!taught.includes(a), `the README tells the reader to run \`trocar ${a}\`, which is gone (1.6 §2)`);
});

test('the README no longer says what D39 and the code made false: the steer of `trocar on`, <redacted> credentials, "observe-only: never rewrite", a test count', () => {
  assert.doesNotMatch(all, /`trocar on` writes the steer/, '`trocar on` is the collector now');
  assert.doesNotMatch(all, /`trocar (monitor|desktop|capture|mitm) /, 'the old capture\'s commands are retired (D39⑥ executed 2026-10-11): the README must not teach them');
  assert.doesNotMatch(all, /replaced with `<redacted>`/, 'credential headers are stored verbatim (files 0600; trocar doctor checks them)');
  assert.doesNotMatch(all, /never inject or\s+rewrite traffic/, 'D30: a request is changed or re-sent only by the operator, and the one `Connection: close` line is trocar\'s');
  assert.doesNotMatch(all, /\b\d+ passing\b/, 'a hard-coded test count is stale the day after');
  assert.doesNotMatch(all, /`monitor off --remove-ca` deletes it/, '--remove-ca takes the trust entry out; the CA files stay');
  assert.doesNotMatch(all, /trocar mitm\s+# :9899\ntrocar desktop on/, '`desktop on` installs its own MITM on 9898; a hand-started one on 9899 is not what its rule points at');
});

test('every `npm run <script>` the README mentions exists in package.json', () => {
  const used = [...all.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]);
  for (const s of used) {
    assert.ok(pkg.scripts?.[s], `README says "npm run ${s}" but package.json has no such script`);
  }
});

test('every repo file the README links to exists', () => {
  // markdown links + bare image paths, relative only
  for (const { p: page, text } of pages) {
    const refs = [...text.matchAll(/\]\((?!https?:)([^)#]+)\)/g)].map((m) => m[1].trim());
    for (const r of refs) assert.ok(existsSync(path.join(ROOT, path.dirname(page), r)), `${page} links to ${r}, which does not exist`);
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

test('every install-script URL the README shows names a file under install/, on this repo\'s Release or this package (4.5 #5)', () => {
  const urls = [...commandText.matchAll(/https?:\/\/[^\s"'`)]+\/install\.(?:sh|ps1)\b/g)].map((m) => m[0]);
  assert.ok(urls.length > 0, 'sanity: the README shows the install line');
  const home = new URL(pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')).pathname; // /<owner>/<repo>
  for (const u of urls) {
    assert.ok(existsSync(path.join(ROOT, 'install', path.posix.basename(u))), `${u} names no file under install/`);
    assert.ok(u.includes(`${home}/releases/latest/download/`) || u.includes(`/${pkg.name}/install/`), `${u} is neither this repo's Release nor this package`);
  }
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

// a line pasted from a shell block runs as typed: macOS's default zsh, interactive, does not take `#` as a comment, so a
// trailing `# macOS, Linux` becomes arguments (`sh '#' 'macOS,' 'Linux'`). What a line is for is said above its block (4.5 #5)
test('no shell block of the README or the docs pages carries a # comment', () => {
  const found = [];
  for (const { p, text } of pages) {
    for (const m of text.matchAll(/```(sh|shell|bash|console|zsh)\n([\s\S]*?)```/g)) {
      for (const line of m[2].split('\n')) if (/(^|\s)#/.test(line)) found.push(`${p}: ${line.trim()}`);
    }
  }
  assert.deepEqual(found, []);
});
