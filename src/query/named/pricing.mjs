// src/query/named/pricing.mjs — `asight query pricing` (RFC 1.6 §4.1, 附录 C.5).
//
// The unit prices a cost estimate is made with, and where they came from. Price is an external,
// user-editable fact (providers report tokens, never money — src/view/pricing.mjs, D14), so the
// document always says its source: the built-in table, or the file that replaced it.
import path from 'node:path';
import { loadPricing } from '../../view/pricing.mjs';

export const params = Object.freeze([]);
const UNIT = '$/Mtok';

export async function run({ home }) {
  const { pricing, source } = loadPricing(process.env.ASIGHT_PRICING || path.join(home, 'pricing.json'));
  return {
    models: Object.entries(pricing).map(([model, [input, output, cache_write, cache_read]]) =>
      ({ model, input, output, cache_read, cache_write, unit: UNIT })),
    source,
  };
}
