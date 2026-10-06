import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPricing, DEFAULT_PRICING } from '../../src/view/pricing.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

test('loadPricing: defaults when no config file', () => {
  const { pricing, source } = loadPricing(path.join(os.tmpdir(), 'asight-no-such-pricing.json'));
  assert.deepEqual(pricing, DEFAULT_PRICING);
  assert.equal(source, 'default');
});

test('loadPricing: valid rows override defaults, malformed rows ignored (defaults win)', () => {
  const p = path.join(tmpDir('asight-price-'), 'pricing.json');
  fs.writeFileSync(p, JSON.stringify({ opus: [20, 100, 25, 2], sonnet: 'bogus', gpt: [1, 2, 3, 4] }));
  const { pricing, source } = loadPricing(p);
  assert.deepEqual(pricing.opus, [20, 100, 25, 2], 'valid row overrides');
  assert.deepEqual(pricing.sonnet, DEFAULT_PRICING.sonnet, 'malformed row → default kept (typo cannot zero a cost)');
  assert.deepEqual(pricing.gpt, [1, 2, 3, 4], 'new model row accepted');
  assert.equal(source, p);
});

test('loadPricing: malformed JSON file → defaults, no throw', () => {
  const p = path.join(tmpDir('asight-price-'), 'bad.json');
  fs.writeFileSync(p, '{ not json');
  const { pricing } = loadPricing(p);
  assert.deepEqual(pricing, DEFAULT_PRICING);
});
