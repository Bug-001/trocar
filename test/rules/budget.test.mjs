// The byte counter behind tier 1 (spec 5.1 §分派): the unit budget and the tick budget are one ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIT_BYTES, CONDITION_COST, byteBudget } from '../../src/rules/budget.mjs';

test('the default limit is 256 KiB and a condition costs 64 bytes', () => {
  assert.equal(UNIT_BYTES, 256 * 1024);
  assert.equal(CONDITION_COST, 64);
});

test('a pass that lands on the limit fits; the next byte is over, and over stays over', () => {
  const b = byteBudget(100);
  assert.equal(b.spend(60), true);
  assert.equal(b.spend(40), true);
  assert.equal(b.spent, 100);
  assert.equal(b.over, false);
  assert.equal(b.spend(1), false);
  assert.equal(b.over, true);
  for (const n of [0, 1, 1000]) assert.equal(b.spend(n), false);
});

test('one pass longer than the whole budget is refused before any scan', () => {
  const b = byteBudget();
  assert.equal(b.spend(64 * 1024 * 1024), false);
  assert.equal(b.over, true);
});

test('a parent over its limit stops the child, even with no new spend on the child', () => {
  const tick = byteBudget(100);
  const unit = byteBudget(1000, tick);
  assert.equal(unit.spend(100), true);
  assert.equal(tick.spent, 100);
  tick.spend(1);
  assert.equal(unit.over, true);
  assert.equal(unit.spend(0), false);
});

test('a child over its own limit does not put the parent over', () => {
  const tick = byteBudget(1000);
  const unit = byteBudget(10, tick);
  assert.equal(unit.spend(11), false);
  assert.equal(tick.over, false);
  assert.equal(byteBudget(1000, tick).spend(10), true);
});

test('spending on a unit past the tick limit reports over on both', () => {
  const tick = byteBudget(100);
  const unit = byteBudget(1000, tick);
  assert.equal(unit.spend(101), false);
  assert.equal(tick.over, true);
  assert.equal(unit.over, true);
});

test('conditions and bytes share the book', () => {
  const tick = byteBudget();
  for (let i = 0; i < UNIT_BYTES / CONDITION_COST - 1; i++) assert.equal(tick.spend(CONDITION_COST), true);
  assert.equal(tick.spend(CONDITION_COST), true);
  assert.equal(tick.spent, UNIT_BYTES);
  assert.equal(tick.spend(1), false);

  const mixed = byteBudget();
  assert.equal(mixed.spend(UNIT_BYTES - CONDITION_COST), true);
  assert.equal(mixed.spend(CONDITION_COST), true);
  assert.equal(mixed.spend(CONDITION_COST), false);
});
