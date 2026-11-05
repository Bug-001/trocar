// The byte counter behind tier 1 (spec 5.1 §分派). Every length-proportional pass on the main
// thread spends its length here first; past the limit the unit goes to the rule process. A tick
// is the same counter one level up, as the parent of each unit, and a condition compare charges
// it CONDITION_COST.

export const UNIT_BYTES = 256 * 1024;
export const CONDITION_COST = 64;

// For the rule process, where the same reading runs with nothing to pay.
export const FREE = { spend: () => true };

export function byteBudget(limit = UNIT_BYTES, parent = null) {
  let spent = 0;
  const over = () => spent > limit || (parent !== null && parent.over);
  return {
    // Call before the pass. False means do not do it; once false, always false.
    spend(n) {
      if (over()) return false;
      spent += n;
      parent?.spend(n);
      return !over();
    },
    get spent() { return spent; },
    get over() { return over(); },
  };
}
