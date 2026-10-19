import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../../src/cli/commands.mjs';

// R14 — the product is `asight`, but the served UI still called itself `atrace`
// (browser tab title + the empty state), and the empty state instructed the user to run a command
// that does not exist. A first-time user who captures nothing lands exactly there, so the one screen
// most likely to be someone's first impression named the wrong product and gave a dead instruction.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'web', 'index.html'), 'utf8');

const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
// the default empty-state copy: inline in renderEmpty(…), or (D38, where the empty state can also say that
// capture fails) the NO_SESSIONS constant it falls back to
const emptyMsg = (html.match(/renderEmpty\('(No sessions[^']*)'\)/) || html.match(/const NO_SESSIONS='(No sessions[^']*)'/) || [])[1] || '';

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
  const implemented = new Set(COMMANDS.map((c) => c.name)); // what bin/asight.mjs dispatches (src/cli/commands.mjs)
  for (const v of verbs) {
    assert.ok(implemented.has(v),
      `empty state suggests "asight ${v}" but bin/asight.mjs implements no such subcommand (has: ${[...implemented].join(', ')})`);
  }
});

// The <title> check above missed the most visible instance: the page wordmark was
// `<h1><b>a</b>trace</h1>`, so a plain source grep for "atrace" found nothing while every user saw
// it in the top-left corner. Assert on RENDERED TEXT (tags stripped), not on source strings.
const visibleText = html
  .replace(/<script[\s\S]*?<\/script>/g, '')   // ignore JS identifiers/localStorage keys
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, '');                     // strip tags so split words rejoin

test('the old product name is not visible anywhere in the rendered page', () => {
  const hit = /atrace/i.exec(visibleText);
  assert.equal(hit, null,
    hit ? `visible chrome still reads "atrace" near: ${JSON.stringify(visibleText.slice(Math.max(0, hit.index - 40), hit.index + 40))}` : '');
});

test('the wordmark reads asight', () => {
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
  assert.match(h1.replace(/<[^>]+>/g, ''), /^asight$/i, `wordmark renders as "${h1.replace(/<[^>]+>/g, '')}"`);
});
