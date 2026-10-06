// 1.2:70: one chip row per harness id, plus the legacy aliases; a UA-inferred harness says so (D37 ①).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES } from '../../src/dissect/harnesses.mjs';

const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'index.html'), 'utf8');
const line = (prefix) => HTML.split('\n').find((l) => l.startsWith(prefix));
const chipFor = new Function(`${line('const CHIP=')}\n${line('const chipFor=')}\nreturn chipFor`)();

test('every harness id and both legacy aliases have a chip; unknown stays unlabelled', () => {
  for (const id of [...HARNESSES.map((h) => h.id), 'claude-code', 'deepseek-cli']) {
    assert.doesNotMatch(chipFor({ harness: id }), /unidentified|⬜/, id);
  }
  assert.match(chipFor({ harness: null }), /unidentified agent/);
  assert.match(chipFor({ harness: 'cc' }), /Claude Code/);
  assert.equal(chipFor({ harness: 'claude-code' }), chipFor({ harness: 'cc' }), 'the alias renders the same chip');
});

test('a UA-inferred harness says so on the chip (D37 ①: 「推断自 UA」)', () => {
  assert.match(chipFor({ harness: 'cc', harness_inferred: true }), /推断自 UA/);
  assert.doesNotMatch(chipFor({ harness: 'cc', harness_inferred: false }), /推断/);
});

test('a synthesized session says it is grouped by guess (3.4 confidence low)', () => {
  assert.match(chipFor({ harness: 'hermes', session_synthesized: true }), /按推测归组/);
  assert.doesNotMatch(chipFor({ harness: 'hermes', session_synthesized: false }), /推测/);
});
