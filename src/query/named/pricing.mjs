// src/query/named/pricing.mjs — `trocar query pricing` (RFC 1.6 §4.1, 附录 C.5).
//
// The unit prices a cost estimate is made with, and where they came from. Price is an external,
// user-editable fact (providers report tokens, never money — src/view/pricing.mjs, D14), so the
// document always says its source: the built-in table, or the file that replaced it.
import path from 'node:path';
import { loadPricing } from '../../view/pricing.mjs';

export const about = Object.freeze({
  summary: 'The price table cost estimates are made with, and where it came from.',
  params: Object.freeze({}),
});
export const params = Object.freeze(Object.keys(about.params));
const UNIT = '$/Mtok';

/** The one file the prices come from: `TROCAR_PRICING`, else ~/.trocar/pricing.json (the built-in table when it is
 *  absent). `run` and the stamp both ask this, so they cannot disagree about which file the answer depends on. */
export const pricingFile = ({ home, env = process.env }) => env.TROCAR_PRICING || path.join(home, 'pricing.json');

export async function run({ home, env }) {
  const { pricing, source } = loadPricing(pricingFile({ home, env: env ?? process.env }));
  return {
    models: Object.entries(pricing).map(([model, [input, output, cache_write, cache_read]]) =>
      ({ model, input, output, cache_read, cache_write, unit: UNIT })),
    source,
  };
}
