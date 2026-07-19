import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// R14 (audit 2026-07-19) — the product is `asight`, but the served UI still called itself `atrace`
// (browser tab title + the empty state), and the empty state instructed the user to run a command
// that does not exist. A first-time user who captures nothing lands exactly there, so the one screen
// most likely to be someone's first impression named the wrong product and gave a dead instruction.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'web', 'index.html'), 'utf8');
const cli = fs.readFileSync(path.join(ROOT, 'bin', 'asight.mjs'), 'utf8');

const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const emptyMsg = (html.match(/renderEmpty\('(No sessions[^']*)'\)/) || [])[1] || '';

test('the browser tab title names the product', () => {
  assert.match(title, /asight/i, `<title> is "${title}" — the product is asight`);
  assert.doesNotMatch(title, /atrace/i, 'the old name must not ship in the served UI');
});

test('the empty state does not use the old product name', () => {
  assert.ok(emptyMsg, 'sanity: found the empty-state message');
  assert.doesNotMatch(emptyMsg, /atrace/i, `empty state still says atrace: "${emptyMsg}"`);
});

test('every command the empty state tells the user to run actually exists in the CLI', () => {
  // extract `asight <verb>` mentions from the empty-state copy
  const verbs = [...emptyMsg.matchAll(/asight\s+([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(verbs.length, `the empty state must tell the user a REAL next command; got: "${emptyMsg}"`);
  const implemented = new Set([...cli.matchAll(/case '([a-z-]+)'/g)].map((m) => m[1]));
  for (const v of verbs) {
    assert.ok(implemented.has(v),
      `empty state suggests "asight ${v}" but bin/asight.mjs implements no such subcommand (has: ${[...implemented].join(', ')})`);
  }
});
